/**
 * The apps of a space: installed from a manifest in the space computer, run as services the computer
 * keeps alive, opened by the space's people through signed links.
 *
 * Installing is decided like any other work on the computer: reading the manifest is a file read,
 * building is a command, starting is a command left running, and each goes through the computer
 * gateway's policy and audit (computer/gateway.ts). Who may install is the space's to say:
 * `space.build_apps` (members, by default) to build and install, `space.manage_apps` to remove one
 * somebody else made. A Bot installs on behalf of the person its turn answers, with their role.
 */
import {
  APP_MANIFEST_FILE,
  APPS_DIRECTORY,
  type AppManifest,
  type AppTemplate,
  type AppWire,
  appSlug,
} from "@openbot/shared/apps";
import type { DeskTarget } from "@openbot/shared/desk";
import { can } from "@openbot/shared/workspace";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { type AuditInitiator, PERSON_INITIATOR } from "../audit";
import { spaceComputer } from "../computer/computer-ref";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { Database } from "../db/client";
import { spaceApps } from "../db/schema/apps";
import { requirePermission, roleIn } from "../workspace/access";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "../workspace/errors";
import type { Workspace } from "../workspace/service";
import type { AppLinks } from "./links";
import { templateFiles } from "./templates";

const MIN_PORT = 20_000;
const PORT_RANGE = 20_000;
/** A build that takes longer is stopped, and the app says so. */
const BUILD_TIMEOUT_MS = 600_000;

const manifestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).optional(),
  icon: z.string().trim().max(8).optional(),
  build: z.string().trim().min(1).max(2_000).optional(),
  start: z
    .string({ error: "The manifest needs a start command." })
    .trim()
    .min(1, "The manifest needs a start command.")
    .max(2_000),
});

const appPath = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !value.startsWith("/") && !value.split("/").includes(".."),
    "Give the app's directory relative to the workspace, like apps/notes.",
  )
  .transform((value) => value.replace(/\/+$/, ""));

/** Who is installing: a person, or a Bot on their behalf. */
export type AppHand =
  | { kind: "person"; userId: string }
  | {
      kind: "agent";
      agentId: string;
      actingFor: string;
      /** What started the turn, recorded on every action it takes on the computer. */
      initiator: AuditInitiator;
    };

type AppRow = typeof spaceApps.$inferSelect;

/** The name the computer knows an app's service by: unique, and stable across reinstalls. */
export const serviceNameOf = (appId: string) =>
  `app-${appId.replace(/^app_/, "").replaceAll("-", "").slice(0, 16)}`;

const toWire = (row: AppRow): AppWire => ({
  id: row.id,
  spaceId: row.spaceId,
  slug: row.slug,
  name: row.name,
  description: row.description,
  icon: row.icon,
  path: row.path,
  status: row.status,
  error: row.error,
  version: row.version,
  createdBy: row.createdByAgentId
    ? { kind: "agent", id: row.createdByAgentId }
    : { kind: "person", id: row.createdByUserId ?? "" },
  installedAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export type Apps = ReturnType<typeof createApps>;

export function createApps(deps: {
  database: Database;
  /** Absent when this deployment runs no computers: apps then cannot be built or run. */
  gateway: ComputerGateway | undefined;
  links: AppLinks;
  workspace: Pick<Workspace, "announce" | "audit">;
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());

  function gateway() {
    if (!deps.gateway)
      throw new WorkspaceRefusedError(
        "This deployment runs no computers, so apps cannot be built or run here.",
      );
    return deps.gateway;
  }

  const personOf = (hand: AppHand) =>
    hand.kind === "person" ? hand.userId : hand.actingFor;
  const actorOf = (hand: AppHand): ActionActor => ({
    id: personOf(hand),
    userId: personOf(hand),
    initiator: hand.kind === "agent" ? hand.initiator : PERSON_INITIATOR,
  });
  /** The space's computer, as the Bot or as the space itself when a person acts directly. */
  const computerFor = (spaceId: string, hand?: AppHand) =>
    spaceComputer(spaceId, hand?.kind === "agent" ? hand.agentId : spaceId);

  async function row(appId: string) {
    const [found] = await database
      .select()
      .from(spaceApps)
      .where(eq(spaceApps.id, appId));
    if (!found) throw new WorkspaceNotFoundError("That app");
    return found;
  }

  /** An app the person can see, or not found. */
  async function visible(userId: string, appId: string) {
    const found = await row(appId);
    const role = await roleIn(database, found.spaceId, userId);
    if (!role) throw new WorkspaceNotFoundError("That app");
    return found;
  }

  async function changed(spaceId: string) {
    await deps.workspace.announce(database, spaceId, "apps");
  }

  async function update(
    appId: string,
    patch: Partial<typeof spaceApps.$inferInsert>,
  ) {
    const [updated] = await database
      .update(spaceApps)
      .set({ ...patch, updatedAt: now() })
      .where(eq(spaceApps.id, appId))
      .returning();
    if (!updated) throw new WorkspaceNotFoundError("That app");
    return updated;
  }

  /** The space's apps, with what the computer says about each one now when it can be asked. */
  async function list(userId: string, spaceId: string): Promise<AppWire[]> {
    await requirePermission(database, spaceId, userId, "space.view");
    const rows = await database
      .select()
      .from(spaceApps)
      .where(eq(spaceApps.spaceId, spaceId))
      .orderBy(asc(spaceApps.name));
    const live = deps.gateway
      ? await deps.gateway.services(computerFor(spaceId)).catch(() => null)
      : null;
    return rows.map((found) => {
      const service = live?.find(
        (each) => each.name === serviceNameOf(found.id),
      );
      if (!live || found.status === "installing" || found.status === "stopped")
        return toWire(found);
      if (!service) return { ...toWire(found), status: "stopped" };
      if (service.status === "crashed")
        return {
          ...toWire(found),
          status: "failed",
          error: "It keeps crashing. Its logs say why.",
        };
      return toWire(found);
    });
  }

  async function get(userId: string, appId: string) {
    return toWire(await visible(userId, appId));
  }

  /** Make a new app's starting files in the space computer. Returns where they are. */
  async function scaffold(
    hand: AppHand,
    spaceId: string,
    input: { name: string; template: AppTemplate; description?: string },
  ) {
    await requirePermission(
      database,
      spaceId,
      personOf(hand),
      "space.build_apps",
    );
    const slug = appSlug(input.name);
    const directory = `${APPS_DIRECTORY}/${slug}`;
    const files = templateFiles(
      input.template,
      input.name,
      input.description ?? "",
      directory,
    );
    for (const file of files)
      await gateway().writeFile(
        computerFor(spaceId, hand),
        actorOf(hand),
        file,
      );
    return { path: directory, files: files.map((file) => file.path) };
  }

  async function freePort() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const port = MIN_PORT + Math.floor(Math.random() * PORT_RANGE);
      const [taken] = await database
        .select({ id: spaceApps.id })
        .from(spaceApps)
        .where(eq(spaceApps.port, port));
      if (!taken) return port;
    }
    throw new Error("No port is free for another app.");
  }

  async function readManifest(spaceId: string, hand: AppHand, path: string) {
    const file = await gateway().readFile(
      computerFor(spaceId, hand),
      actorOf(hand),
      {
        path: `${path}/${APP_MANIFEST_FILE}`,
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      throw new WorkspaceRefusedError(
        `${path}/${APP_MANIFEST_FILE} is not valid JSON.`,
      );
    }
    const checked = manifestSchema.safeParse(parsed);
    if (!checked.success)
      throw new WorkspaceRefusedError(
        `${path}/${APP_MANIFEST_FILE}: ${checked.error.issues[0]?.message ?? "is not a manifest"}.`,
      );
    return checked.data satisfies AppManifest;
  }

  /** Build (when the manifest says how) and start an app's service, recording how it went. */
  async function run(found: AppRow, hand: AppHand): Promise<AppRow> {
    const computer = computerFor(found.spaceId, hand);
    if (found.buildCommand) {
      const built = await gateway().runCommand(computer, actorOf(hand), {
        command: `cd ${JSON.stringify(found.path)} && ${found.buildCommand}`,
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      if (built.exitCode !== 0 || built.timedOut) {
        const tail = `${built.stderr || built.stdout}`
          .trim()
          .split("\n")
          .slice(-15)
          .join("\n");
        return update(found.id, {
          status: "failed",
          error: built.timedOut
            ? "The build took too long and was stopped."
            : `The build failed:\n${tail}`,
        });
      }
    }
    try {
      await gateway().startService(computer, actorOf(hand), {
        name: serviceNameOf(found.id),
        command: found.startCommand,
        cwd: found.path,
        port: found.port,
      });
    } catch (error) {
      return update(found.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return update(found.id, { status: "running", error: null });
  }

  /**
   * Install the app whose manifest is in `path`, or install it again: same app, same port, the next
   * version, built and started afresh.
   */
  async function install(
    hand: AppHand,
    spaceId: string,
    input: { path: string },
  ) {
    await requirePermission(
      database,
      spaceId,
      personOf(hand),
      "space.build_apps",
    );
    const path = appPath.parse(input.path);
    const manifest = await readManifest(spaceId, hand, path);
    const slug = appSlug(manifest.name);
    const [existing] = await database
      .select()
      .from(spaceApps)
      .where(and(eq(spaceApps.spaceId, spaceId), eq(spaceApps.slug, slug)));
    const fields = {
      name: manifest.name,
      description: manifest.description ?? "",
      icon: manifest.icon ?? "🧩",
      path,
      buildCommand: manifest.build ?? null,
      startCommand: manifest.start,
      status: "installing" as const,
      error: null,
    };
    const installing = existing
      ? await update(existing.id, { ...fields, version: existing.version + 1 })
      : (
          await database
            .insert(spaceApps)
            .values({
              id: `app_${crypto.randomUUID()}`,
              spaceId,
              slug,
              port: await freePort(),
              ...fields,
              createdByUserId: personOf(hand),
              createdByAgentId: hand.kind === "agent" ? hand.agentId : null,
            })
            .returning()
        )[0];
    if (!installing) throw new Error("The app was not recorded.");
    await changed(spaceId);
    const result = await run(installing, hand);
    await deps.workspace.audit(
      existing ? "app.updated" : "app.installed",
      personOf(hand),
      spaceId,
      {
        app: result.id,
        name: result.name,
        agent: hand.kind === "agent" ? hand.agentId : null,
        status: result.status,
      },
    );
    await changed(spaceId);
    return toWire(result);
  }

  async function manageable(hand: AppHand, appId: string) {
    const found = await row(appId);
    await requirePermission(
      database,
      found.spaceId,
      personOf(hand),
      "space.build_apps",
    );
    return found;
  }

  async function restart(hand: AppHand, appId: string) {
    const found = await manageable(hand, appId);
    const result = await run(
      await update(found.id, { status: "installing", error: null }),
      hand,
    );
    await changed(found.spaceId);
    return toWire(result);
  }

  async function stop(hand: AppHand, appId: string) {
    const found = await manageable(hand, appId);
    await gateway().stopService(
      computerFor(found.spaceId, hand),
      serviceNameOf(found.id),
    );
    const result = await update(found.id, { status: "stopped", error: null });
    await changed(found.spaceId);
    return toWire(result);
  }

  /** Take an app out of the space. Its files stay in the computer, to be installed again. */
  async function remove(hand: AppHand, appId: string) {
    const found = await row(appId);
    const role = await roleIn(database, found.spaceId, personOf(hand));
    if (!role) throw new WorkspaceNotFoundError("That app");
    const own = found.createdByUserId === personOf(hand);
    if (
      !can(role, "space.manage_apps") &&
      !(own && can(role, "space.build_apps"))
    )
      throw new WorkspaceForbiddenError(
        "Your role in this space cannot remove somebody else's app.",
      );
    if (deps.gateway)
      await deps.gateway
        .stopService(computerFor(found.spaceId, hand), serviceNameOf(found.id))
        .catch(() => undefined);
    await database.delete(spaceApps).where(eq(spaceApps.id, found.id));
    await deps.workspace.audit("app.removed", personOf(hand), found.spaceId, {
      app: found.id,
      name: found.name,
    });
    await changed(found.spaceId);
  }

  async function logs(userId: string, appId: string, lines = 200) {
    const found = await visible(userId, appId);
    return gateway()
      .serviceLogs(computerFor(found.spaceId), serviceNameOf(found.id), lines)
      .catch(() => ({ lines: [] as string[] }));
  }

  /** A link the person opens the app through, good for a few hours. */
  async function launch(userId: string, appId: string) {
    const found = await visible(userId, appId);
    return {
      path: `/apps-view/${deps.links.issue(found.id, userId)}/`,
      version: found.version,
    };
  }

  /**
   * Carry one request made through an app's link to the app, as long as the link is good and the
   * person it names can still see the space.
   */
  async function open(
    link: string,
    path: string,
    request: Request,
  ): Promise<Response> {
    const named = deps.links.verify(link);
    if (!named)
      return new Response("This link has expired. Open the app again.", {
        status: 403,
      });
    const [found] = await database
      .select()
      .from(spaceApps)
      .where(eq(spaceApps.id, named.appId));
    if (!found || !(await roleIn(database, found.spaceId, named.userId)))
      return new Response("This app is not available to you.", { status: 404 });
    const headers = new Headers(request.headers);
    for (const header of [
      "cookie",
      "authorization",
      "host",
      "origin",
      "referer",
    ])
      headers.delete(header);
    const answer = await gateway().openService(
      computerFor(found.spaceId),
      serviceNameOf(found.id),
      path,
      {
        method: request.method,
        headers,
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: await request.arrayBuffer() }),
        redirect: "manual",
      },
    );
    const out = new Headers(answer.headers);
    // Whatever the app says about cookies is about an origin it does not have.
    out.delete("set-cookie");
    // Sandboxed even when the link is opened on its own, outside the frame that sandboxes it.
    out.set(
      "content-security-policy",
      "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    );
    out.set("x-content-type-options", "nosniff");
    out.set("referrer-policy", "no-referrer");
    return new Response(answer.body, { status: answer.status, headers: out });
  }

  /** The desk's check for an app window: an app of this space. */
  async function checkDeskTarget(input: {
    target: DeskTarget;
    spaceId: string;
  }) {
    if (input.target.kind !== "app") return;
    const [found] = await database
      .select({ spaceId: spaceApps.spaceId })
      .from(spaceApps)
      .where(eq(spaceApps.id, input.target.appId));
    if (!found || found.spaceId !== input.spaceId)
      throw new WorkspaceRefusedError(
        "That app is not installed in this space. apps_list says which are.",
      );
  }

  /** An app named by id or slug in a space, for tools that let a Bot say either. */
  async function find(spaceId: string, idOrSlug: string) {
    const [found] = await database
      .select()
      .from(spaceApps)
      .where(
        and(
          eq(spaceApps.spaceId, spaceId),
          idOrSlug.startsWith("app_")
            ? eq(spaceApps.id, idOrSlug)
            : eq(spaceApps.slug, idOrSlug),
        ),
      );
    if (!found) throw new WorkspaceNotFoundError("That app");
    return found.id;
  }

  return {
    list,
    get,
    scaffold,
    install,
    restart,
    stop,
    remove,
    logs,
    launch,
    open,
    find,
    checkDeskTarget,
  };
}
