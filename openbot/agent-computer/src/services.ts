import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, relative, resolve } from "node:path";

import { environmentForCommand } from "./shell";

/**
 * Long-running services on the computer: the web apps Bots build in a space's computer.
 *
 * A command (`/exec`) runs, answers and is gone. An app has to keep running after the turn that
 * started it, survive crashing, come back when the container is replaced, and be reachable by the
 * people the app is for. This keeps each named service's process alive, restarts it when it exits,
 * keeps the tail of what it printed, and forwards HTTP to the port it listens on.
 *
 * WHAT DECIDES WHETHER ONE MAY START IS NOT THIS FILE, as for the shell: the server's gateway decides
 * against the deployment's policy and writes the audit row before a start ever reaches here. A
 * service runs with the same allow-listed environment as a command, in the workspace, in its own
 * process group, so stopping it stops what it started.
 *
 * Definitions are kept in the workspace (`.openduet/services.json`), which outlives the container,
 * so `restore` brings every service back after a restart without the server having to ask.
 */

export type ServiceSpec = {
  name: string;
  command: string;
  /** Where it runs, relative to the workspace. */
  cwd: string;
  port: number;
  env?: Record<string, string>;
};

export type ServiceStatus =
  | "starting"
  | "running"
  | "restarting"
  | "crashed"
  | "stopped";

export type ServiceInfo = ServiceSpec & {
  status: ServiceStatus;
  /** Whether something answers on its port right now. */
  listening: boolean;
  pid: number | null;
  restarts: number;
  startedAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
};

export const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MIN_PORT = 1024;
const MAX_PORT = 65_535;
/** Lines of output kept per service, for its logs. */
const LOG_LINES = 2_000;
/** A service exiting this many times within a minute is given up on rather than restarted again. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
/** Environment names a service may not set, for the reasons shell.ts gives for refusing them. */
const NEVER_SET = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_XTRACEFD",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
]);

export class ServiceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceRequestError";
  }
}

type Running = {
  spec: ServiceSpec;
  child: ChildProcess | null;
  status: ServiceStatus;
  restarts: number;
  exits: number[];
  startedAt: Date | null;
  lastExit: ServiceInfo["lastExit"];
  log: string[];
  partial: string;
  stopping: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/** A spec as sent, checked: a name, a command, a directory inside the workspace, a usable port. */
export function checkSpec(input: unknown, workspaceDir: string): ServiceSpec {
  const body = (input ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name : "";
  if (!SERVICE_NAME.test(name))
    throw new ServiceRequestError(
      "A service name is lower-case letters, digits and dashes.",
    );
  if (typeof body.command !== "string" || !body.command.trim())
    throw new ServiceRequestError("A service needs a command to run.");
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)
    throw new ServiceRequestError(
      `A service listens on a port from ${MIN_PORT} to ${MAX_PORT}.`,
    );
  const cwd = typeof body.cwd === "string" ? body.cwd : ".";
  const absolute = resolve(workspaceDir, cwd);
  const inside = relative(workspaceDir, absolute);
  if (inside.startsWith("..") || resolve(workspaceDir, inside) !== absolute)
    throw new ServiceRequestError("A service runs inside the workspace.");
  const env: Record<string, string> = {};
  if (body.env && typeof body.env === "object")
    for (const [key, value] of Object.entries(
      body.env as Record<string, unknown>,
    )) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")
        throw new ServiceRequestError(
          `${key} is not a usable environment variable.`,
        );
      if (NEVER_SET.has(key))
        throw new ServiceRequestError(`${key} cannot be set for a service.`);
      env[key] = value;
    }
  return { name, command: body.command, cwd: inside || ".", port, env };
}

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (answer: boolean) => {
      socket.destroy();
      done(answer);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function createServices(
  workspaceDir: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
) {
  const services = new Map<string, Running>();
  const stateFile = join(workspaceDir, ".openduet", "services.json");
  const logFile = (name: string) =>
    join(workspaceDir, ".openduet", "logs", `${name}.log`);

  async function persist() {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify(
        [...services.values()].map((service) => service.spec),
        null,
        2,
      ),
    );
  }

  function remember(service: Running, chunk: string) {
    const text = service.partial + chunk;
    const lines = text.split("\n");
    service.partial = lines.pop() ?? "";
    service.log.push(...lines);
    if (service.log.length > LOG_LINES)
      service.log.splice(0, service.log.length - LOG_LINES);
    void appendFile(logFile(service.spec.name), chunk).catch(() => {});
  }

  function launch(service: Running) {
    const { spec } = service;
    service.status = service.restarts > 0 ? "restarting" : "starting";
    const child = spawn("bash", ["-c", spec.command], {
      cwd: resolve(workspaceDir, spec.cwd),
      env: {
        ...environmentForCommand(sourceEnv, workspaceDir),
        ...spec.env,
        PORT: String(spec.port),
        HOST: "127.0.0.1",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    service.child = child;
    service.startedAt = new Date(now());
    child.stdout
      ?.setEncoding("utf8")
      .on("data", (chunk: string) => remember(service, chunk));
    child.stderr
      ?.setEncoding("utf8")
      .on("data", (chunk: string) => remember(service, chunk));
    child.once("spawn", () => {
      service.status = "running";
    });
    child.once("exit", (code, signal) => {
      service.child = null;
      service.lastExit = { code, signal, at: new Date(now()).toISOString() };
      remember(service, `\n[service exited: ${signal ?? `code ${code}`}]\n`);
      if (service.stopping) {
        service.status = "stopped";
        return;
      }
      // Crashing in a loop is a bug to read about in the logs, not something to keep paying for.
      service.exits = [
        ...service.exits.filter((at) => now() - at < CRASH_WINDOW_MS),
        now(),
      ];
      if (service.exits.length >= CRASH_LIMIT) {
        service.status = "crashed";
        return;
      }
      service.restarts += 1;
      service.status = "restarting";
      const delay = Math.min(
        1_000 * 2 ** (service.exits.length - 1),
        MAX_BACKOFF_MS,
      );
      service.timer = setTimeout(() => {
        service.timer = null;
        if (!service.stopping) launch(service);
      }, delay);
    });
  }

  function halt(service: Running): Promise<void> {
    service.stopping = true;
    if (service.timer) clearTimeout(service.timer);
    service.timer = null;
    const child = service.child;
    if (!child?.pid) {
      service.status = "stopped";
      return Promise.resolve();
    }
    return new Promise((done) => {
      const kill = (signal: NodeJS.Signals) => {
        try {
          // The whole group: a `bun run dev` that started a bundler must not leave it behind.
          process.kill(-(child.pid as number), signal);
        } catch {}
      };
      const force = setTimeout(() => kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(force);
        done();
      });
      kill("SIGTERM");
    });
  }

  /** Start a service, replacing one of the same name. */
  async function start(input: unknown): Promise<ServiceInfo> {
    const spec = checkSpec(input, workspaceDir);
    const clash = [...services.values()].find(
      (service) =>
        service.spec.port === spec.port && service.spec.name !== spec.name,
    );
    if (clash)
      throw new ServiceRequestError(
        `Port ${spec.port} is already ${clash.spec.name}'s.`,
      );
    const existing = services.get(spec.name);
    if (existing) await halt(existing);
    const service: Running = {
      spec,
      child: null,
      status: "starting",
      restarts: 0,
      exits: [],
      startedAt: null,
      lastExit: null,
      log: existing?.log ?? [],
      partial: "",
      stopping: false,
      timer: null,
    };
    services.set(spec.name, service);
    await mkdir(dirname(logFile(spec.name)), { recursive: true });
    launch(service);
    await persist();
    return info(service);
  }

  async function stop(name: string) {
    const service = services.get(name);
    if (!service) return false;
    await halt(service);
    services.delete(name);
    await persist();
    return true;
  }

  async function info(service: Running): Promise<ServiceInfo> {
    return {
      ...service.spec,
      status: service.status,
      listening: service.child ? await listening(service.spec.port) : false,
      pid: service.child?.pid ?? null,
      restarts: service.restarts,
      startedAt: service.startedAt?.toISOString() ?? null,
      lastExit: service.lastExit,
    };
  }

  async function list(): Promise<ServiceInfo[]> {
    return Promise.all([...services.values()].map(info));
  }

  function logs(name: string, lines = 200): string[] | null {
    const service = services.get(name);
    if (!service) return null;
    const all = service.partial
      ? [...service.log, service.partial]
      : service.log;
    return all.slice(-Math.min(Math.max(lines, 1), LOG_LINES));
  }

  /**
   * Forward one HTTP request to a service's port. `path` is everything after the service's own
   * prefix, query included, so the app sees the request as if it were served at its root.
   */
  async function forward(
    name: string,
    path: string,
    request: Request,
  ): Promise<Response> {
    const service = services.get(name);
    if (!service)
      return new Response("That app is not running.", { status: 404 });
    const headers = new Headers(request.headers);
    for (const header of [
      "host",
      "x-openbot-computer-token",
      "x-openbot-bot-id",
      "cookie",
      "authorization",
    ])
      headers.delete(header);
    try {
      const upstream = await fetch(
        `http://127.0.0.1:${service.spec.port}${path.startsWith("/") ? path : `/${path}`}`,
        {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : request.body,
          redirect: "manual",
          // @ts-expect-error Bun streams a request body when told the stream is half-duplex.
          duplex: "half",
        },
      );
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch {
      return new Response(
        service.status === "crashed"
          ? "This app crashed. Its logs say why."
          : "This app is starting. Try again in a moment.",
        { status: 502 },
      );
    }
  }

  /** Bring back every service the workspace remembers. Called once at start-up. */
  async function restore() {
    const saved = JSON.parse(
      await readFile(stateFile, "utf8").catch(() => "[]"),
    ) as unknown[];
    for (const spec of Array.isArray(saved) ? saved : [])
      await start(spec).catch((error) =>
        console.warn(
          JSON.stringify({
            type: "service-not-restored",
            error: String(error),
          }),
        ),
      );
  }

  async function shutdown() {
    await Promise.all([...services.values()].map((service) => halt(service)));
  }

  return { start, stop, list, logs, forward, restore, shutdown };
}

export type Services = ReturnType<typeof createServices>;
