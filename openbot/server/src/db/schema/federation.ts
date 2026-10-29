/**
 * Federation: this node's identity, the nodes it knows, the join codes a central node admits others
 * with, the nonces that make a signed request good once, and the ledgers other nodes replicate here.
 * The vocabulary is shared/federation.ts; the service is federation/service.ts.
 */
import type { NodeStatus } from "@openbot/shared/federation";
import { NODE_STATUSES } from "@openbot/shared/federation";
import type { ChargeCategory, LedgerEntryType } from "@openbot/shared/wallet";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/** One row: who this node is. The private key is encrypted with KEY_ENCRYPTION_KEY. */
export const federationSelf = pgTable(
  "federation_self",
  {
    id: smallint("id").primaryKey().default(1),
    /** Null until the node joins a mesh or becomes the central node of one. */
    nodeId: text("node_id"),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    isCentral: boolean("is_central").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("federation_self_single_row", sql`${table.id} = 1`)],
);

/** Every other node this one knows, as the central node registered it. */
export const federationNodes = pgTable(
  "federation_nodes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    publicKey: text("public_key").notNull().unique(),
    isCentral: boolean("is_central").notNull().default(false),
    status: text("status").$type<NodeStatus>().notNull().default("online"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "federation_nodes_status_check",
      sql`${table.status} IN (${oneOf(NODE_STATUSES)})`,
    ),
  ],
);

/** What a central node admits another with: single use, hashed, and lapsing. */
export const federationJoinCodes = pgTable("federation_join_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  label: text("label").notNull().default(""),
  createdByUserId: text("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedByNodeId: text("used_by_node_id"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Nonces already accepted, per sender, so a captured request cannot be sent again. In Postgres
 * rather than memory so every replica refuses a replay another one accepted.
 */
export const federationNonces = pgTable(
  "federation_nonces",
  {
    nodeId: text("node_id").notNull(),
    nonce: text("nonce").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.nonce] }),
    index("federation_nonces_seen_idx").on(table.seenAt),
  ],
);

/** How far this node's own ledger has been sent to each node that keeps a replica of it. */
export const federationLedgerCursors = pgTable("federation_ledger_cursors", {
  nodeId: text("node_id").primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Other nodes' ledger entries, as they sent them. Kept by the central node. */
export const federationLedger = pgTable(
  "federation_ledger",
  {
    originNodeId: text("origin_node_id").notNull(),
    originSeq: bigint("origin_seq", { mode: "number" }).notNull(),
    entryId: text("entry_id").notNull(),
    type: text("type").$type<LedgerEntryType>().notNull(),
    category: text("category").$type<ChargeCategory>(),
    fromUserId: text("from_user_id"),
    toUserId: text("to_user_id"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.originNodeId, table.originSeq] })],
);

/**
 * Credits on their way to somebody on another node. Taken from the sender first, then delivered,
 * retried until the other node takes or refuses them: refused, they are returned. The receiving node
 * credits a transfer id once however many times it is delivered, so a retry never pays twice.
 */
export const federationTransfers = pgTable(
  "federation_transfers",
  {
    id: text("id").primaryKey(),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    /** The recipient's email on the other node. */
    recipient: text("recipient").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    note: text("note").notNull().default(""),
    status: text("status")
      .$type<"pending" | "delivered" | "returned">()
      .notNull()
      .default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    index("federation_transfers_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);
