/**
 * Admin → Models over HTTP: the vendor accounts, the models and their prices, which model fills each
 * role, and what the gateway has carried. Administrators only; a key goes in and is never read back.
 */
import {
  LLM_PROVIDER_PRESETS,
  LLM_ROLES,
  type LlmRole,
} from "@openbot/shared/llm";
import { and, desc, gte, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { llmUsage } from "../db/schema/llm";
import { type LlmRegistry, LlmRegistryError } from "./registry";

type Env = { Variables: AppVariables };

export function createLlmAdminRoutes(
  deps: { registry: LlmRegistry; database: Database },
  requireUser: MiddlewareHandler<Env>,
) {
  const { registry } = deps;
  const routes = new Hono<Env>();
  routes.use("*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.onError((error, context) => {
    if (error instanceof LlmRegistryError)
      return context.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return context.json(
        { error: error.issues[0]?.message ?? "That request is not valid." },
        400,
      );
    console.error(error);
    return context.json({ error: "Something went wrong." }, 500);
  });
  const body = (context: { req: { json: () => Promise<unknown> } }) =>
    context.req.json().catch(() => ({}));

  routes.get("/presets", (c) => c.json({ presets: LLM_PROVIDER_PRESETS }));
  routes.get("/providers", async (c) =>
    c.json({ providers: await registry.providers() }),
  );
  routes.post("/providers", async (c) =>
    c.json({ provider: await registry.createProvider(await body(c)) }, 201),
  );
  routes.patch("/providers/:id", async (c) =>
    c.json({
      provider: await registry.updateProvider(c.req.param("id"), await body(c)),
    }),
  );
  routes.delete("/providers/:id", async (c) => {
    await registry.deleteProvider(c.req.param("id"));
    return c.body(null, 204);
  });
  routes.post("/providers/:id/import", async (c) =>
    c.json(await registry.importModels(c.req.param("id"))),
  );
  routes.get("/models", async (c) =>
    c.json({ models: await registry.models() }),
  );
  routes.post("/models", async (c) =>
    c.json({ model: await registry.createModel(await body(c)) }, 201),
  );
  routes.patch("/models/:id", async (c) =>
    c.json({
      model: await registry.updateModel(c.req.param("id"), await body(c)),
    }),
  );
  routes.delete("/models/:id", async (c) => {
    await registry.deleteModel(c.req.param("id"));
    return c.body(null, 204);
  });
  routes.get("/roles", async (c) => c.json({ roles: await registry.roles() }));
  routes.put("/roles/:role", async (c) => {
    const role = c.req.param("role") as LlmRole;
    if (!LLM_ROLES.includes(role))
      return c.json({ error: "Unknown role." }, 404);
    const { modelId } = z
      .strictObject({ modelId: z.string().min(1).nullable() })
      .parse(await body(c));
    await registry.setRole(role, modelId);
    return c.json({ roles: await registry.roles() });
  });

  /** What the gateway carried over the last `days`, by model and by whose wallet paid. */
  routes.get("/usage", async (c) => {
    const days = Math.min(
      Math.max(Number(c.req.query("days") ?? 30) || 30, 1),
      365,
    );
    const since = new Date(Date.now() - days * 86_400_000);
    const window = gte(llmUsage.createdAt, since);
    const byModel = await deps.database
      .select({
        model: llmUsage.modelName,
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${llmUsage.cost}), 0)::bigint`,
        failed: sql<number>`count(*) filter (where ${llmUsage.status} >= 400)::int`,
      })
      .from(llmUsage)
      .where(window)
      .groupBy(llmUsage.modelName)
      .orderBy(desc(sql`sum(${llmUsage.cost})`));
    const byPurpose = await deps.database
      .select({
        purpose: llmUsage.purpose,
        calls: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${llmUsage.cost}), 0)::bigint`,
      })
      .from(llmUsage)
      .where(and(window))
      .groupBy(llmUsage.purpose);
    return c.json({
      days,
      byModel: byModel.map((row) => ({
        ...row,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cost: Number(row.cost),
      })),
      byPurpose: byPurpose.map((row) => ({ ...row, cost: Number(row.cost) })),
    });
  });

  return routes;
}
