/**
 * Whether the model Bots think with can be called, asked of the vendor that serves it.
 *
 * A model an administrator chose in Admin → Models can still fail at the first message: its key
 * refused, or the account without access to that model. Asked once at boot and again from the setup
 * checklist, so that failure is said on a screen an administrator reads rather than in front of
 * whoever sent the first message.
 *
 * The vendor's model list is the question: one GET with the provider's key, which every vendor that
 * speaks OpenAI's API and Anthropic's own answers, and which costs nothing. A 401 or 403 is the key; a
 * list without the model is the model; anything else is "could not tell", never a verdict.
 */
import type { LlmRegistry } from "./llm/registry";

export type ModelCheckOutcome =
  | { kind: "available" }
  | { kind: "skipped" }
  | {
      kind: "warning";
      line: {
        type:
          | "model-unavailable"
          | "model-credential-rejected"
          | "model-check-unreadable";
        provider: string;
        model: string;
        status?: number;
        reason?: string;
        fix: string;
      };
    };

/** What one answer from the vendor's model list means for this model. */
export function modelCheckOutcome(input: {
  provider: string;
  model: string;
  status: number;
  listed: readonly string[] | null;
}): ModelCheckOutcome {
  const { provider, model, status, listed } = input;
  if (status === 401 || status === 403)
    return {
      kind: "warning",
      line: {
        type: "model-credential-rejected",
        provider,
        model,
        status,
        fix: `${provider} refused the key stored for it, so every Bot turn on ${model} will fail until it is replaced in Admin → Models.`,
      },
    };
  if (status >= 200 && status < 300 && listed) {
    if (listed.includes(model)) return { kind: "available" };
    return {
      kind: "warning",
      line: {
        type: "model-unavailable",
        provider,
        model,
        status,
        fix: `The ${provider} key cannot call ${model}, so every Bot turn on it will fail. Give the key access to it, or choose another model in Admin → Models.`,
      },
    };
  }
  return {
    kind: "warning",
    line: {
      type: "model-check-unreadable",
      provider,
      model,
      status,
      fix: `${provider} did not say whether ${model} is available (HTTP ${status}). This is often temporary.`,
    },
  };
}

/** Ask once about the model filling the chat role, and log what was found. Never throws. */
export async function checkChosenModel(options: {
  registry: Pick<LlmRegistry, "modelForRole" | "resolve" | "providers">;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  timeoutMs?: number;
}): Promise<ModelCheckOutcome> {
  const log = options.log ?? ((message: string) => console.warn(message));
  const request = options.fetch ?? fetch;
  const name = await options.registry.modelForRole("chat").catch(() => null);
  const model = name
    ? await options.registry.resolve(name).catch(() => null)
    : null;
  if (!model?.apiKey) return { kind: "skipped" };
  const provider =
    (await options.registry.providers()).find(
      (row) => row.id === model.providerId,
    )?.name ?? model.providerKind;
  let outcome: ModelCheckOutcome;
  try {
    const response = await request(`${model.baseUrl}/models`, {
      headers:
        model.protocol === "anthropic"
          ? { "x-api-key": model.apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${model.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    const body = response.ok
      ? ((await response.json().catch(() => null)) as {
          data?: { id?: unknown }[];
        } | null)
      : null;
    const listed = body?.data
      ? body.data.flatMap((entry) =>
          typeof entry.id === "string" ? [entry.id] : [],
        )
      : null;
    outcome = modelCheckOutcome({
      provider,
      model: model.upstream,
      status: response.status,
      listed,
    });
  } catch (error) {
    outcome = {
      kind: "warning",
      line: {
        type: "model-check-unreadable",
        provider,
        model: model.upstream,
        reason: error instanceof Error ? error.message : String(error),
        fix: `Could not ask ${provider} whether ${model.upstream} is available. This is often temporary.`,
      },
    };
  }
  if (outcome.kind === "warning") log(JSON.stringify(outcome.line));
  return outcome;
}
