/**
 * Spaces, rooms, the people and Bots in them, the invitations that bring people in, and each room's
 * desk. The shapes and the permission model are shared/workspace.ts; the service is
 * workspace/service.ts.
 *
 * WHO IS IN A CHANNEL IS STILL `channel_memberships`. Every route that reads or writes a channel
 * already resolves the caller there, so a room does not add a second answer to that question: the
 * workspace service keeps a room's channels' memberships equal to the room's members, in the same
 * transaction as every change to either. What lives here is who is in a space and a room, which is
 * what those memberships are derived from.
 */
import {
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  type ChannelColour,
  type ChannelIcon,
} from "@openbot/shared/channel-look";
import type { DeskPin, DeskViewport, DeskWindow } from "@openbot/shared/desk";
import {
  INVITATION_STATUSES,
  type InvitationStatus,
  ROOM_VISIBILITIES,
  type RoomVisibility,
  SPACE_KINDS,
  SPACE_ROLES,
  SPACE_VISIBILITIES,
  type SpaceKind,
  type SpaceRole,
  type SpaceVisibility,
} from "@openbot/shared/workspace";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** The SQL list a check constraint keeps a column to, from one of the shared sets. */
const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const spaces = pgTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    /** Who made it. Ownership itself is the `owner` role in `space_members`, which can move. */
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    icon: text("icon").$type<ChannelIcon>().notNull(),
    colour: text("colour").$type<ChannelColour>().notNull(),
    kind: text("kind").$type<SpaceKind>().notNull(),
    visibility: text("visibility")
      .$type<SpaceVisibility>()
      .notNull()
      .default("private"),
    /**
     * The person a home space belongs to. Null on a team space. A column rather than a lookup of the
     * owner role, so "one home each" is a unique index the database keeps rather than a rule code
     * must remember.
     */
    homeOfUserId: text("home_of_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("spaces_home_of_user_idx")
      .on(table.homeOfUserId)
      .where(sql`${table.homeOfUserId} is not null`),
    index("spaces_public_idx")
      .on(table.createdAt)
      .where(
        sql`${table.visibility} = 'public' and ${table.deletedAt} is null`,
      ),
    check("spaces_kind_check", sql`${table.kind} IN (${oneOf(SPACE_KINDS)})`),
    check(
      "spaces_visibility_check",
      sql`${table.visibility} IN (${oneOf(SPACE_VISIBILITIES)})`,
    ),
    check("spaces_icon_check", sql`${table.icon} IN (${oneOf(CHANNEL_ICONS)})`),
    check(
      "spaces_colour_check",
      sql`${table.colour} IN (${oneOf(CHANNEL_COLOURS)})`,
    ),
    check(
      "spaces_home_has_person_check",
      sql`(${table.kind} = 'home') = (${table.homeOfUserId} is not null)`,
    ),
  ],
);

export const spaceMembers = pgTable(
  "space_members",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<SpaceRole>().notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index("space_members_user_idx").on(table.userId),
    check(
      "space_members_role_check",
      sql`${table.role} IN (${oneOf(SPACE_ROLES)})`,
    ),
  ],
);

/**
 * The Bots a space works with. A channel in the space picks its Bots from these, so adding a Bot to a
 * space is the one decision that lets it into the space's rooms and onto the space's computer.
 */
export const spaceAgents = pgTable(
  "space_agents",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.agentId] }),
    index("space_agents_agent_idx").on(table.agentId),
  ],
);

export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    topic: text("topic").notNull().default(""),
    icon: text("icon").$type<ChannelIcon>().notNull(),
    colour: text("colour").$type<ChannelColour>().notNull(),
    visibility: text("visibility")
      .$type<RoomVisibility>()
      .notNull()
      .default("open"),
    /** Where the room sits in its space's list. Ties fall back to when it was made. */
    position: integer("position").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("rooms_space_idx").on(table.spaceId, table.position),
    check(
      "rooms_visibility_check",
      sql`${table.visibility} IN (${oneOf(ROOM_VISIBILITIES)})`,
    ),
    check("rooms_icon_check", sql`${table.icon} IN (${oneOf(CHANNEL_ICONS)})`),
    check(
      "rooms_colour_check",
      sql`${table.colour} IN (${oneOf(CHANNEL_COLOURS)})`,
    ),
  ],
);

/** The people added to a private room. An open room has no rows here: it is its space's. */
export const roomMembers = pgTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index("room_members_user_idx").on(table.userId),
  ],
);

/**
 * An invitation into a space, optionally straight into one private room.
 *
 * Addressed to an email rather than a user id, because the person asked may never have signed in
 * here. Accepted by the person whose verified address it is, signed in, or with the link's token,
 * which is stored hashed: a database dump must not be a set of working invitations.
 */
export const spaceInvitations = pgTable(
  "space_invitations",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<SpaceRole>().notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status")
      .$type<InvitationStatus>()
      .notNull()
      .default("pending"),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    respondedByUserId: text("responded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("space_invitations_token_idx").on(table.tokenHash),
    index("space_invitations_email_idx").on(
      sql`lower(${table.email})`,
      table.status,
    ),
    // One live invitation per address and space: asking again refreshes it rather than adding one.
    uniqueIndex("space_invitations_pending_idx")
      .on(table.spaceId, sql`lower(${table.email})`)
      .where(sql`${table.status} = 'pending'`),
    check(
      "space_invitations_status_check",
      sql`${table.status} IN (${oneOf(INVITATION_STATUSES)})`,
    ),
    check(
      "space_invitations_role_check",
      sql`${table.role} IN ('admin', 'member', 'guest')`,
    ),
  ],
);

/**
 * A room's desk: the windows open on it and the ones kept pinned, shared by every channel in the room.
 *
 * One row per room, written whole under a version: the desk is a small document changed a window at a
 * time, and a version compare makes two hands moving windows at once each land or retry rather than
 * one silently undoing the other. The geometry rules are shared/desk.ts, applied on the server only.
 */
export const roomDesks = pgTable("room_desks", {
  roomId: text("room_id")
    .primaryKey()
    .references(() => rooms.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  viewport: jsonb("viewport")
    .$type<DeskViewport>()
    .notNull()
    .default({ w: 0, h: 0 }),
  windows: jsonb("windows").$type<DeskWindow[]>().notNull().default([]),
  pins: jsonb("pins").$type<DeskPin[]>().notNull().default([]),
  updatedAt: updatedAt(),
});
