/**
 * Models for tests, standing where the gateway would hand a Bot its model.
 *
 * Production Bots get a model from the gateway (llm/models.ts). A test exercising what a Bot does with
 * its model, rather than the gateway, points the same AI SDK model at its own double through
 * `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, read when the model is built, so a test can move its
 * double between cases exactly as it did when Bots read those variables themselves.
 */
import { resolveModel } from "@copilotkit/runtime/v2";
import type {
  BotLanguageModel,
  BotModelSource,
  RuntimeModel,
} from "../../src/copilot";
import type { Database } from "../../src/db/client";
import { createModelGateway } from "../../src/llm/gateway";
import { createGatewayModels } from "../../src/llm/models";
import type { LlmRegistry, ResolvedModel } from "../../src/llm/registry";
import { createGatewayTokens } from "../../src/llm/tokens";

/** Every Bot thinks with this model, at whatever address the environment names when it is built. */
export function modelsFromEnvironment(
  model: Pick<RuntimeModel, "provider" | "defaultModel">,
  apiKey = "test-key",
): BotModelSource {
  return async () =>
    resolveModel(
      `${model.provider}/${model.defaultModel}`,
      apiKey,
    ) as BotLanguageModel;
}

/** One model, built now, at the environment's address. */
export function modelFromEnvironment(
  model: Pick<RuntimeModel, "provider" | "defaultModel">,
  apiKey = "test-key",
): BotLanguageModel {
  return resolveModel(
    `${model.provider}/${model.defaultModel}`,
    apiKey,
  ) as BotLanguageModel;
}

/** No model set up, as a deployment that never added one. */
export const noModel: BotModelSource = async () => null;

/**
 * One short completion against the environment's address, as the gateway's `complete` gives the
 * deployment's own decisions: Chat Completions in JSON mode, or Anthropic's Messages.
 */
export function completerFromEnvironment(
  model: Pick<RuntimeModel, "provider" | "defaultModel">,
  apiKey = "test-key",
): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    const anthropic = model.provider === "anthropic";
    const base = (
      anthropic
        ? (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1")
        : (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1")
    ).replace(/\/+$/, "");
    const versioned = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    const response = await fetch(
      `${versioned}/${anthropic ? "messages" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(anthropic
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model: model.defaultModel,
          ...(anthropic
            ? { max_tokens: 1024 }
            : { response_format: { type: "json_object" } }),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`router model answered ${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: unknown }[];
    };
    const content = anthropic
      ? body.content
          ?.filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("") || undefined
      : body.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error("router model returned no text");
    return content;
  };
}

/**
 * A real model gateway and its `complete`, in front of one model at `baseUrl`, for a test that wants
 * the whole path (token, gateway, vendor wire format) without a database: the registry answers for
 * that one model, and usage is not recorded.
 */
export function gatewayInFrontOf(model: {
  baseUrl: string;
  apiKey: string | null;
  name: string;
  upstream?: string;
  protocol?: "openai" | "anthropic";
  providerKind?: string;
}) {
  const resolved: ResolvedModel = {
    modelId: "llmm_test",
    name: model.name,
    upstream: model.upstream ?? model.name,
    providerId: "llmp_test",
    providerKind: model.providerKind ?? "custom",
    protocol: model.protocol ?? "openai",
    baseUrl: model.baseUrl.replace(/\/+$/, ""),
    apiKey: model.apiKey,
    keyId: model.apiKey ? "key" : null,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: ["chat", "decision"],
  };
  const registry = {
    resolve: async (name: string) => (name === model.name ? resolved : null),
    modelForRole: async () => model.name,
    models: async () => [],
  } as unknown as LlmRegistry;
  const tokens = createGatewayTokens({
    encryptionKey: Buffer.alloc(32, 9).toString("base64"),
  });
  const unrecorded = {
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  } as unknown as Database;
  const gateway = createModelGateway({
    database: unrecorded,
    registry,
    tokens,
  });
  return { gateway, ...createGatewayModels({ gateway, registry, tokens }) };
}
