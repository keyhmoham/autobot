import type { ComputerBackend } from "../backend";
import { dockerBackend } from "./docker";
import { createModalBackend } from "./modal";
import { createNomadBackend } from "./nomad";

export const BACKENDS = ["docker", "nomad", "modal"] as const;
export type BackendKind = (typeof BACKENDS)[number];

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((each) => each.trim())
    .filter(Boolean) ?? [];

const positive = (value: string | undefined) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

/**
 * The backend COMPUTER_BACKEND names, configured from the environment, or a reason it cannot be.
 * Docker is the default, because a supervisor beside a compose stack is the common case.
 */
export function backendFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): { ok: true; backend: ComputerBackend } | { ok: false; reason: string } {
  const kind = (env.COMPUTER_BACKEND?.trim() || "docker") as BackendKind;
  switch (kind) {
    case "docker":
      return { ok: true, backend: dockerBackend };
    case "nomad": {
      const address = env.NOMAD_ADDR?.trim();
      if (!address)
        return {
          ok: false,
          reason:
            "COMPUTER_BACKEND=nomad needs NOMAD_ADDR, where the Nomad API answers.",
        };
      return {
        ok: true,
        backend: createNomadBackend({
          address,
          ...(env.NOMAD_TOKEN?.trim() ? { token: env.NOMAD_TOKEN.trim() } : {}),
          ...(env.NOMAD_NAMESPACE?.trim()
            ? { namespace: env.NOMAD_NAMESPACE.trim() }
            : {}),
          ...(env.NOMAD_REGION?.trim()
            ? { region: env.NOMAD_REGION.trim() }
            : {}),
          datacenters: list(env.COMPUTER_NOMAD_DATACENTERS),
          ...(env.COMPUTER_NOMAD_NODE_POOL?.trim()
            ? { nodePool: env.COMPUTER_NOMAD_NODE_POOL.trim() }
            : {}),
          ...(positive(env.COMPUTER_NOMAD_CPU_MHZ)
            ? { cpu: positive(env.COMPUTER_NOMAD_CPU_MHZ) }
            : {}),
        }),
      };
    }
    case "modal": {
      if (!env.MODAL_TOKEN_ID?.trim() || !env.MODAL_TOKEN_SECRET?.trim())
        return {
          ok: false,
          reason:
            "COMPUTER_BACKEND=modal needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
        };
      return {
        ok: true,
        backend: createModalBackend({
          appName: env.COMPUTER_MODAL_APP?.trim() || "openduet-computers",
          ...(env.MODAL_ENVIRONMENT?.trim()
            ? { environment: env.MODAL_ENVIRONMENT.trim() }
            : {}),
          ...(env.COMPUTER_MODAL_REGISTRY_SECRET?.trim()
            ? { registrySecret: env.COMPUTER_MODAL_REGISTRY_SECRET.trim() }
            : {}),
          ...(positive(env.COMPUTER_MODAL_CPU)
            ? { cpu: positive(env.COMPUTER_MODAL_CPU) }
            : {}),
          ...(positive(env.COMPUTER_MODAL_LIFETIME_MS)
            ? { lifetimeMs: positive(env.COMPUTER_MODAL_LIFETIME_MS) }
            : {}),
          ...(positive(env.COMPUTER_MODAL_IDLE_MS)
            ? { idleTimeoutMs: positive(env.COMPUTER_MODAL_IDLE_MS) }
            : {}),
        }),
      };
    }
    default:
      return {
        ok: false,
        reason: `COMPUTER_BACKEND must be one of ${BACKENDS.join(", ")}, not ${JSON.stringify(env.COMPUTER_BACKEND)}.`,
      };
  }
}
