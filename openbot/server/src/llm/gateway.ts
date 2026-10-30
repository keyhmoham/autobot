/**
 * The model gateway: every model call this deployment makes goes through here.
 *
 * Two surfaces, each a vendor's own wire format so nothing is translated and nothing is lost:
 * `/api/llm/openai/v1/*` (Chat Completions, Responses, Embeddings, Models) for every vendor that speaks
 * OpenAI's API, and `/api/llm/anthropic/v1/messages` for Anthropic's. A caller names a model as this
 * deployment registered it; the gateway finds its vendor, swaps in the vendor's own name for it and
 * the administrator's key, carries the call, and reads what it used from the answer, streamed or not.
 *
 * Every call is recorded (`llm_usage`) with whose wallet pays for it, and charged through `charge`
 * once the answer has said how much it used. A caller whose wallet cannot pay is refused before the
 * vendor is asked (`admit`), so a call is never made that nobody can pay for.
 */
import type { LlmProtocol } from "@openbot/shared/llm";
import { costOf } from "@openbot/shared/llm";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { llmUsage } from "../db/schema/llm";
import type { LlmRegistry, ResolvedModel } from "./registry";
import type { GatewayCaller, GatewayTokens } from "./tokens";

export type GatewayUsage = {
  usageId: string;
  caller: GatewayCaller;
  model: ResolvedModel;
  inputTokens: number;
  outputTokens: number;
  cost: number;
};

export type GatewayHooks = {
  /** Whether this caller may make this call now; a refusal is said to the caller in its words. */
  admit?: (
    caller: GatewayCaller,
    model: ResolvedModel,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Charge what a finished call cost. Failures are logged, never put in front of the caller. */
  charge?: (usage: GatewayUsage) => Promise<void>;
};

type Surface = {
  protocol: LlmProtocol;
  /** The path under the vendor's base URL. */
  path: string;
  /** Read what a whole JSON answer used. */
  usageOf: (body: Record<string, unknown>) => Tokens;
};

type Tokens = { inputTokens: number; outputTokens: number };

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function openAiUsage(body: Record<string, unknown>): Tokens {
  const usage = record(body.usage ?? record(body.response).usage);
  return {
    inputTokens: number(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: number(usage.completion_tokens ?? usage.output_tokens),
  };
}

function anthropicUsage(body: Record<string, unknown>): Tokens {
  const usage = record(body.usage ?? record(body.message).usage);
  return {
    inputTokens:
      number(usage.input_tokens) +
      number(usage.cache_creation_input_tokens) +
      number(usage.cache_read_input_tokens),
    outputTokens: number(usage.output_tokens),
  };
}

const SURFACES: Record<string, Surface> = {
  "openai/chat": {
    protocol: "openai",
    path: "/chat/completions",
    usageOf: openAiUsage,
  },
  "openai/responses": {
    protocol: "openai",
    path: "/responses",
    usageOf: openAiUsage,
  },
  "openai/embeddings": {
    protocol: "openai",
    path: "/embeddings",
    usageOf: openAiUsage,
  },
  "anthropic/messages": {
    protocol: "anthropic",
    path: "/messages",
    usageOf: anthropicUsage,
  },
};

/**
 * Reads usage from a server-sent event stream as it passes through, without holding it: every event
 * is forwarded the moment it arrives, and the counts found along the way are what the call used.
 */
function meterStream(
  body: ReadableStream<Uint8Array>,
  surface: Surface,
  done: (tokens: Tokens) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  const totals: Tokens = { inputTokens: 0, outputTokens: 0 };
  const read = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const found = surface.usageOf(event);
    // Each vendor reports some counts once and others at the end: keep the largest seen of each.
    totals.inputTokens = Math.max(totals.inputTokens, found.inputTokens);
    totals.outputTokens = Math.max(totals.outputTokens, found.outputTokens);
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) read(line.trim());
      },
      flush() {
        if (buffer) read(buffer.trim());
        done(totals);
      },
    }),
  );
}

/** The key a caller presented, whichever header its SDK put it in. */
function presentedKey(headers: Headers): string | null {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? headers.get("x-api-key");
}

function refuse(protocol: LlmProtocol, status: number, message: string) {
  // Each SDK reads its own vendor's error shape, so a refusal is said in the caller's dialect.
  const body =
    protocol === "anthropic"
      ? { type: "error", error: { type: "invalid_request_error", message } }
      : { error: { message, type: "invalid_request_error" } };
  return Response.json(body, { status });
}

export type ModelGateway = ReturnType<typeof createModelGateway>;

export function createModelGateway(deps: {
  database: Database;
  registry: LlmRegistry;
  tokens: GatewayTokens;
  hooks?: GatewayHooks;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  async function settle(
    caller: GatewayCaller,
    model: ResolvedModel,
    tokens: Tokens,
    status: number,
    startedAt: number,
  ) {
    const cost = costOf(tokens, model);
    try {
      const [row] = await deps.database
        .insert(llmUsage)
        .values({
          modelId: model.modelId,
          modelName: model.name,
          providerId: model.providerId,
          payerUserId: caller.payerUserId,
          agentId: caller.agentId,
          spaceId: caller.spaceId,
          purpose: caller.purpose,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          cost,
          status,
          durationMs: now() - startedAt,
        })
        .returning({ id: llmUsage.id });
      if (row && cost > 0)
        await deps.hooks?.charge?.({
          usageId: row.id,
          caller,
          model,
          ...tokens,
          cost,
        });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "llm-usage-not-recorded",
          model: model.name,
          payer: caller.payerUserId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function carry(request: Request, surface: Surface): Promise<Response> {
    const startedAt = now();
    const caller = deps.tokens.verify(presentedKey(request.headers));
    if (!caller)
      return refuse(
        surface.protocol,
        401,
        "This key is not one this gateway issued.",
      );
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return refuse(surface.protocol, 400, "The request body is not JSON.");
    }
    const name = typeof body.model === "string" ? body.model : "";
    const model = name ? await deps.registry.resolve(name) : null;
    if (!model)
      return refuse(
        surface.protocol,
        404,
        `There is no model called ${JSON.stringify(name)} here.`,
      );
    if (model.protocol !== surface.protocol)
      return refuse(
        surface.protocol,
        400,
        `${name} is spoken to through the ${model.protocol} surface of this gateway.`,
      );
    if (surface.path === "/responses" && model.providerKind !== "openai")
      return refuse(
        surface.protocol,
        400,
        `${name} is not served through the Responses API.`,
      );
    const admitted = (await deps.hooks?.admit?.(caller, model)) ?? { ok: true };
    if (!admitted.ok) return refuse(surface.protocol, 402, admitted.message);

    const streaming = body.stream === true;
    const outgoing: Record<string, unknown> = {
      ...body,
      model: model.upstream,
      // Without this an OpenAI stream never says how much it used, and the call would go uncharged.
      ...(streaming && surface.path === "/chat/completions"
        ? {
            stream_options: {
              ...record(body.stream_options),
              include_usage: true,
            },
          }
        : {}),
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (surface.protocol === "anthropic") {
      if (model.apiKey) headers["x-api-key"] = model.apiKey;
      headers["anthropic-version"] =
        request.headers.get("anthropic-version") ?? "2023-06-01";
      const beta = request.headers.get("anthropic-beta");
      if (beta) headers["anthropic-beta"] = beta;
    } else if (model.apiKey) {
      headers.authorization = `Bearer ${model.apiKey}`;
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(`${model.baseUrl}${surface.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(outgoing),
        signal: request.signal,
      });
    } catch (error) {
      await settle(
        caller,
        model,
        { inputTokens: 0, outputTokens: 0 },
        502,
        startedAt,
      );
      return refuse(
        surface.protocol,
        502,
        `The model's provider could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const type = upstream.headers.get("content-type") ?? "";
    if (upstream.ok && upstream.body && type.includes("text/event-stream")) {
      const metered = meterStream(upstream.body, surface, (tokens) => {
        void settle(caller, model, tokens, upstream.status, startedAt);
      });
      return new Response(metered, {
        status: upstream.status,
        headers: { "content-type": type, "cache-control": "no-cache" },
      });
    }
    const text = await upstream.text();
    let tokens: Tokens = { inputTokens: 0, outputTokens: 0 };
    if (upstream.ok) {
      try {
        tokens = surface.usageOf(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // An answer that is not JSON used nothing anybody can count.
      }
    }
    await settle(caller, model, tokens, upstream.status, startedAt);
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": type || "application/json" },
    });
  }

  /** What the caller may name, in OpenAI's list shape, which both SDKs can read. */
  async function list(request: Request): Promise<Response> {
    if (!deps.tokens.verify(presentedKey(request.headers)))
      return refuse("openai", 401, "This key is not one this gateway issued.");
    const models = (await deps.registry.models()).filter(
      (model) => model.enabled,
    );
    return Response.json({
      object: "list",
      data: models.map((model) => ({
        id: model.name,
        object: "model",
        owned_by: "openduet",
        capabilities: model.capabilities,
      })),
    });
  }

  // Typed as the app's own routes so it mounts beside them; it reads no session, only its tokens.
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/api/llm/openai/v1/chat/completions", (c) =>
    carry(c.req.raw, SURFACES["openai/chat"] as Surface),
  );
  routes.post("/api/llm/openai/v1/responses", (c) =>
    carry(c.req.raw, SURFACES["openai/responses"] as Surface),
  );
  routes.post("/api/llm/openai/v1/embeddings", (c) =>
    carry(c.req.raw, SURFACES["openai/embeddings"] as Surface),
  );
  routes.get("/api/llm/openai/v1/models", (c) => list(c.req.raw));
  routes.post("/api/llm/anthropic/v1/messages", (c) =>
    carry(c.req.raw, SURFACES["anthropic/messages"] as Surface),
  );
  routes.get("/api/llm/anthropic/v1/models", (c) => list(c.req.raw));

  /**
   * Call the gateway from inside this process, as a model SDK would over the network. Shaped as the
   * runtime's `fetch`, which is what the SDKs take; it has nothing to preconnect to.
   */
  const inProcess = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(routes.fetch(new Request(input, init))),
    { preconnect: () => {} },
  ) as typeof fetch;

  return { routes, fetch: inProcess };
}

/** The address model SDKs in this process are pointed at. Never resolved: `fetch` answers it. */
export const IN_PROCESS_GATEWAY = "http://model-gateway.internal";
