/**
 * Model objects for this process, all pointed at the gateway.
 *
 * A built-in Bot thinks through the AI SDK, which wants a language model. It gets one that speaks to
 * the gateway with a token for this run, through the gateway's in-process `fetch`, so the call is
 * metered and charged exactly like one from a container on the network, with no network in between
 * and no vendor key anywhere near the Bot.
 *
 * `complete` is the same for the deployment's own short calls: tool selection, routing, titles,
 * summaries. It names a role rather than a model, so an administrator choosing a decision model moves
 * every one of those calls onto it at once.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LlmRole } from "@openbot/shared/llm";
import { IN_PROCESS_GATEWAY, type ModelGateway } from "./gateway";
import type { LlmRegistry } from "./registry";
import type { GatewayTokens } from "./tokens";

/** Whose call this is, for the token it is made with. */
export type ModelCaller = {
  payerUserId: string | null;
  agentId: string | null;
  spaceId?: string | null;
};

export class NoModelError extends Error {
  constructor(what: string) {
    super(
      `${what} An administrator adds a provider and its models in Admin → Models, and chooses which one Bots use.`,
    );
    this.name = "NoModelError";
  }
}

export type GatewayModels = ReturnType<typeof createGatewayModels>;

export function createGatewayModels(deps: {
  gateway: Pick<ModelGateway, "fetch">;
  registry: Pick<LlmRegistry, "resolve" | "modelForRole">;
  tokens: GatewayTokens;
}) {
  /**
   * A language model a Bot can run on, named as this deployment registered it, or the chat role's when
   * no name is given. Built per run, because its token names the run's person.
   */
  async function languageModel(caller: ModelCaller, name?: string | null) {
    const chosen = name ?? (await deps.registry.modelForRole("chat"));
    if (!chosen)
      throw new NoModelError("No model is chosen for Bots to think with.");
    const model = await deps.registry.resolve(chosen);
    if (!model)
      throw new NoModelError(`There is no enabled model called ${chosen}.`);
    const apiKey = deps.tokens.issue({
      payerUserId: caller.payerUserId,
      agentId: caller.agentId,
      spaceId: caller.spaceId ?? null,
      purpose: "turn",
    });
    if (model.protocol === "anthropic")
      return createAnthropic({
        baseURL: `${IN_PROCESS_GATEWAY}/api/llm/anthropic/v1`,
        apiKey,
        fetch: deps.gateway.fetch,
      })(model.name);
    const openai = createOpenAI({
      baseURL: `${IN_PROCESS_GATEWAY}/api/llm/openai/v1`,
      apiKey,
      fetch: deps.gateway.fetch,
    });
    // OpenAI's own models run on the Responses API, which the newest of them need for tools; every
    // other vendor that speaks OpenAI's API speaks Chat Completions.
    return model.providerKind === "openai"
      ? openai.responses(model.name)
      : openai.chat(model.name);
  }

  /**
   * One short answer from the model filling `role`, on the deployment's own behalf unless a payer is
   * named. Returns the text, and throws when no model fills the role or the call fails.
   */
  async function complete(input: {
    role: LlmRole;
    prompt: string;
    system?: string;
    maxTokens?: number;
    json?: boolean;
    payerUserId?: string | null;
    signal?: AbortSignal;
  }): Promise<string> {
    const name = await deps.registry.modelForRole(input.role);
    if (!name)
      throw new NoModelError(`No model is chosen for the ${input.role} role.`);
    const model = await deps.registry.resolve(name);
    if (!model)
      throw new NoModelError(`There is no enabled model called ${name}.`);
    const token = deps.tokens.issue({
      payerUserId: input.payerUserId ?? null,
      agentId: null,
      spaceId: null,
      purpose: "decision",
    });
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const anthropic = model.protocol === "anthropic";
    const response = await deps.gateway.fetch(
      `${IN_PROCESS_GATEWAY}/api/llm/${anthropic ? "anthropic/v1/messages" : "openai/v1/chat/completions"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          anthropic
            ? {
                model: name,
                max_tokens: input.maxTokens ?? 1024,
                ...(input.system ? { system: input.system } : {}),
                messages: [{ role: "user", content: input.prompt }],
              }
            : {
                model: name,
                // Reasoning tokens come out of this budget, so a cap sized for the answer alone fails.
                max_completion_tokens: Math.max(input.maxTokens ?? 1024, 512),
                ...(input.json
                  ? { response_format: { type: "json_object" } }
                  : {}),
                messages: [
                  ...(input.system
                    ? [{ role: "system", content: input.system }]
                    : []),
                  { role: "user", content: input.prompt },
                ],
              },
        ),
        signal,
      },
    );
    if (!response.ok) {
      // One line: it lands on work items and in logs, and a vendor may answer with a page of HTML.
      const detail = (await response.text().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      throw new Error(
        `The ${input.role} model answered ${response.status}. ${detail}`.trim(),
      );
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: unknown }[];
    };
    const text = anthropic
      ? body.content
          ?.filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("")
      : body.choices?.[0]?.message?.content;
    if (typeof text !== "string")
      throw new Error(`The ${input.role} model returned no text.`);
    return text;
  }

  return { languageModel, complete };
}

/** The shape every caller of a short completion takes, so none of them holds a model or a key. */
export type Complete = GatewayModels["complete"];
