/**
 * The model gateway's vocabulary, read from both sides: which vendors an administrator can add, how
 * each one is spoken to, what a model can be used for, and the roles the deployment fills with one.
 *
 * Every Bot and every decision the deployment makes calls a model through one gateway
 * (server/src/llm/gateway.ts), on keys an administrator set up once in Admin → Models. A provider is a
 * vendor account (its base URL and key); a model is one of its models with the price this deployment
 * charges for it; a role is which model the deployment uses for a kind of work when nothing more
 * specific was chosen.
 */

/**
 * How a vendor is spoken to. `openai` covers every vendor with an OpenAI-compatible API, which is
 * nearly all of them; `anthropic` is Anthropic's own Messages API.
 */
export const LLM_PROTOCOLS = ["openai", "anthropic"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

export type LlmProviderPreset = {
  kind: string;
  name: string;
  baseUrl: string;
  protocol: LlmProtocol;
};

/** The vendors an administrator can pick from, with where each one answers. */
export const LLM_PROVIDER_PRESETS = [
  {
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
  },
  {
    kind: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic",
  },
  {
    kind: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai",
  },
  {
    kind: "grok",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    protocol: "openai",
  },
  {
    kind: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai",
  },
  {
    kind: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    protocol: "openai",
  },
  {
    kind: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    protocol: "openai",
  },
  {
    kind: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    protocol: "openai",
  },
  {
    kind: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai",
  },
  {
    kind: "vercel",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    protocol: "openai",
  },
  {
    kind: "custom",
    name: "Custom (OpenAI-compatible)",
    baseUrl: "",
    protocol: "openai",
  },
] as const satisfies readonly LlmProviderPreset[];

export type LlmProviderKind = (typeof LLM_PROVIDER_PRESETS)[number]["kind"];
export const LLM_PROVIDER_KINDS = LLM_PROVIDER_PRESETS.map(
  (preset) => preset.kind,
) as LlmProviderKind[];

export function presetFor(kind: string): LlmProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.kind === kind);
}

/** What a model can be used for. A model with none declared is a chat model. */
export const LLM_CAPABILITIES = [
  "chat",
  "decision",
  "embedding",
  "image",
  "transcription",
] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

/**
 * The kinds of work the deployment picks a model for when nothing more specific was chosen.
 *
 * `chat`: what Bots think with. `decision`: the short, frequent calls the deployment makes on its own
 * behalf, choosing a Bot's tools, routing a message, titling a conversation, sorting mail; a small fast
 * model is the right one, and with none chosen the chat model makes them. `embedding`: finding things
 * by meaning.
 */
export const LLM_ROLES = ["chat", "decision", "embedding"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/**
 * Prices are in credits per million tokens. A credit is the wallet's unit: one million credits are one
 * dollar, so a model priced at its vendor's dollars-per-million is its dollar price times a million.
 */
export const CREDITS_PER_DOLLAR = 1_000_000;

/** What a call costs, in whole credits, rounded up so a call is never free by rounding. */
export function costOf(
  usage: { inputTokens: number; outputTokens: number },
  price: { inputPrice: number; outputPrice: number },
): number {
  const exact =
    (usage.inputTokens * price.inputPrice +
      usage.outputTokens * price.outputPrice) /
    1_000_000;
  return Math.ceil(exact);
}

export type LlmProviderWire = {
  id: string;
  kind: LlmProviderKind;
  name: string;
  baseUrl: string;
  protocol: LlmProtocol;
  enabled: boolean;
  /** Whether a key is held, never the key. */
  hasKey: boolean;
  createdAt: string;
};

export type LlmModelWire = {
  id: string;
  providerId: string;
  /** What Bots and the gateway call it by. Unique across the deployment. */
  name: string;
  /** What the vendor calls it. */
  upstream: string;
  label: string;
  capabilities: LlmCapability[];
  inputPrice: number;
  outputPrice: number;
  contextWindow: number | null;
  enabled: boolean;
};

export type LlmRolesWire = Record<LlmRole, string | null>;
