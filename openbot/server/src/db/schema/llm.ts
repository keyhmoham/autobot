/**
 * The model gateway's tables: the vendor accounts an administrator added, the models priced on each,
 * which model fills each role, and one row per call the gateway carried. The vocabulary is
 * shared/llm.ts; the gateway is llm/gateway.ts.
 *
 * A provider's key is not here. It is a `credentials` row like every other secret this deployment
 * holds (encrypted with KEY_ENCRYPTION_KEY, revocable, never returned), and the provider points at it.
 */
import type {
  LlmCapability,
  LlmProtocol,
  LlmProviderKind,
  LlmRole,
} from "@openbot/shared/llm";
import { LLM_PROTOCOLS, LLM_ROLES } from "@openbot/shared/llm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { credentials, users } from "./core";

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const llmProviders = pgTable(
  "llm_providers",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<LlmProviderKind>().notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    protocol: text("protocol").$type<LlmProtocol>().notNull(),
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "llm_providers_protocol_check",
      sql`${table.protocol} IN (${oneOf(LLM_PROTOCOLS)})`,
    ),
  ],
);

export const llmModels = pgTable(
  "llm_models",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => llmProviders.id, { onDelete: "cascade" }),
    /** What callers name it by. Unique, so a name answers one model. */
    name: text("name").notNull(),
    /** What the vendor calls it. */
    upstream: text("upstream").notNull(),
    label: text("label").notNull().default(""),
    capabilities: text("capabilities")
      .array()
      .$type<LlmCapability[]>()
      .notNull()
      .default(["chat"]),
    /** Credits per million input tokens. */
    inputPrice: doublePrecision("input_price").notNull().default(0),
    /** Credits per million output tokens. */
    outputPrice: doublePrecision("output_price").notNull().default(0),
    contextWindow: integer("context_window"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("llm_models_name_idx").on(table.name)],
);

/** Which model fills each role. A role with no row has none chosen. */
export const llmRoles = pgTable(
  "llm_roles",
  {
    role: text("role").$type<LlmRole>().primaryKey(),
    modelId: text("model_id")
      .notNull()
      .references(() => llmModels.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("llm_roles_role_check", sql`${table.role} IN (${oneOf(LLM_ROLES)})`),
  ],
);

/**
 * One call the gateway carried, what it used and what it cost.
 *
 * The record a wallet charge is made from and the answer to "what did this spend". `payer_user_id`
 * is whose wallet pays: the person a run was for, or null for the deployment's own calls (a remote
 * Bot's container, a check at boot), which nobody's wallet pays for.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: text("model_id"),
    modelName: text("model_name").notNull(),
    providerId: text("provider_id"),
    payerUserId: text("payer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id"),
    spaceId: text("space_id"),
    /** What made the call: a Bot's turn, one of the deployment's decisions, or a deployment key. */
    purpose: text("purpose").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Credits. */
    cost: bigint("cost", { mode: "number" }).notNull().default(0),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("llm_usage_created_idx").on(table.createdAt),
    index("llm_usage_payer_idx").on(table.payerUserId, table.createdAt),
    index("llm_usage_space_idx")
      .on(table.spaceId, table.createdAt)
      .where(sql`${table.spaceId} is not null`),
  ],
);
