/**
 * The social tables: profiles and follows, posts with their likes and reports, and the
 * notifications they send. The vocabulary is shared/social.ts; the service is social/service.ts.
 */
import type {
  DirectPolicy,
  NotificationKind,
  ReportReason,
  ReportStatus,
} from "@openbot/shared/social";
import {
  DIRECT_POLICIES,
  NOTIFICATION_KINDS,
  REPORT_REASONS,
  REPORT_STATUSES,
} from "@openbot/shared/social";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { spaces } from "./workspace";

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A person's public face: the handle others find them by, and who may message them. */
export const profiles = pgTable(
  "profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    bio: text("bio").notNull().default(""),
    directs: text("directs")
      .$type<DirectPolicy>()
      .notNull()
      .default("everyone"),
    createdAt: created(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("profiles_handle_idx").on(table.handle),
    check("profiles_handle_check", sql`${table.handle} ~ '^[a-z0-9_]{3,30}$'`),
    check(
      "profiles_directs_check",
      sql`${table.directs} IN (${oneOf(DIRECT_POLICIES)})`,
    ),
  ],
);

export const follows = pgTable(
  "follows",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: text("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: created(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followeeId] }),
    index("follows_followee_idx").on(table.followeeId, table.createdAt),
    check("follows_not_self", sql`${table.followerId} <> ${table.followeeId}`),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Seen only by the space's people. Null is everybody on the deployment. */
    spaceId: text("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    /** The post this comments on. */
    parentId: text("parent_id").references((): AnyPgColumn => posts.id, {
      onDelete: "cascade",
    }),
    /** The post this shares; kept as a copy below, so the share outlives it. */
    sharedPostId: text("shared_post_id").references(
      (): AnyPgColumn => posts.id,
      {
        onDelete: "set null",
      },
    ),
    sharedAuthorId: text("shared_author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sharedBody: text("shared_body"),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default([]),
    likes: integer("likes").notNull().default(0),
    comments: integer("comments").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: created(),
  },
  (table) => [
    index("posts_author_idx").on(table.authorId, table.createdAt),
    index("posts_space_idx").on(table.spaceId, table.createdAt),
    index("posts_parent_idx").on(table.parentId, table.createdAt),
    index("posts_recent_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.parentId} is null`),
    index("posts_tags_idx").using("gin", table.tags),
    index("posts_body_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.body})`,
    ),
  ],
);

export const postLikes = pgTable(
  "post_likes",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: created(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.userId] })],
);

/** A post somebody reported to the deployment's administrators, kept as it read when reported. */
export const postReports = pgTable(
  "post_reports",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").references(() => posts.id, {
      onDelete: "set null",
    }),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accusedId: text("accused_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").$type<ReportReason>().notNull(),
    note: text("note").notNull().default(""),
    body: text("body").notNull(),
    status: text("status").$type<ReportStatus>().notNull().default("open"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: created(),
  },
  (table) => [
    index("post_reports_status_idx").on(table.status, table.createdAt),
    uniqueIndex("post_reports_once_idx")
      .on(table.postId, table.reporterId)
      .where(sql`${table.status} = 'open'`),
    check(
      "post_reports_reason_check",
      sql`${table.reason} IN (${oneOf(REPORT_REASONS)})`,
    ),
    check(
      "post_reports_status_check",
      sql`${table.status} IN (${oneOf(REPORT_STATUSES)})`,
    ),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationKind>().notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: text("post_id").references(() => posts.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: created(),
  },
  (table) => [
    index("notifications_user_idx").on(table.userId, table.createdAt),
    index("notifications_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
    check(
      "notifications_kind_check",
      sql`${table.kind} IN (${oneOf(NOTIFICATION_KINDS)})`,
    ),
  ],
);
