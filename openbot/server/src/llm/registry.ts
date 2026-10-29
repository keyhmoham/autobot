/**
 * The vendor accounts, models, prices and roles an administrator set up, and the one question the
 * gateway asks of them: for this model name, where do I send the call, with which key, at what price.
 *
 * Keys go into the credential vault like every other secret, encrypted with KEY_ENCRYPTION_KEY, and are
 * decrypted only on the way out of a call. Nothing here ever answers with a key.
 */
import {
  LLM_CAPABILITIES,
  LLM_PROVIDER_KINDS,
  LLM_ROLES,
  type LlmCapability,
  type LlmModelWire,
  type LlmProtocol,
  type LlmProviderWire,
  type LlmRole,
  type LlmRolesWire,
  presetFor,
} from "@openbot/shared/llm";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { credentials } from "../db/schema/core";
import { llmModels, llmProviders, llmRoles } from "../db/schema/llm";

export class LlmRegistryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "LlmRegistryError";
  }
}

/** Everything the gateway needs to carry one call to its vendor. */
export type ResolvedModel = {
  modelId: string;
  name: string;
  upstream: string;
  providerId: string;
  providerKind: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string | null;
  /** Which stored key it is, so a check about one key is never read as about another. Not secret. */
  keyId: string | null;
  inputPrice: number;
  outputPrice: number;
  capabilities: LlmCapability[];
};

const providerInput = z.strictObject({
  kind: z.enum(LLM_PROVIDER_KINDS as [string, ...string[]]),
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url().max(500).optional(),
  apiKey: z.string().trim().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
});
const modelInput = z.strictObject({
  providerId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z0-9._:/@-]+$/,
      "A model name is letters, digits and . _ : / @ -",
    ),
  upstream: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().max(120).optional(),
  capabilities: z.array(z.enum(LLM_CAPABILITIES)).min(1).max(5).optional(),
  inputPrice: z.number().finite().nonnegative().optional(),
  outputPrice: z.number().finite().nonnegative().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

export type LlmRegistry = ReturnType<typeof createLlmRegistry>;

export function createLlmRegistry(deps: {
  database: Database;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
}) {
  const { database } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function storeKey(providerId: string, apiKey: string) {
    const encryptedValue = await encryptSecret(deps.encryptionKey, apiKey);
    return database.transaction(async (transaction) => {
      // One live key per provider: the previous one is revoked, kept for the trail.
      await transaction
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(credentials.kind, "model"),
            eq(credentials.provider, `llm:${providerId}`),
            isNull(credentials.revokedAt),
          ),
        );
      const [row] = await transaction
        .insert(credentials)
        .values({
          kind: "model",
          provider: `llm:${providerId}`,
          keyId: "api-key",
          metadata: { purpose: "model gateway provider" },
          encryptedValue,
        })
        .returning({ id: credentials.id });
      if (!row) throw new Error("The key could not be stored.");
      await transaction
        .update(llmProviders)
        .set({ credentialId: row.id, updatedAt: new Date() })
        .where(eq(llmProviders.id, providerId));
    });
  }

  async function readKey(credentialId: string | null): Promise<string | null> {
    if (!credentialId) return null;
    const [row] = await database
      .select({
        value: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.id, credentialId))
      .limit(1);
    if (!row || row.revokedAt) return null;
    return decryptSecret(deps.encryptionKey, row.value);
  }

  function providerWire(
    row: typeof llmProviders.$inferSelect,
  ): LlmProviderWire {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      baseUrl: row.baseUrl,
      protocol: row.protocol,
      enabled: row.enabled,
      hasKey: row.credentialId !== null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  function modelWire(row: typeof llmModels.$inferSelect): LlmModelWire {
    return {
      id: row.id,
      providerId: row.providerId,
      name: row.name,
      upstream: row.upstream,
      label: row.label,
      capabilities: row.capabilities,
      inputPrice: row.inputPrice,
      outputPrice: row.outputPrice,
      contextWindow: row.contextWindow,
      enabled: row.enabled,
    };
  }

  async function providerRow(id: string) {
    const [row] = await database
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.id, id))
      .limit(1);
    if (!row) throw new LlmRegistryError("That provider was not found.", 404);
    return row;
  }

  async function providers(): Promise<LlmProviderWire[]> {
    const rows = await database
      .select()
      .from(llmProviders)
      .orderBy(asc(llmProviders.createdAt));
    return rows.map(providerWire);
  }

  async function createProvider(input: unknown): Promise<LlmProviderWire> {
    const body = providerInput.parse(input);
    const preset = presetFor(body.kind);
    const baseUrl = (body.baseUrl ?? preset?.baseUrl ?? "").replace(/\/+$/, "");
    if (!baseUrl)
      throw new LlmRegistryError(
        "A custom provider needs the address of its API.",
      );
    const id = `llmp_${crypto.randomUUID()}`;
    await database.insert(llmProviders).values({
      id,
      kind: body.kind as LlmProviderWire["kind"],
      name: body.name ?? preset?.name ?? body.kind,
      baseUrl,
      protocol: preset?.protocol ?? "openai",
      enabled: body.enabled ?? true,
    });
    if (body.apiKey) await storeKey(id, body.apiKey);
    return providerWire(await providerRow(id));
  }

  async function updateProvider(
    id: string,
    input: unknown,
  ): Promise<LlmProviderWire> {
    const body = providerInput.omit({ kind: true }).partial().parse(input);
    await providerRow(id);
    const { apiKey, ...fields } = body;
    if (Object.keys(fields).length)
      await database
        .update(llmProviders)
        .set({
          ...fields,
          ...(fields.baseUrl
            ? { baseUrl: fields.baseUrl.replace(/\/+$/, "") }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(llmProviders.id, id));
    if (apiKey) await storeKey(id, apiKey);
    return providerWire(await providerRow(id));
  }

  async function deleteProvider(id: string) {
    const row = await providerRow(id);
    await database.transaction(async (transaction) => {
      if (row.credentialId)
        await transaction
          .update(credentials)
          .set({ revokedAt: new Date() })
          .where(eq(credentials.id, row.credentialId));
      await transaction.delete(llmProviders).where(eq(llmProviders.id, id));
    });
  }

  async function models(): Promise<LlmModelWire[]> {
    const rows = await database
      .select()
      .from(llmModels)
      .orderBy(asc(llmModels.name));
    return rows.map(modelWire);
  }

  async function createModel(input: unknown): Promise<LlmModelWire> {
    const body = modelInput.parse(input);
    await providerRow(body.providerId);
    const [taken] = await database
      .select({ id: llmModels.id })
      .from(llmModels)
      .where(eq(llmModels.name, body.name))
      .limit(1);
    if (taken)
      throw new LlmRegistryError(`A model is already called ${body.name}.`);
    const id = `llmm_${crypto.randomUUID()}`;
    const [row] = await database
      .insert(llmModels)
      .values({
        id,
        providerId: body.providerId,
        name: body.name,
        upstream: body.upstream ?? body.name,
        label: body.label ?? "",
        capabilities: body.capabilities ?? ["chat"],
        inputPrice: body.inputPrice ?? 0,
        outputPrice: body.outputPrice ?? 0,
        contextWindow: body.contextWindow ?? null,
        enabled: body.enabled ?? true,
      })
      .returning();
    if (!row) throw new Error("The model could not be saved.");
    return modelWire(row);
  }

  async function updateModel(
    id: string,
    input: unknown,
  ): Promise<LlmModelWire> {
    const body = modelInput.omit({ providerId: true }).partial().parse(input);
    const [row] = await database
      .update(llmModels)
      .set(body)
      .where(eq(llmModels.id, id))
      .returning();
    if (!row) throw new LlmRegistryError("That model was not found.", 404);
    return modelWire(row);
  }

  async function deleteModel(id: string) {
    const deleted = await database
      .delete(llmModels)
      .where(eq(llmModels.id, id))
      .returning({ id: llmModels.id });
    if (!deleted.length)
      throw new LlmRegistryError("That model was not found.", 404);
  }

  /**
   * The models a provider says it serves, added unpriced and switched off, so an administrator prices
   * the ones they want and turns them on. Models already here are left as they are.
   */
  async function importModels(providerId: string) {
    const provider = await providerRow(providerId);
    const key = await readKey(provider.credentialId);
    const response = await fetchImpl(`${provider.baseUrl}/models`, {
      headers:
        provider.protocol === "anthropic"
          ? { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }
          : key
            ? { authorization: `Bearer ${key}` }
            : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new LlmRegistryError(
        `The provider answered ${response.status} when asked for its models.`,
      );
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter(
        (id): id is string =>
          typeof id === "string" && /^[A-Za-z0-9._:/@-]+$/.test(id),
      );
    const existing = new Set((await models()).map((model) => model.name));
    let added = 0;
    for (const upstream of ids) {
      const name = existing.has(upstream)
        ? `${provider.kind}/${upstream}`
        : upstream;
      if (existing.has(name)) continue;
      await database.insert(llmModels).values({
        id: `llmm_${crypto.randomUUID()}`,
        providerId,
        name,
        upstream,
        capabilities: /embed/i.test(upstream) ? ["embedding"] : ["chat"],
        enabled: false,
      });
      existing.add(name);
      added += 1;
    }
    return { added, seen: ids.length };
  }

  async function roles(): Promise<LlmRolesWire> {
    const rows = await database
      .select({ role: llmRoles.role, name: llmModels.name })
      .from(llmRoles)
      .innerJoin(llmModels, eq(llmModels.id, llmRoles.modelId));
    const chosen = new Map(rows.map((row) => [row.role, row.name]));
    return Object.fromEntries(
      LLM_ROLES.map((role) => [role, chosen.get(role) ?? null]),
    ) as LlmRolesWire;
  }

  async function setRole(role: LlmRole, modelId: string | null) {
    if (!LLM_ROLES.includes(role)) throw new LlmRegistryError("Unknown role.");
    if (modelId === null) {
      await database.delete(llmRoles).where(eq(llmRoles.role, role));
      return;
    }
    const [model] = await database
      .select({ id: llmModels.id, capabilities: llmModels.capabilities })
      .from(llmModels)
      .where(eq(llmModels.id, modelId))
      .limit(1);
    if (!model) throw new LlmRegistryError("That model was not found.", 404);
    const needs: LlmCapability = role === "embedding" ? "embedding" : "chat";
    const usable =
      model.capabilities.includes(needs) ||
      (role === "decision" && model.capabilities.includes("decision"));
    if (!usable)
      throw new LlmRegistryError(`That model cannot fill the ${role} role.`);
    await database
      .insert(llmRoles)
      .values({ role, modelId })
      .onConflictDoUpdate({
        target: llmRoles.role,
        set: { modelId, updatedAt: new Date() },
      });
  }

  /**
   * The model a role is filled with. The decision role falls back to the chat model, because a
   * deployment that chose one model should have every decision made with it rather than none.
   */
  async function modelForRole(role: LlmRole): Promise<string | null> {
    const chosen = await roles();
    return chosen[role] ?? (role === "decision" ? chosen.chat : null);
  }

  /** Where a call naming this model goes. Null for a name that is not an enabled model. */
  async function resolve(name: string): Promise<ResolvedModel | null> {
    const [row] = await database
      .select({ model: llmModels, provider: llmProviders })
      .from(llmModels)
      .innerJoin(llmProviders, eq(llmProviders.id, llmModels.providerId))
      .where(
        and(
          eq(llmModels.name, name),
          eq(llmModels.enabled, true),
          eq(llmProviders.enabled, true),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      modelId: row.model.id,
      name: row.model.name,
      upstream: row.model.upstream,
      providerId: row.provider.id,
      providerKind: row.provider.kind,
      protocol: row.provider.protocol,
      baseUrl: row.provider.baseUrl,
      apiKey: await readKey(row.provider.credentialId),
      keyId: row.provider.credentialId,
      inputPrice: row.model.inputPrice,
      outputPrice: row.model.outputPrice,
      capabilities: row.model.capabilities,
    };
  }

  /** Whether any model is set up at all, for a deployment's first start. */
  async function empty(): Promise<boolean> {
    const [row] = await database
      .select({ id: llmModels.id })
      .from(llmModels)
      .limit(1);
    return !row;
  }

  return {
    providers,
    createProvider,
    updateProvider,
    deleteProvider,
    models,
    createModel,
    updateModel,
    deleteModel,
    importModels,
    roles,
    setRole,
    modelForRole,
    resolve,
    empty,
  };
}
