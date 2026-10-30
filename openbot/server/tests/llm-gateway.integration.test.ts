import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  llmModels,
  llmProviders,
  llmRoles,
  llmUsage,
} from "../src/db/schema";
import { seedModelsFromEnvironment } from "../src/llm/bootstrap";
import {
  createModelGateway,
  type GatewayUsage,
  IN_PROCESS_GATEWAY,
} from "../src/llm/gateway";
import { createGatewayModels, NoModelError } from "../src/llm/models";
import { createLlmRegistry } from "../src/llm/registry";
import { createGatewayTokens } from "../src/llm/tokens";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 3).toString("base64");
const prefix = `gw-${randomUUID().slice(0, 8)}`;

/** A vendor double that answers in the OpenAI or Anthropic wire format and remembers the calls. */
function vendor(protocol: "openai" | "anthropic") {
  const calls: {
    path: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body,
      });
      if (body.stream === true) {
        const events =
          protocol === "anthropic"
            ? [
                {
                  type: "message_start",
                  message: { usage: { input_tokens: 30 } },
                },
                {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "Hi" },
                },
                { type: "message_delta", usage: { output_tokens: 12 } },
              ]
            : [
                { choices: [{ delta: { content: "Hi" } }] },
                {
                  choices: [],
                  usage: { prompt_tokens: 30, completion_tokens: 12 },
                },
              ];
        return new Response(
          `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json(
        protocol === "anthropic"
          ? {
              content: [{ type: "text", text: '{"ok":true}' }],
              usage: {
                input_tokens: 1000,
                output_tokens: 500,
                cache_read_input_tokens: 1000,
              },
            }
          : {
              choices: [{ message: { content: '{"ok":true}' } }],
              usage: { prompt_tokens: 1000, completion_tokens: 500 },
            },
      );
    },
  });
  return { calls, server, url: `${server.url.origin}/v1` };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  const providers = await database
    .select({ id: llmProviders.id })
    .from(llmProviders)
    .where(like(llmProviders.name, `${prefix}%`));
  const ids = providers.map((row) => row.id);
  if (ids.length) {
    await database.delete(llmRoles);
    await database.delete(llmProviders).where(inArray(llmProviders.id, ids));
    await database.delete(credentials).where(
      inArray(
        credentials.provider,
        ids.map((id) => `llm:${id}`),
      ),
    );
  }
});
afterAll(async () => {
  await database.$client.close();
});

function setup(hooks: Parameters<typeof createModelGateway>[0]["hooks"] = {}) {
  const registry = createLlmRegistry({ database, encryptionKey });
  const tokens = createGatewayTokens({
    encryptionKey,
    deploymentKey: "deployment-secret",
  });
  const gateway = createModelGateway({ database, registry, tokens, hooks });
  const models = createGatewayModels({ gateway, registry, tokens });
  return { registry, tokens, gateway, models };
}

async function providerWithModel(
  registry: ReturnType<typeof setup>["registry"],
  protocol: "openai" | "anthropic",
  name: string,
) {
  const double = vendor(protocol);
  servers.push(double.server);
  const provider = await registry.createProvider({
    kind: protocol === "anthropic" ? "anthropic" : "custom",
    name: `${prefix} ${protocol}`,
    baseUrl: double.url,
    apiKey: `${protocol}-vendor-key`,
  });
  const model = await registry.createModel({
    providerId: provider.id,
    name,
    upstream: `upstream-${name}`,
    capabilities: ["chat", "decision"],
    inputPrice: 2_000_000,
    outputPrice: 8_000_000,
  });
  return { double, provider, model };
}

describe("the model gateway", () => {
  test("carries a call to its vendor with the vendor's key and name, and meters it to the payer", async () => {
    const charged: GatewayUsage[] = [];
    const { registry, tokens, gateway } = setup({
      charge: async (usage) => void charged.push(usage),
    });
    const { double, provider } = await providerWithModel(
      registry,
      "openai",
      `${prefix}-chat`,
    );
    const response = await gateway.fetch(
      `${IN_PROCESS_GATEWAY}/api/llm/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.issue({ payerUserId: null, agentId: "bot-1", spaceId: "space_1", purpose: "turn" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: `${prefix}-chat`,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(double.calls[0]?.path).toBe("/v1/chat/completions");
    expect(double.calls[0]?.body.model).toBe(`upstream-${prefix}-chat`);
    expect(double.calls[0]?.headers.get("authorization")).toBe(
      "Bearer openai-vendor-key",
    );
    const [usage] = await database
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.providerId, provider.id))
      .orderBy(desc(llmUsage.createdAt))
      .limit(1);
    // 1000 in at 2 credits each and 500 out at 8: 6000 credits.
    expect(usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cost: 6000,
      agentId: "bot-1",
      spaceId: "space_1",
      purpose: "turn",
    });
    expect(charged.map((entry) => entry.cost)).toEqual([6000]);
  });

  test("meters a stream as it passes, without holding it", async () => {
    const { registry, models, gateway, tokens } = setup();
    const { double, provider } = await providerWithModel(
      registry,
      "openai",
      `${prefix}-stream`,
    );
    const response = await gateway.fetch(
      `${IN_PROCESS_GATEWAY}/api/llm/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.issue({ payerUserId: null, agentId: null, spaceId: null, purpose: "turn" })}`,
        },
        body: JSON.stringify({
          model: `${prefix}-stream`,
          stream: true,
          messages: [],
        }),
      },
    );
    expect(await response.text()).toContain('"content":"Hi"');
    // The gateway asked for the usage chunk a stream does not send by default.
    expect(double.calls[0]?.body.stream_options).toEqual({
      include_usage: true,
    });
    await Bun.sleep(50);
    const [usage] = await database
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.providerId, provider.id));
    expect(usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
    expect(models).toBeDefined();
  });

  test("speaks Anthropic's own API, counting cached input as input", async () => {
    const { registry, models } = setup();
    const { double, provider } = await providerWithModel(
      registry,
      "anthropic",
      `${prefix}-claude`,
    );
    await registry.setRole(
      "decision",
      (await registry.models()).find((m) => m.name === `${prefix}-claude`)
        ?.id ?? null,
    );
    expect(
      await models.complete({
        role: "decision",
        prompt: "Choose.",
        system: "Rules.",
      }),
    ).toBe('{"ok":true}');
    expect(double.calls[0]?.path).toBe("/v1/messages");
    expect(double.calls[0]?.headers.get("x-api-key")).toBe(
      "anthropic-vendor-key",
    );
    expect(double.calls[0]?.body).toMatchObject({
      system: "Rules.",
      max_tokens: 1024,
    });
    const [usage] = await database
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.providerId, provider.id));
    expect(usage).toMatchObject({
      inputTokens: 2000,
      outputTokens: 500,
      purpose: "decision",
    });
  });

  test("refuses a key it did not issue, a model it does not have, the wrong surface, and a payer who cannot pay", async () => {
    const { registry, gateway, tokens } = setup({
      admit: async (caller) =>
        caller.payerUserId === "broke"
          ? { ok: false, message: "The wallet is empty." }
          : { ok: true },
    });
    await providerWithModel(registry, "openai", `${prefix}-guarded`);
    const call = (key: string, path: string, model: string) =>
      gateway.fetch(`${IN_PROCESS_GATEWAY}/api/llm/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [], max_tokens: 1 }),
      });
    const turn = (payerUserId: string | null) =>
      tokens.issue({
        payerUserId,
        agentId: null,
        spaceId: null,
        purpose: "turn",
      });
    expect(
      (
        await call(
          "sk-forged",
          "openai/v1/chat/completions",
          `${prefix}-guarded`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await call(turn(null), "openai/v1/chat/completions", "nope")).status,
    ).toBe(404);
    expect(
      (await call(turn(null), "anthropic/v1/messages", `${prefix}-guarded`))
        .status,
    ).toBe(400);
    expect(
      (await call(turn(null), "openai/v1/responses", `${prefix}-guarded`))
        .status,
    ).toBe(400);
    const refused = await call(
      turn("broke"),
      "openai/v1/chat/completions",
      `${prefix}-guarded`,
    );
    expect(refused.status).toBe(402);
    expect(await refused.text()).toContain("The wallet is empty.");
    // The deployment's own key is accepted, and pays from nobody's wallet.
    expect(
      (
        await call(
          "deployment-secret",
          "openai/v1/chat/completions",
          `${prefix}-guarded`,
        )
      ).status,
    ).toBe(200);
  });

  test("a token expires, and cannot be altered to name another payer", () => {
    let now = Date.now();
    const tokens = createGatewayTokens({ encryptionKey, now: () => now });
    const token = tokens.issue(
      { payerUserId: "ana", agentId: null, spaceId: null, purpose: "turn" },
      1000,
    );
    expect(tokens.verify(token)?.payerUserId).toBe("ana");
    const [head, , signature] = token.split(".");
    const forged = `${head}.${Buffer.from(JSON.stringify({ u: "bo", p: "turn", e: 9e9 })).toString("base64url")}.${signature}`;
    expect(tokens.verify(forged)).toBeNull();
    now += 2000;
    expect(tokens.verify(token)).toBeNull();
  });

  test("the decision role falls back to the chat model, and nothing chosen is said plainly", async () => {
    const { registry, models } = setup();
    await expect(
      models.complete({ role: "decision", prompt: "x" }),
    ).rejects.toThrow(NoModelError);
    const { model } = await providerWithModel(
      registry,
      "openai",
      `${prefix}-fallback`,
    );
    await registry.setRole("chat", model.id);
    expect(await registry.modelForRole("decision")).toBe(`${prefix}-fallback`);
    await expect(registry.setRole("embedding", model.id)).rejects.toThrow(
      "cannot fill",
    );
  });

  test("a deployment's old key becomes its first provider and chat model, once", async () => {
    const registry = createLlmRegistry({ database, encryptionKey });
    await database.delete(llmRoles);
    const existing = await database
      .select({ id: llmModels.id })
      .from(llmModels)
      .limit(1);
    if (existing.length) return; // Another suite's models: seeding only ever runs on an empty registry.
    const seeded = await seedModelsFromEnvironment({
      registry,
      packageModel: { provider: "anthropic", defaultModel: "claude-x" },
      resolveKey: async () => "old-anthropic-key",
      environment: {},
    });
    expect(seeded.seeded).toBe("claude-x");
    expect(await registry.modelForRole("chat")).toBe("claude-x");
    const resolved = await registry.resolve("claude-x");
    expect(resolved?.apiKey).toBe("old-anthropic-key");
    expect(resolved?.protocol).toBe("anthropic");
    await database
      .update(llmProviders)
      .set({ name: `${prefix} seeded` })
      .where(eq(llmProviders.id, resolved?.providerId ?? ""));
    expect(
      (
        await seedModelsFromEnvironment({
          registry,
          packageModel: { provider: "openai", defaultModel: "gpt-x" },
          resolveKey: async () => "another",
          environment: {},
        })
      ).seeded,
    ).toBeNull();
  });
});
