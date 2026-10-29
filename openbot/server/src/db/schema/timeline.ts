/**
 * Spaces' timelines: the things in each space and the dated statements about them, plus how far each
 * feed has read. The vocabulary is shared/timeline.ts; the service is timeline/service.ts and the
 * feeds that fill it timeline/feeds.ts, which read other tables and never write them.
 */
import type { TimelineKind } from "@openbot/shared/timeline";
import { TIMELINE_KINDS } from "@openbot/shared/timeline";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { spaces } from "./workspace";

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/** A thing a space's statements are about, named as it was when first seen. */
export const timelineEntities = pgTable(
  "timeline_entities",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TimelineKind>().notNull(),
    /** The id of what it stands for (a user, an agent, a room), so one thing is one entity. */
    ref: text("ref").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("timeline_entities_ref_idx").on(
      table.spaceId,
      table.kind,
      table.ref,
    ),
    index("timeline_entities_name_idx").on(
      table.spaceId,
      sql`lower(${table.name})`,
    ),
    check(
      "timeline_entities_kind_check",
      sql`${table.kind} IN (${oneOf(TIMELINE_KINDS)})`,
    ),
  ],
);

export const timelineStatements = pgTable(
  "timeline_statements",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => timelineEntities.id, { onDelete: "cascade" }),
    phrase: text("phrase").notNull(),
    objectId: text("object_id").references(() => timelineEntities.id, {
      onDelete: "cascade",
    }),
    value: text("value"),
    qualifiers: jsonb("qualifiers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** When it was true, from. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** When it stopped being true: set when a later statement about the same state begins. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** The state this statement is about, when it is one that can change ("role:<user>"). */
    stateKey: text("state_key"),
    /** What it was read from, so reading the same record again adds nothing. */
    sourceKey: text("source_key").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("timeline_statements_source_idx").on(
      table.spaceId,
      table.sourceKey,
    ),
    index("timeline_statements_at_idx").on(table.spaceId, table.at),
    index("timeline_statements_subject_idx").on(table.subjectId, table.at),
    index("timeline_statements_object_idx").on(table.objectId, table.at),
    index("timeline_statements_state_idx")
      .on(table.spaceId, table.stateKey, table.at)
      .where(sql`${table.stateKey} is not null`),
  ],
);

/** How far each feed has read: the last record's time and id, since several can share a time. */
export const timelineCursors = pgTable("timeline_cursors", {
  feed: text("feed").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  ref: text("ref").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
