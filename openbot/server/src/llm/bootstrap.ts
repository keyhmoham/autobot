/**
 * A deployment's first models, from what it was already started with.
 *
 * Before the gateway, a deployment ran on one key in its environment (OPENAI_API_KEY or
 * ANTHROPIC_API_KEY, or the tenant package's stored credential) and one model named in its package.
 * On a start that finds no model set up yet, that key becomes the first provider and that model the
 * chat role, so an existing deployment keeps working the moment it upgrades and a new one works the
 * moment it is given a key. After that, Admin → Models is the only place models change: the
 * environment is read once, never again.
 */
import { presetFor } from "@openbot/shared/llm";
import type { LlmRegistry } from "./registry";

export async function seedModelsFromEnvironment(input: {
  registry: LlmRegistry;
  /** The model the tenant package names, and which vendor it is from. */
  packageModel: { provider: "openai" | "anthropic"; defaultModel: string };
  /** The key the deployment would have used before, from the vault or the environment. */
  resolveKey: (provider: "openai" | "anthropic") => Promise<string | null>;
  environment: Record<string, string | undefined>;
}): Promise<{ seeded: string | null }> {
  if (!(await input.registry.empty())) return { seeded: null };
  const provider = input.packageModel.provider;
  const key = await input.resolveKey(provider);
  if (!key) return { seeded: null };
  const custom =
    provider === "openai"
      ? input.environment.OPENAI_BASE_URL?.trim()
      : undefined;
  const created = await input.registry.createProvider({
    kind: custom ? "custom" : provider,
    ...(custom ? { name: "OpenAI-compatible endpoint", baseUrl: custom } : {}),
    apiKey: key,
  });
  const name =
    (provider === "anthropic" || custom
      ? input.environment.BOT_MODEL?.trim()
      : undefined) || input.packageModel.defaultModel;
  const model = await input.registry.createModel({
    providerId: created.id,
    name,
    label: `${presetFor(created.kind)?.name ?? created.name} ${name}`,
    capabilities: ["chat", "decision"],
  });
  await input.registry.setRole("chat", model.id);
  return { seeded: model.name };
}
