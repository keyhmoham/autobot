/**
 * Wallets and the ledger that explains them. The vocabulary is shared/wallet.ts; the service that
 * moves credits is wallet/service.ts, and is the only writer of these tables.
 *
 * A wallet's balance is kept on its row and changed only in the same transaction as the ledger entry
 * that explains the change, with the row locked, so the two never disagree and two charges at once
 * never both read the same balance.
 */
import type { ChargeCategory, LedgerEntryType } from "@openbot/shared/wallet";
import { CHARGE_CATEGORIES, LEDGER_ENTRY_TYPES } from "@openbot/shared/wallet";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { spaces } from "./workspace";

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const wallets = pgTable("wallets", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  balance: bigint("balance", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    type: text("type").$type<LedgerEntryType>().notNull(),
    category: text("category").$type<ChargeCategory>(),
    /** Who it came out of. Null for a mint. Kept when the person is deleted: a ledger is not rewritten. */
    fromUserId: text("from_user_id"),
    /** Who it went to. Null for a spend or an expiry, where it leaves the deployment's wallets. */
    toUserId: text("to_user_id"),
    /** Always positive; the direction is from and to. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    description: text("description").notNull().default(""),
    /** The space a charge was for, so a space's spending is read from the ledger alone. */
    spaceId: text("space_id"),
    agentId: text("agent_id"),
    /** What a charge settled (an `llm_usage` row, a computer's minute), for tracing one back. */
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ledger_entries_from_idx").on(table.fromUserId, table.seq),
    index("ledger_entries_to_idx").on(table.toUserId, table.seq),
    index("ledger_entries_space_idx").on(table.spaceId, table.createdAt),
    index("ledger_entries_created_idx").on(table.createdAt),
    // What a charge or a delivery settled is settled once: a second replica charging the same
    // computer minute, or a transfer delivered twice, is refused here rather than paid twice.
    uniqueIndex("ledger_entries_reference_unique")
      .on(table.reference)
      .where(sql`${table.reference} is not null`),
    check("ledger_entries_amount_check", sql`${table.amount} > 0`),
    check(
      "ledger_entries_type_check",
      sql`${table.type} IN (${oneOf(LEDGER_ENTRY_TYPES)})`,
    ),
    check(
      "ledger_entries_category_check",
      sql`${table.category} IS NULL OR ${table.category} IN (${oneOf(CHARGE_CATEGORIES)})`,
    ),
  ],
);

/**
 * Credits given with an expiry; credits given without one are only a mint, with nothing to track. Spending draws on the grant that lapses soonest first, tracked in
 * `remaining`, so what a person bought or was sent is never what lapses while a grant still has some.
 */
export const walletGrants = pgTable(
  "wallet_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    remaining: bigint("remaining", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status")
      .$type<"active" | "expired">()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("wallet_grants_user_idx").on(table.userId, table.status),
    index("wallet_grants_due_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'active'`),
    check("wallet_grants_remaining_check", sql`${table.remaining} >= 0`),
  ],
);

/** What a space may spend, and has. Every charge for a space counts here, capped or not. */
export const spaceBudgets = pgTable("space_budgets", {
  spaceId: text("space_id")
    .primaryKey()
    .references(() => spaces.id, { onDelete: "cascade" }),
  /** 0 means no limit. */
  cap: bigint("cap", { mode: "number" }).notNull().default(0),
  spent: bigint("spent", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** One row: how this deployment charges. */
export const billingSettings = pgTable(
  "billing_settings",
  {
    id: smallint("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    signupGrant: bigint("signup_grant", { mode: "number" })
      .notNull()
      .default(0),
    grantDays: integer("grant_days").notNull().default(30),
    computerMinutePrice: bigint("computer_minute_price", { mode: "number" })
      .notNull()
      .default(0),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("billing_settings_single_row", sql`${table.id} = 1`)],
);
