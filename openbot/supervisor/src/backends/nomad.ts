import { createHash } from "node:crypto";

import {
  BackendUnavailableError,
  type ComputerBackend,
  type ComputerState,
  DEFAULT_READY_TIMEOUT_MS,
  type EnsureOptions,
  environmentObject,
  NameHeldError,
  pause,
  waitForHealth,
} from "../backend";
import {
  BOT_LABEL,
  type ComputerNames,
  DEFAULT_NAMESPACE,
  NAMESPACE,
  NAMESPACE_LABEL,
  OWNER_LABEL,
} from "../names";

/**
 * Computers as Nomad jobs: the same image Docker runs on one host, scheduled across a cluster.
 *
 * Each computer is a `service` job named as the container would be, with one task on Nomad's docker
 * driver: the computer's port published as a dynamic port, its profile and workspace as named docker
 * volumes on the node it lands on, and the same confinement Docker gives it (no capabilities, no new
 * privileges, a pids limit, an optional runtime such as gVisor). The job's meta says it is this
 * deployment's, the way a container's labels do, and nothing without that meta is touched.
 *
 * Volumes are the node's. Nomad's docker driver needs `volumes { enabled = true }` in the client's
 * plugin configuration, and a computer keeps its files only while it is placed on the same node: pin
 * computers to nodes with storage (COMPUTER_NOMAD_NODE_POOL, COMPUTER_NOMAD_DATACENTERS) rather than
 * letting them roam a cluster whose nodes do not share volumes.
 *
 * Reset is a batch job on the node that last ran the computer, emptying its profile volume and
 * nothing else, because a reset clears the browser and keeps the files, as it does under Docker.
 */

/** The meta key holding a fingerprint of the job as last asked for, so drift is seen and corrected. */
const SPEC_META = "openbot.spec";
const COMPUTER_PORT = 4100;
const PORT_LABEL = "computer";
const NANOS = 1_000_000_000;

export type NomadOptions = {
  address: string;
  token?: string;
  /** Nomad's own namespace, not this deployment's (that is COMPUTER_NAMESPACE, in the job's meta). */
  namespace?: string;
  region?: string;
  datacenters?: string[];
  nodePool?: string;
  /** CPU shares in MHz given to each computer. */
  cpu?: number;
  fetchImpl?: typeof fetch;
};

type NomadJob = {
  ID: string;
  Status?: string;
  Stop?: boolean;
  SubmitTime?: number;
  Meta?: Record<string, string> | null;
};

type NomadAllocation = {
  ID: string;
  NodeID?: string;
  ClientStatus: string;
  CreateIndex: number;
  CreateTime?: number;
  AllocatedResources?: {
    Shared?: {
      Ports?: { Label: string; Value: number; To: number; HostIP: string }[];
    };
  };
};

class NomadStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function ours(meta: Record<string, string> | null | undefined): boolean {
  if (meta?.[OWNER_LABEL] !== "true") return false;
  return (meta[NAMESPACE_LABEL] ?? DEFAULT_NAMESPACE) === NAMESPACE;
}

export function createNomadBackend(options: NomadOptions): ComputerBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.address.replace(/\/$/, "");
  const query = new URLSearchParams({
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.region ? { region: options.region } : {}),
  });

  async function nomad<T>(
    method: string,
    path: string,
    body?: unknown,
    params: Record<string, string> = {},
  ): Promise<T | null> {
    const search = new URLSearchParams(query);
    for (const [key, value] of Object.entries(params)) search.set(key, value);
    let response: Response;
    try {
      response = await fetchImpl(
        `${base}${path}${search.size ? `?${search}` : ""}`,
        {
          method,
          headers: {
            ...(options.token ? { "X-Nomad-Token": options.token } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      throw new BackendUnavailableError("Nomad", String(error));
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new NomadStatusError(
        response.status,
        `Nomad answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ) {
    try {
      return await nomad<T>(method, path, body, params);
    } catch (error) {
      if (error instanceof NomadStatusError)
        throw new BackendUnavailableError("Nomad", error.message);
      throw error;
    }
  }

  const jobPath = (names: ComputerNames) =>
    `/v1/job/${encodeURIComponent(names.container)}`;

  async function jobOf(names: ComputerNames): Promise<NomadJob | null> {
    const job = await call<NomadJob>("GET", jobPath(names));
    if (!job) return null;
    if (!ours(job.Meta))
      throw new NameHeldError(`The Nomad job ${names.container}`);
    return job;
  }

  /** The job this computer should be, and a fingerprint of it. */
  function jobFor(names: ComputerNames, ensure: EnsureOptions) {
    const task = {
      Name: "computer",
      Driver: "docker",
      Config: {
        image: ensure.image,
        ports: [PORT_LABEL],
        // Chromium's sandbox wants shared memory and crashes on the 64MB default.
        shm_size: 1_073_741_824,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        pids_limit: ensure.pidsLimit ?? 512,
        ...(ensure.runtime ? { runtime: ensure.runtime } : {}),
        mount: [
          { type: "volume", source: names.profileVolume, target: "/profiles" },
          {
            type: "volume",
            source: names.workspaceVolume,
            target: "/workspace",
          },
        ],
      },
      Env: environmentObject(ensure.environment),
      Resources: {
        CPU: options.cpu ?? 1000,
        MemoryMB: Math.max(
          256,
          Math.round((ensure.memoryBytes ?? 2 * 1024 ** 3) / 1024 ** 2),
        ),
      },
      // Long enough for Chromium to flush its profile, as under Docker.
      KillTimeout: 30 * NANOS,
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(task))
      .digest("hex")
      .slice(0, 16);
    return {
      fingerprint,
      job: {
        ID: names.container,
        Name: names.container,
        Type: "service",
        ...(options.namespace ? { Namespace: options.namespace } : {}),
        ...(options.region ? { Region: options.region } : {}),
        Datacenters: options.datacenters?.length ? options.datacenters : ["*"],
        ...(options.nodePool ? { NodePool: options.nodePool } : {}),
        Meta: {
          [OWNER_LABEL]: "true",
          [BOT_LABEL]: names.botId,
          [NAMESPACE_LABEL]: NAMESPACE,
          [SPEC_META]: fingerprint,
        },
        TaskGroups: [
          {
            Name: "computer",
            Count: 1,
            Networks: [
              { DynamicPorts: [{ Label: PORT_LABEL, To: COMPUTER_PORT }] },
            ],
            RestartPolicy: {
              Attempts: 10,
              Interval: 1800 * NANOS,
              Delay: 15 * NANOS,
              Mode: "delay",
            },
            Tasks: [task],
          },
        ],
      },
    };
  }

  async function allocations(names: ComputerNames) {
    return (
      (await call<NomadAllocation[]>("GET", `${jobPath(names)}/allocations`)) ??
      []
    ).sort((a, b) => b.CreateIndex - a.CreateIndex);
  }

  /** Where a running allocation's computer answers. */
  async function addressOf(allocationId: string) {
    const detail = await call<NomadAllocation>(
      "GET",
      `/v1/allocation/${allocationId}`,
    );
    const port = detail?.AllocatedResources?.Shared?.Ports?.find(
      (each) => each.Label === PORT_LABEL,
    );
    return port
      ? { url: `http://${port.HostIP}:${port.Value}`, port: port.Value }
      : null;
  }

  async function ensure(
    names: ComputerNames,
    ensureOptions: EnsureOptions,
  ): Promise<ComputerState> {
    const existing = await jobOf(names);
    const wanted = jobFor(names, ensureOptions);
    // A stopped job, or one asked for differently (a new image, a new token), is registered again;
    // registering the same job twice changes nothing, so two ensures at once still make one computer.
    if (
      !existing ||
      existing.Stop ||
      existing.Status === "dead" ||
      existing.Meta?.[SPEC_META] !== wanted.fingerprint
    )
      await call("POST", "/v1/jobs", { Job: wanted.job });

    const timeoutMs = ensureOptions.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const running = (await allocations(names)).find(
        (allocation) => allocation.ClientStatus === "running",
      );
      const address = running ? await addressOf(running.ID) : null;
      if (running && address) {
        await waitForHealth(
          address.url,
          names.container,
          Math.max(deadline - Date.now(), 1_000),
          fetchImpl,
        );
        return {
          botId: names.botId,
          container: names.container,
          status: "running",
          ...(running.CreateTime
            ? { startedAt: new Date(running.CreateTime / 1e6).toISOString() }
            : {}),
          port: address.port,
          url: address.url,
        };
      }
      await pause(500);
    }
    throw new BackendUnavailableError(
      "Nomad",
      `no allocation of ${names.container} was running within ${timeoutMs}ms`,
    );
  }

  async function stop(names: ComputerNames): Promise<boolean> {
    const job = await jobOf(names);
    if (!job) return false;
    await call("DELETE", jobPath(names));
    return true;
  }

  async function reset(names: ComputerNames): Promise<boolean> {
    const job = await jobOf(names);
    if (!job) return false;
    const node = (await allocations(names)).find(
      (allocation) => allocation.NodeID,
    )?.NodeID;
    await call("DELETE", jobPath(names), undefined, { purge: "true" });
    if (!node) return true;
    // Emptied where it lives: a volume is the node's, so the job that clears it runs there.
    const id = `${NAMESPACE}-reset-${names.botId}`;
    await call("POST", "/v1/jobs", {
      Job: {
        ID: id,
        Name: id,
        Type: "batch",
        ...(options.namespace ? { Namespace: options.namespace } : {}),
        Datacenters: options.datacenters?.length ? options.datacenters : ["*"],
        Meta: {
          [OWNER_LABEL]: "true",
          [BOT_LABEL]: names.botId,
          [NAMESPACE_LABEL]: NAMESPACE,
        },
        Constraints: [
          // Nomad's own interpolation, read by Nomad, not a template string.
          // biome-ignore lint/suspicious/noTemplateCurlyInString: see above.
          { LTarget: "${node.unique.id}", RTarget: node, Operand: "=" },
        ],
        TaskGroups: [
          {
            Name: "reset",
            Count: 1,
            RestartPolicy: { Attempts: 0, Mode: "fail" },
            Tasks: [
              {
                Name: "reset",
                Driver: "docker",
                Config: {
                  image: "busybox:1.37",
                  command: "sh",
                  args: ["-c", "find /profiles -mindepth 1 -delete"],
                  mount: [
                    {
                      type: "volume",
                      source: names.profileVolume,
                      target: "/profiles",
                    },
                  ],
                },
                Resources: { CPU: 100, MemoryMB: 64 },
              },
            ],
          },
        ],
      },
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const done =
        (await call<NomadJob>("GET", `/v1/job/${encodeURIComponent(id)}`))
          ?.Status === "dead";
      if (done) break;
      await pause(1_000);
    }
    await call("DELETE", `/v1/job/${encodeURIComponent(id)}`, undefined, {
      purge: "true",
    });
    return true;
  }

  async function listOwned(): Promise<ComputerState[]> {
    const jobs =
      (await call<NomadJob[]>("GET", "/v1/jobs", undefined, {
        prefix: `${NAMESPACE}-computer-`,
        meta: "true",
      })) ?? [];
    return jobs
      .filter((job) => ours(job.Meta))
      .map((job) => ({
        botId: job.Meta?.[BOT_LABEL] ?? "unknown",
        container: job.ID,
        status:
          job.Stop || job.Status === "dead"
            ? "exited"
            : job.Status === "running"
              ? "running"
              : (job.Status ?? "unknown"),
        ...(job.SubmitTime
          ? { startedAt: new Date(job.SubmitTime / 1e6).toISOString() }
          : {}),
      }));
  }

  async function reachable(): Promise<boolean> {
    try {
      return (await nomad("GET", "/v1/status/leader")) !== null;
    } catch {
      return false;
    }
  }

  return { name: "Nomad", reachable, ensure, stop, reset, listOwned };
}
