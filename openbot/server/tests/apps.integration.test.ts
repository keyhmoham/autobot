import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAppLinks } from "../src/apps/links";
import { createAppViewRoutes } from "../src/apps/routes";
import { createApps, serviceNameOf } from "../src/apps/service";
import { createAppTools } from "../src/apps/tools";
import type {
  ComputerGateway,
  ComputerService,
  ComputerServiceSpec,
} from "../src/computer/gateway";
import { createDatabase } from "../src/db/client";
import { spaceMembers, spaces, users } from "../src/db/schema";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "../src/workspace/errors";
import { createWorkspace } from "../src/workspace/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const workspace = createWorkspace({
  database,
  actorFor: async (id) => ({ id, role: "user" }),
  profiles: createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  ),
});
let clock = Date.now();
const links = createAppLinks({
  encryptionKey: Buffer.alloc(32, 5).toString("base64"),
  now: () => clock,
});
const prefix = `apps-${randomUUID()}`;
const people: string[] = [];

/** A space computer that remembers what it was asked. */
function computer() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const started: ComputerServiceSpec[] = [];
  const stopped: string[] = [];
  const forwarded: { name: string; path: string; init: RequestInit }[] = [];
  let buildFails = false;
  const gateway = {
    async readFile(
      _computer: unknown,
      _actor: unknown,
      input: { path: string },
    ) {
      const text = files.get(input.path);
      if (text === undefined)
        throw new WorkspaceRefusedError(`${input.path} does not exist.`);
      return { path: input.path, text, truncated: false, bytes: text.length };
    },
    async writeFile(
      _computer: unknown,
      _actor: unknown,
      input: { path: string; contents: string },
    ) {
      files.set(input.path, input.contents);
      return { path: input.path, bytes: input.contents.length };
    },
    async runCommand(
      _computer: unknown,
      _actor: unknown,
      input: { command: string },
    ) {
      commands.push(input.command);
      return buildFails
        ? {
            command: input.command,
            exitCode: 1,
            stdout: "",
            stderr: "error: cannot find module react",
            truncated: false,
            timedOut: false,
            elapsedMs: 1,
          }
        : {
            command: input.command,
            exitCode: 0,
            stdout: "built",
            stderr: "",
            truncated: false,
            timedOut: false,
            elapsedMs: 1,
          };
    },
    async startService(
      _computer: unknown,
      _actor: unknown,
      spec: ComputerServiceSpec,
    ) {
      started.push(spec);
      return { ...spec, status: "running" } as ComputerService;
    },
    async stopService(_computer: unknown, name: string) {
      stopped.push(name);
      return { stopped: true };
    },
    async services() {
      return started
        .filter((spec) => !stopped.includes(spec.name))
        .map((spec) => ({ ...spec, status: "running" }) as ComputerService);
    },
    async serviceLogs() {
      return { lines: ["Listening"] };
    },
    async openService(
      _computer: unknown,
      name: string,
      path: string,
      init: RequestInit,
    ) {
      forwarded.push({ name, path, init });
      return new Response("<p>hello</p>", {
        headers: { "content-type": "text/html", "set-cookie": "x=1" },
      });
    },
  };
  return {
    files,
    commands,
    started,
    stopped,
    forwarded,
    failBuilds: () => {
      buildFails = true;
    },
    gateway: gateway as unknown as ComputerGateway,
  };
}

afterEach(async () => {
  const ids = people.splice(0);
  await database.delete(spaces).where(inArray(spaces.createdByUserId, ids));
  await database.delete(users).where(inArray(users.id, ids));
});
afterAll(async () => {
  await database.$client.close();
});

async function person() {
  const id = `${prefix}-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Ana" });
  people.push(id);
  return id;
}

function setup() {
  const machine = computer();
  const apps = createApps({
    database,
    gateway: machine.gateway,
    links,
    workspace,
  });
  const view = createAppViewRoutes(apps);
  const app = new Hono();
  app.route(view.path, view.routes);
  return { machine, apps, app };
}

describe("an app", () => {
  test("is made from a template, installed from its manifest, and opened through its link", async () => {
    const { machine, apps, app } = setup();
    const ana = await person();
    const space = await workspace.create(ana, { name: "Launch" });
    const hand = { kind: "person" as const, userId: ana };

    const made = await apps.scaffold(hand, space.id, {
      name: "Team Notes",
      template: "bun",
    });
    expect(made.path).toBe("apps/team-notes");
    expect(machine.files.get("apps/team-notes/openduet.app.json")).toContain(
      '"start": "bun server.ts"',
    );

    const installed = await apps.install(hand, space.id, {
      path: "apps/team-notes/",
    });
    expect(installed).toMatchObject({
      name: "Team Notes",
      slug: "team-notes",
      status: "running",
      version: 1,
    });
    expect(machine.started[0]).toMatchObject({
      name: serviceNameOf(installed.id),
      command: "bun server.ts",
      cwd: "apps/team-notes",
    });
    // Installing again keeps the app and its port, and counts the version.
    const again = await apps.install(hand, space.id, {
      path: "apps/team-notes",
    });
    expect(again).toMatchObject({ id: installed.id, version: 2 });
    expect(machine.started[1]?.port).toBe(machine.started[0]?.port);

    const { path } = await apps.launch(ana, installed.id);
    const response = await app.request(`${path}items?x=1`, {
      method: "POST",
      headers: { cookie: "session=secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(await response.text()).toBe("<p>hello</p>");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(machine.forwarded[0]).toMatchObject({ path: "/items?x=1" });
    expect(
      new Headers(machine.forwarded[0]?.init.headers).get("cookie"),
    ).toBeNull();
    // The bare link is sent on to its slash, so the app's relative paths resolve under it.
    expect((await app.request(path.slice(0, -1))).status).toBe(308);
  });

  test("that fails to build says why and does not start", async () => {
    const { machine, apps } = setup();
    const ana = await person();
    const space = await workspace.create(ana, { name: "Launch" });
    const hand = { kind: "person" as const, userId: ana };
    await apps.scaffold(hand, space.id, {
      name: "Dash",
      template: "vite-react",
    });
    machine.failBuilds();
    const failed = await apps.install(hand, space.id, { path: "apps/dash" });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("cannot find module react");
    expect(machine.commands[0]).toBe(
      'cd "apps/dash" && bun install && bun run build',
    );
    expect(machine.started).toEqual([]);
    machine.files.set("apps/broken/openduet.app.json", '{"name": "Broken"}');
    await expect(
      apps.install(hand, space.id, { path: "apps/broken" }),
    ).rejects.toThrow("start command");
    await expect(
      apps.install(hand, space.id, { path: "../etc" }),
    ).rejects.toThrow();
  });

  test("is opened only by the space's people, on a link that has not run out", async () => {
    const { apps, app } = setup();
    const ana = await person();
    const bo = await person();
    const space = await workspace.create(ana, { name: "Launch" });
    const hand = { kind: "person" as const, userId: ana };
    await apps.scaffold(hand, space.id, { name: "Board", template: "static" });
    const board = await apps.install(hand, space.id, { path: "apps/board" });
    await expect(apps.launch(bo, board.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    const { path } = await apps.launch(ana, board.id);
    expect(
      (await app.request(path.replace(/\.[^.]+\//, ".forged/"))).status,
    ).toBe(403);
    // Ana leaves the space: her link stops working with her.
    await database
      .delete(spaceMembers)
      .where(inArray(spaceMembers.userId, [ana]));
    expect((await app.request(path)).status).toBe(404);
    clock += 13 * 3_600_000;
    expect((await app.request(path)).status).toBe(403);
    clock = Date.now();
  });

  test("goes on a desk only in its own space, and is removed by its maker or a manager", async () => {
    const { machine, apps } = setup();
    const ana = await person();
    const bo = await person();
    const space = await workspace.create(ana, { name: "Launch" });
    const other = await workspace.create(ana, { name: "Other" });
    await database
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: bo, role: "member" });
    await apps.scaffold({ kind: "person", userId: ana }, space.id, {
      name: "Board",
      template: "static",
    });
    const board = await apps.install(
      { kind: "person", userId: ana },
      space.id,
      { path: "apps/board" },
    );
    await expect(
      apps.checkDeskTarget({
        target: { kind: "app", appId: board.id },
        spaceId: other.id,
      }),
    ).rejects.toThrow("not installed in this space");
    await apps.checkDeskTarget({
      target: { kind: "app", appId: board.id },
      spaceId: space.id,
    });
    await expect(
      apps.remove({ kind: "person", userId: bo }, board.id),
    ).rejects.toBeInstanceOf(WorkspaceForbiddenError);
    await apps.remove({ kind: "person", userId: ana }, board.id);
    expect(machine.stopped).toEqual([serviceNameOf(board.id)]);
    expect(await apps.list(ana, space.id)).toEqual([]);
  });

  test("is built by a Bot through its tools, named by slug", async () => {
    const { machine, apps } = setup();
    const ana = await person();
    const space = await workspace.create(ana, { name: "Launch" });
    const tools = createAppTools(
      apps,
      {
        spaceId: space.id,
        roomId: "r",
        channelId: "c",
        agentId: "scout",
        actingFor: ana,
      },
      { kind: "person" },
    );
    const run = (name: string, args: unknown) =>
      tools
        .find((tool) => tool.definition.name === name)
        ?.execute(args, {
          toolCallId: "t",
          signal: new AbortController().signal,
        });
    await run("apps_create", { name: "Poll", template: "static" });
    const { app: poll } = (await run("apps_install", {
      path: "apps/poll",
    })) as { app: { id: string; createdBy: unknown } };
    expect(poll.createdBy).toEqual({ kind: "agent", id: "scout" });
    expect(await run("apps_stop", { app: "poll" })).toMatchObject({
      app: { status: "stopped" },
    });
    expect((await run("apps_list", {})) as { apps: unknown[] }).toMatchObject({
      apps: [{ slug: "poll", status: "stopped" }],
    });
    expect(await run("apps_logs", { app: "nope" })).toEqual({
      error: "That app was not found.",
    });
    expect(machine.started).toHaveLength(1);
  });
});
