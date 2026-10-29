/**
 * Shared conversations: what the people in a `room` or `direct` channel read, and the thread each
 * Bot keeps per person. The engine is channels/conversation.ts.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";
import { jsonb } from "./json";

/**
 * The thread a Bot answers one person in, in one shared channel.
 *
 * Per person and not per channel, because an Intelligence thread belongs to the person it runs as:
 * a Bot answering Ana draws on Ana's memory and connected accounts, and the thread that holds that is
 * hers. What everybody in the channel reads is `channel_messages`, handed to each turn as quoted
 * context, so the Bot still knows the whole conversation.
 */
export const channelAgentThreads = pgTable(
  "channel_agent_threads",
  {
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.actorUserId, table.channelId, table.agentId],
    }),
    uniqueIndex("channel_agent_threads_thread_idx").on(table.threadId),
  ],
);

/**
 * The shared transcript: one row per thing said, by a person or by a Bot.
 *
 * `actor_user_id` is the person a row speaks for: who wrote it, or whose turn the Bot was answering.
 * A Bot's line is shown to the channel only once that person allowed it (see `privateShare` in
 * channels/conversation.ts), which is why the row has to know who that is.
 */
export const channelMessages = pgTable(
  "channel_messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    threadId: text("thread_id"),
    text: text("text").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "waiting" | "completed" | "failed">()
      .notNull()
      .default("completed"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("channel_messages_channel_idx").on(
      table.channelId,
      table.createdAt,
      table.id,
    ),
    check(
      "channel_messages_status_check",
      sql`${table.status} IN ('queued', 'running', 'waiting', 'completed', 'failed')`,
    ),
  ],
);
