import { describe, expect, test } from "bun:test";
import type { LlmRegistry, ResolvedModel } from "../src/llm/registry";
import {
  checkChosenModel,
  modelCheckOutcome,
} from "../src/model-availability-check";

const KEY = "sk-proj-not-a-real-key-0123456789";

const chosen = (overrides: Partial<ResolvedModel> = {}): ResolvedModel => ({
  modelId: "llmm_1",
  name: "chat",
  upstream: "gpt-5.6-terra",
  providerId: "llmp_1",
  providerKind: "openai",
  protocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: KEY,
  keyId: "cred_1",
  inputPrice: 0,
  outputPrice: 0,
  capabilities: ["chat"],
  ...overrides,
});

function registryWith(model: ResolvedModel | null) {
  return {
    modelForRole: async () => (model ? model.name : null),
    resolve: async () => model,
    providers: async () => [
      {
        id: "llmp_1",
        kind: "openai",
        name: "OpenAI",
        baseUrl: model?.baseUrl ?? "",
        protocol: "openai",
        enabled: true,
        hasKey: true,
        createdAt: "",
      },
    ],
  } as unknown as Pick<LlmRegistry, "modelForRole" | "resolve" | "providers">;
}

function fakeFetch(status: number, ids: string[] = []) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Response.json({ data: ids.map((id) => ({ id })) }, { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("what the vendor's answer means", () => {
  test("a list holding the model is available", () => {
    expect(
      modelCheckOutcome({
        provider: "OpenAI",
        model: "gpt-x",
        status: 200,
        listed: ["gpt-x"],
      }),
    ).toEqual({ kind: "available" });
  });

  test("a list without it says the key cannot call the model, and where to fix it", () => {
    const outcome = modelCheckOutcome({
      provider: "OpenAI",
      model: "gpt-5.6-terra",
      status: 200,
      listed: ["gpt-4.1"],
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-unavailable",
    );
    expect(outcome.kind === "warning" && outcome.line.fix).toContain(
      "Admin → Models",
    );
  });

  test.each([401, 403])("%i says the key itself was refused", (status) => {
    const outcome = modelCheckOutcome({
      provider: "Anthropic",
      model: "claude-x",
      status,
      listed: null,
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-credential-rejected",
    );
  });

  test("anything else is unreadable, never a verdict", () => {
    const outcome = modelCheckOutcome({
      provider: "OpenAI",
      model: "gpt-x",
      status: 503,
      listed: null,
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-check-unreadable",
    );
  });
});

describe("asking about the chosen model", () => {
  test("asks the vendor's model list with its own key, and logs nothing when the model is there", async () => {
    const { fetcher, calls } = fakeFetch(200, ["gpt-5.6-terra"]);
    const lines: string[] = [];
    const outcome = await checkChosenModel({
      registry: registryWith(chosen()),
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    expect(outcome).toEqual({ kind: "available" });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(lines).toEqual([]);
  });

  test("speaks to Anthropic with its own headers", async () => {
    const { fetcher, calls } = fakeFetch(200, ["claude-x"]);
    await checkChosenModel({
      registry: registryWith(
        chosen({
          protocol: "anthropic",
          upstream: "claude-x",
          baseUrl: "https://api.anthropic.com/v1",
        }),
      ),
      fetch: fetcher,
      log: () => {},
    });
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("with nothing chosen, or no key, it asks nobody", async () => {
    const { fetcher, calls } = fakeFetch(200);
    expect(
      await checkChosenModel({ registry: registryWith(null), fetch: fetcher }),
    ).toEqual({
      kind: "skipped",
    });
    expect(
      await checkChosenModel({
        registry: registryWith(chosen({ apiKey: null })),
        fetch: fetcher,
      }),
    ).toEqual({ kind: "skipped" });
    expect(calls).toEqual([]);
  });

  test("a refusal is logged with the key never in the line", async () => {
    const { fetcher } = fakeFetch(401);
    const lines: string[] = [];
    const outcome = await checkChosenModel({
      registry: registryWith(chosen()),
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-credential-rejected",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(KEY);
  });

  test("a vendor that cannot be reached is unreadable, and never throws", async () => {
    const outcome = await checkChosenModel({
      registry: registryWith(chosen()),
      fetch: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      log: () => {},
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-check-unreadable",
    );
  });
});
