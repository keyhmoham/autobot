import type { ComputerNames } from "./names";

/**
 * What runs the computers: the supervisor's four verbs, whatever is underneath them.
 *
 * Docker on one host (backends/docker.ts), a Nomad cluster scheduling the same image across many
 * (backends/nomad.ts), or Modal's sandboxes in the cloud (backends/modal.ts). Each is chosen by
 * COMPUTER_BACKEND and each answers in the same terms: a computer per id, reached at a URL, holding a
 * profile and a workspace that outlive it. The vocabulary is the boundary, as index.ts says, so a new
 * backend adds a way to run a computer and never a new thing the API server can ask for.
 */

export type ComputerState = {
  botId: string;
  /** What the backend calls it: a container, a Nomad job, a Modal sandbox. */
  container: string;
  status: string;
  /** When this computer started, so a surface can say how long it has been up. */
  startedAt?: string;
  /** Its published port, when it has one. */
  port?: number;
  /** Where to reach it, however it is arranged. */
  url?: string;
};

export type EnsureOptions = {
  image: string;
  /** `KEY=value` lines: what the computer is told (its id, its token, its egress). */
  environment: string[];
  /** Docker: a network to join, when the supervisor runs alongside a compose stack. */
  network?: string;
  /**
   * Docker and Nomad: the container runtime. Left unset this is the default, which shares the host
   * kernel. `runsc` runs each computer under gVisor, which intercepts syscalls in user space and is
   * the pragmatic middle ground for untrusted Bot code.
   */
  runtime?: string;
  memoryBytes?: number;
  /**
   * How long a started computer is given to answer before the attempt is called a failure: a
   * deployment pulling a large image on a cold host is not the same as a test that wants an answer
   * in seconds.
   */
  readyTimeoutMs?: number;
  pidsLimit?: number;
  /** Docker: the volume holding the SPIRE agent's Workload API socket, mounted read-only. */
  spireSocketVolume?: string;
};

export interface ComputerBackend {
  /** Said in health and in errors, so an operator knows where to look. */
  readonly name: string;
  reachable(): Promise<boolean>;
  /** Make sure the computer runs and answers, and say where. Idempotent: two at once make one. */
  ensure(names: ComputerNames, options: EnsureOptions): Promise<ComputerState>;
  /** Stop it, keeping its profile and workspace. False when there was nothing to stop. */
  stop(names: ComputerNames): Promise<boolean>;
  /** Throw it away with its browser profile, keeping the workspace. False when there was nothing. */
  reset(names: ComputerNames): Promise<boolean>;
  /** Every computer this supervisor owns, and only those. */
  listOwned(): Promise<ComputerState[]>;
}

/**
 * The name this computer would have is held by something this supervisor does not own. Not an
 * outage: somebody has to look at what holds the name and decide whether it should be there.
 */
export class NameHeldError extends Error {
  constructor(container: string) {
    super(
      `${container} already exists and does not belong to this deployment. Remove it or rename it; it will not be adopted.`,
    );
    this.name = "NameHeldError";
  }
}

/** The computer started and never answered: the computer's problem, not the backend's. */
export class ComputerNotAnsweringError extends Error {
  constructor(container: string, timeoutMs: number) {
    super(
      `The computer in ${container} started but did not answer within ${timeoutMs}ms. It is not ready, so it is not being handed out.`,
    );
    this.name = "ComputerNotAnsweringError";
  }
}

/** The backend itself could not be reached or refused the request. */
export class BackendUnavailableError extends Error {
  constructor(backend: string, cause: string) {
    super(
      `The supervisor could not reach ${backend} (${cause}). A computer cannot be started without it.`,
    );
    this.name = "BackendUnavailableError";
  }
}

export const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** The token line the computer checks every caller against. */
export const TOKEN_NAME = "COMPUTER_TOKEN";

export function tokenIn(environment: string[] | undefined): string | undefined {
  const entry = environment?.find((line) => line.startsWith(`${TOKEN_NAME}=`));
  return entry?.slice(TOKEN_NAME.length + 1);
}

/** `KEY=value` lines as an object, for the backends whose APIs take one. */
export function environmentObject(lines: string[]): Record<string, string> {
  return Object.fromEntries(
    lines.flatMap((line) => {
      const at = line.indexOf("=");
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
    }),
  );
}

export function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Wait until a computer answers its health check at `url`, for the backends that cannot read the
 * container's own healthcheck. `/health` is open on the computer, so this needs no token.
 */
export async function waitForHealth(
  url: string,
  container: string,
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answered = await fetchImpl(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    if (answered) return;
    await pause(500);
  }
  throw new ComputerNotAnsweringError(container, timeoutMs);
}
