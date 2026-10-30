import { createHash } from "node:crypto";
import {
  AlreadyExistsError,
  type App,
  ModalClient,
  NotFoundError,
  type Sandbox,
} from "modal";

import {
  BackendUnavailableError,
  type ComputerBackend,
  type ComputerState,
  DEFAULT_READY_TIMEOUT_MS,
  type EnsureOptions,
  environmentObject,
  NameHeldError,
  waitForHealth,
} from "../backend";
import { type ComputerNames, NAMESPACE } from "../names";

/**
 * Computers as Modal sandboxes: the same image, run in Modal's cloud instead of on a host here.
 *
 * Each computer is a sandbox named as its container would be, in one Modal app, running the image
 * from a registry Modal can pull (COMPUTER_IMAGE must be a pushed tag, not a local build). Its
 * profile and workspace are Modal volumes named like the Docker volumes, so they outlive any one
 * sandbox. Its port is reached through Modal's TLS tunnel; the computer's own token stays the control
 * over who may drive it, exactly as on a network the supervisor does not own.
 *
 * A sandbox lives for at most COMPUTER_MODAL_LIFETIME_MS (Modal caps it at a day) and is stopped
 * after COMPUTER_MODAL_IDLE_MS without use; the next `ensure` starts a new one on the same volumes,
 * which is what a stopped Docker container coming back is too.
 *
 * Tags are what labels are under Docker: a sandbox without this deployment's is not ours, and is
 * neither listed nor touched.
 */

const COMPUTER_PORT = 4100;
const TAGS = {
  owner: "openbot_supervisor",
  bot: "openbot_bot_id",
  namespace: "openbot_namespace",
  container: "openbot_container",
  spec: "openbot_spec",
} as const;

export type ModalOptions = {
  appName: string;
  /** Modal's environment; the profile's default when unset. */
  environment?: string;
  /** A Modal secret holding the registry credentials, when the image is private. */
  registrySecret?: string;
  /** What the image runs, when Modal is to run something other than the computer's own command. */
  command?: string[];
  workdir?: string;
  cpu?: number;
  lifetimeMs?: number;
  idleTimeoutMs?: number;
  client?: ModalClient;
  fetchImpl?: typeof fetch;
};

function unavailable(error: unknown): never {
  throw new BackendUnavailableError(
    "Modal",
    error instanceof Error ? error.message : String(error),
  );
}

export function createModalBackend(options: ModalOptions): ComputerBackend {
  const client =
    options.client ??
    new ModalClient(
      options.environment ? { environment: options.environment } : {},
    );
  const fetchImpl = options.fetchImpl ?? fetch;
  let app: Promise<App> | undefined;
  const appOf = () => {
    app ??= client.apps
      .fromName(options.appName, {
        createIfMissing: true,
        ...(options.environment ? { environment: options.environment } : {}),
      })
      .catch((error) => {
        app = undefined;
        unavailable(error);
      });
    return app;
  };

  const ours = (tags: Record<string, string>) =>
    tags[TAGS.owner] === "true" && tags[TAGS.namespace] === NAMESPACE;

  /** The running sandbox for this computer, if there is one and it is ours. */
  async function running(names: ComputerNames): Promise<Sandbox | null> {
    let sandbox: Sandbox;
    try {
      sandbox = await client.sandboxes.fromName(
        options.appName,
        names.container,
        {
          ...(options.environment ? { environment: options.environment } : {}),
        },
      );
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      unavailable(error);
    }
    if (!ours(await sandbox.getTags()))
      throw new NameHeldError(`The Modal sandbox ${names.container}`);
    return sandbox;
  }

  function fingerprintOf(ensure: EnsureOptions) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          ensure.image,
          ensure.environment,
          ensure.memoryBytes ?? null,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
  }

  async function create(
    names: ComputerNames,
    ensure: EnsureOptions,
    fingerprint: string,
  ) {
    const [image, profile, workspace] = await Promise.all([
      options.registrySecret
        ? client.secrets
            .fromName(options.registrySecret)
            .then((secret) => client.images.fromRegistry(ensure.image, secret))
        : client.images.fromRegistry(ensure.image),
      client.volumes.fromName(names.profileVolume, { createIfMissing: true }),
      client.volumes.fromName(names.workspaceVolume, { createIfMissing: true }),
    ]);
    try {
      return await client.sandboxes.create(await appOf(), image, {
        name: names.container,
        command: options.command ?? ["bun", "src/index.ts"],
        workdir: options.workdir ?? "/app",
        env: environmentObject(ensure.environment),
        volumes: { "/profiles": profile, "/workspace": workspace },
        encryptedPorts: [COMPUTER_PORT],
        timeoutMs: options.lifetimeMs ?? 24 * 3_600_000,
        ...(options.idleTimeoutMs
          ? { idleTimeoutMs: options.idleTimeoutMs }
          : {}),
        ...(ensure.memoryBytes
          ? { memoryMiB: Math.round(ensure.memoryBytes / 1024 ** 2) }
          : {}),
        cpu: options.cpu ?? 1,
        tags: {
          [TAGS.owner]: "true",
          [TAGS.bot]: names.botId,
          [TAGS.namespace]: NAMESPACE,
          [TAGS.container]: names.container,
          [TAGS.spec]: fingerprint,
        },
      });
    } catch (error) {
      // Two ensures at once: the other one made it, which is the outcome this wanted.
      if (error instanceof AlreadyExistsError) {
        const made = await running(names);
        if (made) return made;
      }
      unavailable(error);
    }
  }

  async function ensure(
    names: ComputerNames,
    ensureOptions: EnsureOptions,
  ): Promise<ComputerState> {
    const fingerprint = fingerprintOf(ensureOptions);
    let sandbox = await running(names);
    // Asked for differently (a new image, a new token): replaced, on the same volumes.
    if (sandbox && (await sandbox.getTags())[TAGS.spec] !== fingerprint) {
      await sandbox.terminate().catch(unavailable);
      sandbox = null;
    }
    sandbox ??= await create(names, ensureOptions, fingerprint);
    const timeoutMs = ensureOptions.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const tunnel = (await sandbox.tunnels(timeoutMs).catch(unavailable))[
      COMPUTER_PORT
    ];
    if (!tunnel)
      unavailable(`the sandbox for ${names.botId} has no tunnel to its port`);
    await waitForHealth(tunnel.url, names.container, timeoutMs, fetchImpl);
    return {
      botId: names.botId,
      container: names.container,
      status: "running",
      url: tunnel.url,
    };
  }

  async function stop(names: ComputerNames): Promise<boolean> {
    const sandbox = await running(names);
    if (!sandbox) return false;
    await sandbox.terminate().catch(unavailable);
    return true;
  }

  async function reset(names: ComputerNames): Promise<boolean> {
    const sandbox = await running(names);
    if (sandbox) await sandbox.terminate().catch(unavailable);
    // The browser goes with its profile; the workspace stays, as under Docker.
    await client.volumes
      .delete(names.profileVolume, { allowMissing: true })
      .catch(unavailable);
    return true;
  }

  async function listOwned(): Promise<ComputerState[]> {
    const states: ComputerState[] = [];
    try {
      for await (const sandbox of client.sandboxes.list({
        appId: (await appOf()).appId,
        tags: { [TAGS.owner]: "true", [TAGS.namespace]: NAMESPACE },
      })) {
        const tags = await sandbox.getTags();
        if (!ours(tags)) continue;
        states.push({
          botId: tags[TAGS.bot] ?? "unknown",
          container: tags[TAGS.container] ?? sandbox.sandboxId,
          status: (await sandbox.poll()) === null ? "running" : "exited",
        });
      }
    } catch (error) {
      if (error instanceof BackendUnavailableError) throw error;
      unavailable(error);
    }
    return states;
  }

  async function reachable(): Promise<boolean> {
    try {
      await appOf();
      return true;
    } catch {
      return false;
    }
  }

  return { name: "Modal", reachable, ensure, stop, reset, listOwned };
}
