/**
 * Spaces, rooms and channels: making them, finding them, and deciding who is in them.
 *
 * Every operation names the person asking and is decided against their role in the space
 * (shared/workspace.ts `can`). Every change that can move who reads a channel ends with
 * `syncRoomChannels` in the same transaction, so `channel_memberships`, which every channel route
 * already checks, never disagrees with the rooms and spaces it is derived from. Every change is
 * announced to the space's members as a `workspace` event, carrying what to refetch and nothing else.
 */
import {
  type ChannelColour,
  type ChannelIcon,
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  MAX_CHANNEL_NAME,
  MAX_CHANNEL_PURPOSE,
} from "@openbot/shared/channel-look";
import {
  assignableRoles,
  can,
  type ChannelWire,
  MAX_DESCRIPTION,
  MAX_ROOM_NAME,
  MAX_SPACE_NAME,
  type MemberWire,
  outranks,
  ROOM_VISIBILITIES,
  type RoomWire,
  SPACE_ROLES,
  SPACE_VISIBILITIES,
  type SpaceRole,
  type SpaceWire,
} from "@openbot/shared/workspace";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import type { WorkspaceChange } from "../channels/events";
import { announceChannelActivity } from "../channels/notifications";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  users,
} from "../db/schema/core";
import { openduetChannels } from "../db/schema/openduet";
import {
  roomMembers,
  rooms,
  spaceAgents,
  spaceMembers,
  spaces,
} from "../db/schema/workspace";
import {
  channelPlace,
  type Reader,
  requirePermission,
  roleIn,
  roomAccess,
  roomById,
  spaceMemberIds,
  syncRoomChannels,
  syncSpaceChannels,
  type Transaction,
} from "./access";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "./errors";

const icon = z.enum(CHANNEL_ICONS);
const colour = z.enum(CHANNEL_COLOURS);
const spaceInput = z.strictObject({
  name: z.string().trim().min(1).max(MAX_SPACE_NAME),
  description: z.string().trim().max(MAX_DESCRIPTION).default(""),
  icon: icon.default("people"),
  colour: colour.default("lavender"),
  visibility: z.enum(SPACE_VISIBILITIES).default("private"),
});
const roomInput = z.strictObject({
  name: z.string().trim().min(1).max(MAX_ROOM_NAME),
  topic: z.string().trim().max(MAX_DESCRIPTION).default(""),
  icon: icon.default("folder"),
  colour: colour.default("sky"),
  visibility: z.enum(ROOM_VISIBILITIES).default("open"),
});
const channelInput = z.strictObject({
  name: z.string().trim().min(1).max(MAX_CHANNEL_NAME),
  purpose: z.string().trim().max(MAX_CHANNEL_PURPOSE).default(""),
  icon: icon.default("folder"),
  colour: colour.default("sky"),
  agentIds: z.array(z.string().min(1)).max(20).default([]),
});

/** The first room every space opens with, so a new space is somewhere to talk at once. */
const FIRST_ROOM = { name: "General", icon: "people", colour: "sky" } as const;
/** The first channel every room opens with. */
const FIRST_CHANNEL = { name: "general", icon: "folder" } as const;

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export type WorkspaceDeps = {
  database: Database;
  /** The person as the Bot roster sees them, for deciding which Bots they may use. */
  actorFor: (userId: string) => Promise<AgentActor>;
  profiles: Pick<AgentProfileStore, "get">;
  auditStore?: AuditStore;
  /**
   * Start a channel's first turn: its Bots saying hello and offering where to begin. Absent, a new
   * channel opens silent.
   */
  greet?: (input: {
    actorUserId: string;
    channelId: string;
    name: string;
    purpose: string;
  }) => Promise<void>;
  now?: () => Date;
};

export type Workspace = ReturnType<typeof createWorkspace>;

export function createWorkspace(deps: WorkspaceDeps) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());

  async function audit(
    eventType: AuditEventType,
    actorUserId: string,
    spaceId: string,
    payload: Record<string, unknown> = {},
  ) {
    if (!deps.auditStore) return;
    await recordAuditEvent(deps.auditStore, {
      eventType,
      targetType: "space",
      targetId: spaceId,
      actorUserId,
      payload,
    });
  }

  /** Tell everybody in a space what to refetch. Inside the transaction, so a rollback says nothing. */
  async function announce(
    reader: Reader,
    spaceId: string,
    change: WorkspaceChange,
    extra: { roomId?: string; also?: string[] } = {},
  ) {
    const memberIds = [
      ...new Set([
        ...(await spaceMemberIds(reader, spaceId)),
        ...(extra.also ?? []),
      ]),
    ];
    if (!memberIds.length) return;
    await announceChannelActivity(reader, {
      type: "workspace",
      memberIds,
      spaceId,
      change,
      ...(extra.roomId ? { roomId: extra.roomId } : {}),
    });
  }

  /* ---------------------------------------------------------------- spaces */

  /** Make a space with its owner, its first room and that room's first channel. */
  async function makeSpace(
    transaction: Transaction,
    ownerUserId: string,
    input: z.infer<typeof spaceInput> & { home?: boolean },
  ) {
    const id = newId("space");
    await transaction.insert(spaces).values({
      id,
      createdByUserId: ownerUserId,
      name: input.name,
      description: input.description,
      icon: input.icon,
      colour: input.colour,
      kind: input.home ? "home" : "team",
      visibility: input.home ? "private" : input.visibility,
      homeOfUserId: input.home ? ownerUserId : null,
    });
    await transaction
      .insert(spaceMembers)
      .values({ spaceId: id, userId: ownerUserId, role: "owner" });
    await makeRoom(transaction, ownerUserId, id, {
      ...FIRST_ROOM,
      topic: "",
      visibility: "open",
    });
    return id;
  }

  /** The person's home space, made the first time they ask for it. */
  async function home(userId: string): Promise<string> {
    const [found] = await database
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.homeOfUserId, userId))
      .limit(1);
    if (found) return found.id;
    return database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`space:home:${userId}`}))`,
      );
      const [again] = await transaction
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.homeOfUserId, userId))
        .limit(1);
      if (again) return again.id;
      return makeSpace(transaction, userId, {
        name: "Home",
        description:
          "Your own space. Only you are in it unless you invite someone.",
        icon: "home",
        colour: "sky",
        visibility: "private",
        home: true,
      });
    });
  }

  async function spaceWire(
    reader: Reader,
    spaceId: string,
    userId: string,
  ): Promise<SpaceWire> {
    const [row] = await reader
      .select({
        space: spaces,
        role: sql<SpaceRole | null>`(select ${spaceMembers.role} from ${spaceMembers} where ${spaceMembers.spaceId} = ${spaces.id} and ${spaceMembers.userId} = ${userId})`,
        memberCount: sql<number>`(select count(*)::int from ${spaceMembers} where ${spaceMembers.spaceId} = ${spaces.id})`,
      })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
      .limit(1);
    if (!row) throw new WorkspaceNotFoundError("That space");
    return toSpaceWire(row.space, row.role, row.memberCount);
  }

  /** The spaces the person is in, their home first and the rest by name. */
  async function list(userId: string): Promise<SpaceWire[]> {
    await home(userId);
    const rows = await database
      .select({
        space: spaces,
        role: spaceMembers.role,
        memberCount: sql<number>`(select count(*)::int from ${spaceMembers} m where m.space_id = ${spaces.id})`,
      })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.userId, userId), isNull(spaces.deletedAt)))
      .orderBy(
        sql`${spaces.kind} = 'home' desc`,
        asc(sql`lower(${spaces.name})`),
        asc(spaces.id),
      );
    return rows.map((row) => toSpaceWire(row.space, row.role, row.memberCount));
  }

  /** Public team spaces the person can join, newest first, optionally matching a name. */
  async function discover(userId: string, query = ""): Promise<SpaceWire[]> {
    const rows = await database
      .select({
        space: spaces,
        memberCount: sql<number>`(select count(*)::int from ${spaceMembers} m where m.space_id = ${spaces.id})`,
      })
      .from(spaces)
      .where(
        and(
          eq(spaces.visibility, "public"),
          isNull(spaces.deletedAt),
          sql`not exists (select 1 from ${spaceMembers} m where m.space_id = ${spaces.id} and m.user_id = ${userId})`,
          query.trim()
            ? ilike(spaces.name, `%${query.trim().replace(/[%_\\]/g, "\\$&")}%`)
            : undefined,
        ),
      )
      .orderBy(desc(spaces.createdAt))
      .limit(50);
    return rows.map((row) => toSpaceWire(row.space, null, row.memberCount));
  }

  /** One space as the person sees it, with the rooms they read and the channels in them. */
  async function get(
    userId: string,
    spaceId: string,
  ): Promise<SpaceWire & { rooms: RoomWire[] }> {
    const space = await spaceWire(database, spaceId, userId);
    if (!space.role) {
      if (space.visibility !== "public")
        throw new WorkspaceNotFoundError("That space");
      return { ...space, rooms: [] };
    }
    return { ...space, rooms: await roomsFor(database, spaceId, userId) };
  }

  async function create(userId: string, input: unknown): Promise<SpaceWire> {
    const body = spaceInput.parse(input);
    const id = await database.transaction((transaction) =>
      makeSpace(transaction, userId, body),
    );
    await audit("space.created", userId, id, { name: body.name });
    return spaceWire(database, id, userId);
  }

  async function update(
    userId: string,
    spaceId: string,
    input: unknown,
  ): Promise<SpaceWire> {
    const patch = spaceInput.partial().parse(input);
    await database.transaction(async (transaction) => {
      await requirePermission(transaction, spaceId, userId, "space.edit");
      const [space] = await transaction
        .select({ kind: spaces.kind })
        .from(spaces)
        .where(eq(spaces.id, spaceId));
      if (space?.kind === "home" && patch.visibility === "public")
        throw new WorkspaceRefusedError("A home space cannot be made public.");
      await transaction
        .update(spaces)
        .set({ ...patch, updatedAt: now() })
        .where(eq(spaces.id, spaceId));
      await announce(transaction, spaceId, "space");
    });
    await audit("space.updated", userId, spaceId, {
      fields: Object.keys(patch),
    });
    return spaceWire(database, spaceId, userId);
  }

  async function remove(userId: string, spaceId: string): Promise<void> {
    await database.transaction(async (transaction) => {
      await requirePermission(transaction, spaceId, userId, "space.delete");
      const [space] = await transaction
        .select({ kind: spaces.kind })
        .from(spaces)
        .where(eq(spaces.id, spaceId));
      if (space?.kind === "home")
        throw new WorkspaceRefusedError("Your home space cannot be deleted.");
      await announce(transaction, spaceId, "space");
      await transaction
        .update(spaces)
        .set({ deletedAt: now(), updatedAt: now() })
        .where(eq(spaces.id, spaceId));
      // Its conversations go with it, for everybody, the way a deleted channel does.
      await transaction
        .update(channels)
        .set({ deletedAt: now() })
        .where(
          inArray(
            channels.roomId,
            transaction
              .select({ id: rooms.id })
              .from(rooms)
              .where(eq(rooms.spaceId, spaceId)),
          ),
        );
    });
    await audit("space.deleted", userId, spaceId);
  }

  /* --------------------------------------------------------------- members */

  async function members(
    userId: string,
    spaceId: string,
  ): Promise<MemberWire[]> {
    await requirePermission(database, spaceId, userId, "space.view");
    const rows = await database
      .select({
        userId: spaceMembers.userId,
        email: users.email,
        name: users.name,
        image: users.image,
        role: spaceMembers.role,
        joinedAt: spaceMembers.joinedAt,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, spaceId))
      .orderBy(
        sql`array_position(array[${sql.raw(SPACE_ROLES.map((role) => `'${role}'`).join(","))}]::text[], ${spaceMembers.role})`,
        asc(users.email),
      );
    return rows.map((row) => ({
      ...row,
      joinedAt: row.joinedAt.toISOString(),
    }));
  }

  /**
   * Put a person in a space at a role, within a transaction the caller holds. Someone already in it
   * keeps the higher of the two roles: an invitation never demotes anybody.
   */
  async function admit(
    transaction: Transaction,
    spaceId: string,
    userId: string,
    role: Exclude<SpaceRole, "owner">,
    invitedByUserId: string | null,
  ) {
    const current = await roleIn(transaction, spaceId, userId);
    if (current && !outranks(role, current)) return current;
    await transaction
      .insert(spaceMembers)
      .values({ spaceId, userId, role, invitedByUserId })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: { role },
      });
    await syncSpaceChannels(transaction, spaceId);
    await announce(transaction, spaceId, "members");
    return role;
  }

  /** Join a public team space as a member. */
  async function join(userId: string, spaceId: string): Promise<SpaceWire> {
    await database.transaction(async (transaction) => {
      const [space] = await transaction
        .select({ visibility: spaces.visibility, kind: spaces.kind })
        .from(spaces)
        .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
        .for("update");
      if (space?.visibility !== "public" || space.kind !== "team")
        throw new WorkspaceNotFoundError("That space");
      await admit(transaction, spaceId, userId, "member", null);
    });
    await audit("space.member_added", userId, spaceId, {
      member: userId,
      how: "joined",
    });
    return spaceWire(database, spaceId, userId);
  }

  /** Take a person out, everywhere in the space: its rooms, its channels and its private rooms. */
  async function evict(
    transaction: Transaction,
    spaceId: string,
    userId: string,
  ) {
    await announce(transaction, spaceId, "members");
    await transaction
      .delete(spaceMembers)
      .where(
        and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)),
      );
    await transaction
      .delete(roomMembers)
      .where(
        and(
          eq(roomMembers.userId, userId),
          inArray(
            roomMembers.roomId,
            transaction
              .select({ id: rooms.id })
              .from(rooms)
              .where(eq(rooms.spaceId, spaceId)),
          ),
        ),
      );
    await syncSpaceChannels(transaction, spaceId);
  }

  async function setRole(
    userId: string,
    spaceId: string,
    memberId: string,
    input: unknown,
  ): Promise<void> {
    const { role } = z.strictObject({ role: z.enum(SPACE_ROLES) }).parse(input);
    await database.transaction(async (transaction) => {
      const mine = await requirePermission(
        transaction,
        spaceId,
        userId,
        "space.manage_members",
      );
      const theirs = await roleIn(transaction, spaceId, memberId);
      if (!theirs) throw new WorkspaceNotFoundError("That member");
      if (memberId === userId)
        throw new WorkspaceRefusedError("You cannot change your own role.");
      if (role === "owner") {
        // Handing the space over: only its owner can, and they stay on as an admin.
        if (mine !== "owner")
          throw new WorkspaceForbiddenError(
            "Only the owner can hand the space over.",
          );
        const [space] = await transaction
          .select({ kind: spaces.kind })
          .from(spaces)
          .where(eq(spaces.id, spaceId));
        if (space?.kind === "home")
          throw new WorkspaceRefusedError("A home space stays its person's.");
        await transaction
          .update(spaceMembers)
          .set({ role: "admin" })
          .where(
            and(
              eq(spaceMembers.spaceId, spaceId),
              eq(spaceMembers.userId, userId),
            ),
          );
      } else if (
        !outranks(mine, theirs) ||
        !assignableRoles(mine).includes(role)
      ) {
        throw new WorkspaceForbiddenError(
          "You can only change the role of people below you, to a role you hold or below.",
        );
      }
      await transaction
        .update(spaceMembers)
        .set({ role })
        .where(
          and(
            eq(spaceMembers.spaceId, spaceId),
            eq(spaceMembers.userId, memberId),
          ),
        );
      await announce(transaction, spaceId, "members");
    });
    await audit("space.member_role_changed", userId, spaceId, {
      member: memberId,
      role,
    });
  }

  async function removeMember(
    userId: string,
    spaceId: string,
    memberId: string,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      if (memberId === userId) {
        const mine = await roleIn(transaction, spaceId, userId);
        if (!mine) throw new WorkspaceNotFoundError("That space");
        const [space] = await transaction
          .select({ kind: spaces.kind })
          .from(spaces)
          .where(eq(spaces.id, spaceId));
        if (space?.kind === "home")
          throw new WorkspaceRefusedError("You cannot leave your home space.");
        if (mine === "owner") {
          const [other] = await transaction
            .select({ userId: spaceMembers.userId })
            .from(spaceMembers)
            .where(
              and(
                eq(spaceMembers.spaceId, spaceId),
                ne(spaceMembers.userId, userId),
              ),
            )
            .limit(1);
          if (other)
            throw new WorkspaceRefusedError(
              "Hand the space to someone else before you leave it.",
            );
        }
      } else {
        const mine = await requirePermission(
          transaction,
          spaceId,
          userId,
          "space.manage_members",
        );
        const theirs = await roleIn(transaction, spaceId, memberId);
        if (!theirs) throw new WorkspaceNotFoundError("That member");
        if (!outranks(mine, theirs))
          throw new WorkspaceForbiddenError(
            "You can only take out people below you in this space.",
          );
      }
      await evict(transaction, spaceId, memberId);
    });
    await audit("space.member_removed", userId, spaceId, { member: memberId });
  }

  /* ------------------------------------------------------------------ bots */

  async function agents(userId: string, spaceId: string) {
    await requirePermission(database, spaceId, userId, "space.view");
    const actor = await deps.actorFor(userId);
    const rows = await database
      .select({ agentId: spaceAgents.agentId, addedAt: spaceAgents.addedAt })
      .from(spaceAgents)
      .where(eq(spaceAgents.spaceId, spaceId))
      .orderBy(asc(spaceAgents.addedAt));
    return Promise.all(
      rows.map(async (row) => {
        const profile = await deps.profiles.get(actor, row.agentId);
        return {
          id: row.agentId,
          name: profile?.name ?? "A Bot you cannot use",
          title: profile?.title ?? "",
          avatarSeed: profile?.avatarSeed ?? row.agentId,
          // Whether this person may run it. A Bot somebody else added may be private to them.
          available: !!profile && !profile.deletedAt,
          addedAt: row.addedAt.toISOString(),
        };
      }),
    );
  }

  async function addAgent(userId: string, spaceId: string, agentId: string) {
    const profile = await deps.profiles.get(
      await deps.actorFor(userId),
      agentId,
    );
    await database.transaction(async (transaction) => {
      await requirePermission(
        transaction,
        spaceId,
        userId,
        "space.manage_bots",
      );
      if (!profile || profile.deletedAt)
        throw new WorkspaceNotFoundError("That Bot");
      await transaction
        .insert(spaceAgents)
        .values({ spaceId, agentId, addedByUserId: userId })
        .onConflictDoNothing();
      await announce(transaction, spaceId, "agents");
    });
    await audit("space.agent_added", userId, spaceId, { agent: agentId });
  }

  async function removeAgent(userId: string, spaceId: string, agentId: string) {
    await database.transaction(async (transaction) => {
      await requirePermission(
        transaction,
        spaceId,
        userId,
        "space.manage_bots",
      );
      await transaction
        .delete(spaceAgents)
        .where(
          and(
            eq(spaceAgents.spaceId, spaceId),
            eq(spaceAgents.agentId, agentId),
          ),
        );
      // Out of the space is out of every channel in it.
      await transaction
        .delete(channelAgents)
        .where(
          and(
            eq(channelAgents.agentId, agentId),
            inArray(
              channelAgents.channelId,
              transaction
                .select({ id: channels.id })
                .from(channels)
                .innerJoin(rooms, eq(rooms.id, channels.roomId))
                .where(eq(rooms.spaceId, spaceId)),
            ),
          ),
        );
      await announce(transaction, spaceId, "agents");
    });
    await audit("space.agent_removed", userId, spaceId, { agent: agentId });
  }

  /** Refused unless every Bot named is one of the space's. */
  async function requireSpaceAgents(
    reader: Reader,
    spaceId: string,
    agentIds: readonly string[],
  ) {
    if (!agentIds.length) return;
    const rows = await reader
      .select({ agentId: spaceAgents.agentId })
      .from(spaceAgents)
      .where(
        and(
          eq(spaceAgents.spaceId, spaceId),
          inArray(spaceAgents.agentId, [...agentIds]),
        ),
      );
    if (rows.length !== new Set(agentIds).size)
      throw new WorkspaceRefusedError(
        "A channel's Bots are chosen from its space's Bots. Add the Bot to the space first.",
      );
  }

  /* ----------------------------------------------------------------- rooms */

  async function makeRoom(
    transaction: Transaction,
    userId: string,
    spaceId: string,
    input: z.infer<typeof roomInput>,
  ) {
    const id = newId("room");
    const [last] = await transaction
      .select({ position: sql<number>`coalesce(max(${rooms.position}), -1)` })
      .from(rooms)
      .where(eq(rooms.spaceId, spaceId));
    await transaction.insert(rooms).values({
      id,
      spaceId,
      name: input.name,
      topic: input.topic,
      icon: input.icon,
      colour: input.colour,
      visibility: input.visibility,
      position: (last?.position ?? -1) + 1,
      createdByUserId: userId,
    });
    if (input.visibility === "private")
      await transaction.insert(roomMembers).values({ roomId: id, userId });
    await makeChannel(transaction, userId, id, {
      name: FIRST_CHANNEL.name,
      purpose: "",
      icon: FIRST_CHANNEL.icon,
      colour: input.colour,
      agentIds: [],
    });
    return id;
  }

  async function createRoom(userId: string, spaceId: string, input: unknown) {
    const body = roomInput.parse(input);
    const id = await database.transaction(async (transaction) => {
      await requirePermission(
        transaction,
        spaceId,
        userId,
        "space.manage_rooms",
      );
      const id = await makeRoom(transaction, userId, spaceId, body);
      await announce(transaction, spaceId, "rooms", { roomId: id });
      return id;
    });
    await audit("room.created", userId, spaceId, { room: id, name: body.name });
    return id;
  }

  /** A room the person reads and may manage, refused otherwise. */
  async function manageableRoom(
    reader: Reader,
    userId: string,
    roomId: string,
  ) {
    const found = await roomById(reader, roomId);
    if (!found) throw new WorkspaceNotFoundError("That room");
    const access = await roomAccess(reader, roomId, userId);
    if (!access) throw new WorkspaceNotFoundError("That room");
    if (!can(access.role, "space.manage_rooms"))
      throw new WorkspaceForbiddenError(
        "Your role in this space cannot change its rooms.",
      );
    return found;
  }

  async function updateRoom(userId: string, roomId: string, input: unknown) {
    const patch = roomInput
      .partial()
      .extend({ archived: z.boolean().optional() })
      .parse(input);
    const { archived, ...fields } = patch;
    const spaceId = await database.transaction(async (transaction) => {
      const { room } = await manageableRoom(transaction, userId, roomId);
      await transaction
        .update(rooms)
        .set({
          ...fields,
          ...(archived === undefined
            ? {}
            : { archivedAt: archived ? now() : null }),
          updatedAt: now(),
        })
        .where(eq(rooms.id, roomId));
      // Going private keeps the people who were reading it, so nobody is locked out by surprise.
      if (fields.visibility === "private" && room.visibility === "open")
        await transaction.execute(sql`
          insert into room_members (room_id, user_id)
          select ${roomId}, cm.user_id from channel_memberships cm
          join channels c on c.id = cm.channel_id
          where c.room_id = ${roomId}
          on conflict do nothing`);
      await syncRoomChannels(transaction, roomId);
      await announce(transaction, room.spaceId, "rooms", { roomId });
      return room.spaceId;
    });
    await audit("room.updated", userId, spaceId, {
      room: roomId,
      fields: Object.keys(patch),
    });
  }

  async function deleteRoom(userId: string, roomId: string) {
    const spaceId = await database.transaction(async (transaction) => {
      const { room } = await manageableRoom(transaction, userId, roomId);
      const [others] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(rooms)
        .where(
          and(
            eq(rooms.spaceId, room.spaceId),
            isNull(rooms.deletedAt),
            ne(rooms.id, roomId),
          ),
        );
      if (!others?.count)
        throw new WorkspaceRefusedError("A space keeps at least one room.");
      await transaction
        .update(rooms)
        .set({ deletedAt: now(), updatedAt: now() })
        .where(eq(rooms.id, roomId));
      await transaction
        .update(channels)
        .set({ deletedAt: now() })
        .where(eq(channels.roomId, roomId));
      await announce(transaction, room.spaceId, "rooms", { roomId });
      return room.spaceId;
    });
    await audit("room.deleted", userId, spaceId, { room: roomId });
  }

  async function reorderRooms(userId: string, spaceId: string, input: unknown) {
    const { roomIds } = z
      .strictObject({ roomIds: z.array(z.string().min(1)).max(500) })
      .parse(input);
    await database.transaction(async (transaction) => {
      await requirePermission(
        transaction,
        spaceId,
        userId,
        "space.manage_rooms",
      );
      for (const [position, id] of roomIds.entries())
        await transaction
          .update(rooms)
          .set({ position })
          .where(and(eq(rooms.id, id), eq(rooms.spaceId, spaceId)));
      await announce(transaction, spaceId, "rooms");
    });
  }

  /** Add a member of the space to a private room, or take them out of it. */
  async function setRoomMember(
    userId: string,
    roomId: string,
    memberId: string,
    present: boolean,
  ) {
    const spaceId = await database.transaction(async (transaction) => {
      const { room } = await manageableRoom(transaction, userId, roomId);
      if (room.visibility !== "private")
        throw new WorkspaceRefusedError(
          "Everybody in the space is in an open room. Make it private to choose who is.",
        );
      if (present) {
        if (!(await roleIn(transaction, room.spaceId, memberId)))
          throw new WorkspaceRefusedError("Invite them to the space first.");
        await transaction
          .insert(roomMembers)
          .values({ roomId, userId: memberId })
          .onConflictDoNothing();
      } else {
        await transaction
          .delete(roomMembers)
          .where(
            and(
              eq(roomMembers.roomId, roomId),
              eq(roomMembers.userId, memberId),
            ),
          );
      }
      await syncRoomChannels(transaction, roomId);
      await announce(transaction, room.spaceId, "rooms", {
        roomId,
        also: [memberId],
      });
      return room.spaceId;
    });
    await audit(
      present ? "room.member_added" : "room.member_removed",
      userId,
      spaceId,
      {
        room: roomId,
        member: memberId,
      },
    );
  }

  async function roomPeople(userId: string, roomId: string) {
    const access = await roomAccess(database, roomId, userId);
    if (!access) throw new WorkspaceNotFoundError("That room");
    const rows = await database.execute<{
      user_id: string;
      email: string;
      name: string | null;
      image: string | null;
    }>(sql`
      select distinct u.id as user_id, u.email, u.name, u.image
      from channel_memberships cm
      join channels c on c.id = cm.channel_id
      join users u on u.id = cm.user_id
      where c.room_id = ${roomId} and c.deleted_at is null
      order by u.email`);
    return rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      name: row.name,
      image: row.image,
    }));
  }

  /* -------------------------------------------------------------- channels */

  async function makeChannel(
    transaction: Transaction,
    userId: string,
    roomId: string,
    input: z.infer<typeof channelInput>,
  ) {
    const id = newId("channel");
    await transaction.insert(channels).values({
      id,
      kind: "room",
      roomId,
      createdByUserId: userId,
      name: input.name,
      description: input.purpose,
    });
    await transaction
      .insert(openduetChannels)
      .values({ channelId: id, icon: input.icon, colour: input.colour });
    // One at a time, a millisecond apart, so the order they were chosen in is the order they answer.
    const base = now().getTime();
    for (const [index, agentId] of input.agentIds.entries())
      await transaction
        .insert(channelAgents)
        .values({ channelId: id, agentId, createdAt: new Date(base + index) });
    await syncRoomChannels(transaction, roomId);
    return id;
  }

  async function createChannel(userId: string, roomId: string, input: unknown) {
    const body = channelInput.parse(input);
    const { id, spaceId } = await database.transaction(async (transaction) => {
      const access = await roomAccess(transaction, roomId, userId);
      if (!access) throw new WorkspaceNotFoundError("That room");
      if (!can(access.role, "room.create_channel"))
        throw new WorkspaceForbiddenError(
          "Your role in this space cannot open channels.",
        );
      await requireSpaceAgents(transaction, access.spaceId, body.agentIds);
      const id = await makeChannel(transaction, userId, roomId, body);
      await announce(transaction, access.spaceId, "rooms", { roomId });
      return { id, spaceId: access.spaceId };
    });
    await audit("channel.created", userId, spaceId, {
      room: roomId,
      channel: id,
    });
    if (body.agentIds.length)
      await deps
        .greet?.({
          actorUserId: userId,
          channelId: id,
          name: body.name,
          purpose: body.purpose,
        })
        .catch((error: unknown) =>
          console.error(
            JSON.stringify({
              type: "channel-greeting-failed",
              channelId: id,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    return channelWire(database, id, userId);
  }

  /**
   * A room channel the person may change: its maker can, and so can whoever manages the space's
   * rooms. Everybody else in the room only talks in it.
   */
  async function manageableChannel(
    reader: Reader,
    userId: string,
    channelId: string,
  ) {
    const place = await channelPlace(reader, channelId);
    if (place?.kind !== "room" || !place.roomId || !place.spaceId)
      throw new WorkspaceNotFoundError("That channel");
    const access = await roomAccess(reader, place.roomId, userId);
    if (!access) throw new WorkspaceNotFoundError("That channel");
    const [row] = await reader
      .select({ createdBy: channels.createdByUserId })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (row?.createdBy !== userId && !can(access.role, "room.manage_channels"))
      throw new WorkspaceForbiddenError(
        "Only the person who opened this channel, or someone who manages the space, can change it.",
      );
    return { ...place, roomId: place.roomId, spaceId: place.spaceId };
  }

  async function updateChannel(
    userId: string,
    channelId: string,
    input: unknown,
  ) {
    const patch = channelInput
      .partial()
      .extend({ archived: z.boolean().optional() })
      .parse(input);
    const { agentIds, archived, name, purpose, icon, colour } = patch;
    const place = await database.transaction(async (transaction) => {
      const place = await manageableChannel(transaction, userId, channelId);
      if (name !== undefined || purpose !== undefined)
        await transaction
          .update(channels)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(purpose !== undefined ? { description: purpose } : {}),
            updatedAt: now(),
          })
          .where(eq(channels.id, channelId));
      if (icon || colour || archived !== undefined)
        await transaction
          .update(openduetChannels)
          .set({
            ...(icon ? { icon } : {}),
            ...(colour ? { colour } : {}),
            ...(archived === undefined
              ? {}
              : { archivedAt: archived ? now() : null }),
            updatedAt: now(),
          })
          .where(eq(openduetChannels.channelId, channelId));
      if (agentIds) {
        await requireSpaceAgents(transaction, place.spaceId, agentIds);
        await transaction
          .delete(channelAgents)
          .where(
            and(
              eq(channelAgents.channelId, channelId),
              agentIds.length
                ? notInArray(channelAgents.agentId, agentIds)
                : undefined,
            ),
          );
        const base = now().getTime();
        for (const [index, agentId] of agentIds.entries())
          await transaction
            .insert(channelAgents)
            .values({ channelId, agentId, createdAt: new Date(base + index) })
            .onConflictDoNothing();
      }
      await announce(transaction, place.spaceId, "rooms", {
        roomId: place.roomId,
      });
      return place;
    });
    await audit("channel.updated", userId, place.spaceId, {
      channel: channelId,
      fields: Object.keys(patch),
    });
    return channelWire(database, channelId, userId);
  }

  async function deleteChannel(userId: string, channelId: string) {
    const place = await database.transaction(async (transaction) => {
      const place = await manageableChannel(transaction, userId, channelId);
      await transaction
        .update(channels)
        .set({ deletedAt: now(), updatedAt: now() })
        .where(eq(channels.id, channelId));
      await announce(transaction, place.spaceId, "rooms", {
        roomId: place.roomId,
      });
      return place;
    });
    await audit("channel.deleted", userId, place.spaceId, {
      channel: channelId,
      mechanism: "workspace",
    });
  }

  /** Stamp the person's membership of a shared channel as read now. */
  async function markRead(userId: string, channelId: string) {
    const updated = await database
      .update(channelMemberships)
      .set({ lastReadAt: now() })
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, userId),
        ),
      )
      .returning({ channelId: channelMemberships.channelId });
    if (!updated.length) throw new WorkspaceNotFoundError("That channel");
  }

  /* ---------------------------------------------------------------- direct */

  /** The conversation between two people, made the first time either opens it. */
  async function openDirect(userId: string, input: unknown) {
    const { userId: otherId } = z
      .strictObject({ userId: z.string().min(1) })
      .parse(input);
    if (otherId === userId)
      throw new WorkspaceRefusedError(
        "A direct conversation is with somebody else.",
      );
    const [other] = await database
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, otherId))
      .limit(1);
    if (!other) throw new WorkspaceNotFoundError("That person");
    const directKey = [userId, otherId].sort().join(":");
    const id = await database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .where(eq(channels.directKey, directKey))
        .limit(1);
      if (existing) {
        // A conversation either person put away comes back when either opens it again.
        if (existing.deletedAt)
          await transaction
            .update(channels)
            .set({ deletedAt: null })
            .where(eq(channels.id, existing.id));
        return existing.id;
      }
      const id = newId("channel");
      await transaction.insert(channels).values({
        id,
        kind: "direct",
        directKey,
        createdByUserId: userId,
        name: "Direct message",
        description: "",
      });
      await transaction.insert(channelMemberships).values([
        { channelId: id, userId },
        { channelId: id, userId: otherId },
      ]);
      return id;
    });
    return channelWire(database, id, userId);
  }

  /** The person's direct conversations, latest first, each with the person it is with. */
  async function directs(userId: string) {
    const rows = await database.execute<{
      id: string;
      other_id: string;
      other_name: string | null;
      other_email: string;
      other_image: string | null;
      last_message: string | null;
      last_message_at: Date | null;
      last_read_at: Date | null;
      created_at: Date;
    }>(sql`
      select c.id, u.id as other_id, u.name as other_name, u.email as other_email,
             u.image as other_image, c.last_message, c.last_message_at, mine.last_read_at,
             c.created_at
      from channels c
      join channel_memberships mine on mine.channel_id = c.id and mine.user_id = ${userId}
      join channel_memberships theirs on theirs.channel_id = c.id and theirs.user_id <> ${userId}
      join users u on u.id = theirs.user_id
      where c.kind = 'direct' and c.deleted_at is null
      order by coalesce(c.last_message_at, c.created_at) desc
      limit 200`);
    return rows.map((row) => ({
      channelId: row.id,
      with: {
        userId: row.other_id,
        name: row.other_name,
        email: row.other_email,
        image: row.other_image,
      },
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at
        ? new Date(row.last_message_at).toISOString()
        : null,
      unread: isUnread(row.last_message_at, row.last_read_at),
    }));
  }

  /* ------------------------------------------- for the conversation engine */

  /**
   * The Bots that answer `userId` in a shared channel, in the order they joined it, or null when the
   * person is not in it or it is not a shared channel. A Bot the person may not use is left out
   * rather than run as them.
   */
  async function roster(userId: string, channelId: string) {
    const place = await channelPlace(database, channelId);
    if (!place || (place.kind !== "room" && place.kind !== "direct"))
      return null;
    const [member] = await database
      .select({ userId: channelMemberships.userId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, userId),
        ),
      )
      .limit(1);
    if (!member) return null;
    const ids = await database
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, channelId))
      .orderBy(asc(channelAgents.createdAt), asc(channelAgents.agentId));
    const actor = await deps.actorFor(userId);
    const bots: { id: string; name: string }[] = [];
    for (const { agentId } of ids) {
      const profile = await deps.profiles.get(actor, agentId);
      if (profile && !profile.deletedAt)
        bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  }

  /** Where a channel is and what it is for, in words a Bot is told. */
  async function describe(channelId: string): Promise<string | null> {
    const [row] = await database
      .select({
        kind: channels.kind,
        name: channels.name,
        purpose: channels.description,
        room: rooms.name,
        topic: rooms.topic,
        space: spaces.name,
      })
      .from(channels)
      .leftJoin(rooms, eq(rooms.id, channels.roomId))
      .leftJoin(spaces, eq(spaces.id, rooms.spaceId))
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!row) return null;
    if (row.kind === "direct")
      return "This is a direct conversation between two people.";
    return [
      `This is the channel #${row.name} in the room "${row.room}" of the space "${row.space}".`,
      row.purpose.trim() ? `It is for: ${row.purpose.trim()}` : "",
      row.topic?.trim() ? `The room is about: ${row.topic.trim()}` : "",
      "Everyone in the room shares its desk and the space's computer.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** The space a channel is in, for binding its turns to the space's computer and desk. */
  async function spaceOf(
    channelId: string,
  ): Promise<{ spaceId: string; roomId: string } | null> {
    const place = await channelPlace(database, channelId);
    return place?.spaceId && place.roomId
      ? { spaceId: place.spaceId, roomId: place.roomId }
      : null;
  }

  /* -------------------------------------------------------------- reading */

  async function roomsFor(
    reader: Reader,
    spaceId: string,
    userId: string,
  ): Promise<RoomWire[]> {
    const roomRows = await reader
      .select()
      .from(rooms)
      .where(and(eq(rooms.spaceId, spaceId), isNull(rooms.deletedAt)))
      .orderBy(asc(rooms.position), asc(rooms.createdAt));
    const channelRows = await channelRowsFor(reader, userId, {
      roomIds: roomRows.map((room) => room.id),
    });
    const role = await roleIn(reader, spaceId, userId);
    return roomRows
      .filter(
        (room) =>
          room.visibility === "open" ||
          can(role, "space.manage_rooms") ||
          channelRows.some((channel) => channel.roomId === room.id),
      )
      .map((room) => ({
        id: room.id,
        spaceId: room.spaceId,
        name: room.name,
        topic: room.topic,
        icon: room.icon,
        colour: room.colour,
        visibility: room.visibility,
        position: room.position,
        archivedAt: room.archivedAt?.toISOString() ?? null,
        createdAt: room.createdAt.toISOString(),
        channels: channelRows.filter((channel) => channel.roomId === room.id),
      }));
  }

  async function channelRowsFor(
    reader: Reader,
    userId: string,
    filter: { roomIds?: string[]; channelId?: string },
  ): Promise<ChannelWire[]> {
    if (filter.roomIds && !filter.roomIds.length) return [];
    const rows = await reader
      .select({
        id: channels.id,
        kind: channels.kind,
        roomId: channels.roomId,
        name: channels.name,
        purpose: channels.description,
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
        createdAt: channels.createdAt,
        lastReadAt: channelMemberships.lastReadAt,
        icon: openduetChannels.icon,
        colour: openduetChannels.colour,
        archivedAt: openduetChannels.archivedAt,
        agentIds: sql<
          string[]
        >`coalesce((select array_agg(a.agent_id order by a.created_at, a.agent_id) from ${channelAgents} a where a.channel_id = ${channels.id}), '{}')`,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, userId),
        ),
      )
      .leftJoin(openduetChannels, eq(openduetChannels.channelId, channels.id))
      .where(
        and(
          isNull(channels.deletedAt),
          filter.roomIds ? inArray(channels.roomId, filter.roomIds) : undefined,
          filter.channelId ? eq(channels.id, filter.channelId) : undefined,
        ),
      )
      .orderBy(asc(channels.createdAt), asc(channels.id));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      roomId: row.roomId,
      name: row.name,
      purpose: row.purpose.trim() || null,
      icon: (row.icon ?? "folder") as ChannelIcon,
      colour: (row.colour ?? "sky") as ChannelColour,
      agentIds: row.agentIds,
      lastMessage: row.lastMessage,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      unread: isUnread(row.lastMessageAt, row.lastReadAt),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function channelWire(
    reader: Reader,
    channelId: string,
    userId: string,
  ) {
    const [channel] = await channelRowsFor(reader, userId, { channelId });
    if (!channel) throw new WorkspaceNotFoundError("That channel");
    return channel;
  }

  /** One channel the person is in, with the room and space it is in. */
  async function channel(userId: string, channelId: string) {
    const wire = await channelWire(database, channelId, userId);
    const place = await channelPlace(database, channelId);
    return {
      ...wire,
      spaceId: place?.spaceId ?? null,
      role: place?.spaceId
        ? await roleIn(database, place.spaceId, userId)
        : null,
    };
  }

  return {
    home,
    list,
    discover,
    get,
    create,
    update,
    remove,
    members,
    admit,
    join,
    setRole,
    removeMember,
    agents,
    addAgent,
    removeAgent,
    createRoom,
    updateRoom,
    deleteRoom,
    reorderRooms,
    setRoomMember,
    roomPeople,
    createChannel,
    updateChannel,
    deleteChannel,
    channel,
    markRead,
    openDirect,
    directs,
    roster,
    describe,
    spaceOf,
    audit,
    announce,
  };
}

function isUnread(lastMessageAt: Date | null, lastReadAt: Date | null) {
  if (!lastMessageAt) return false;
  return (
    !lastReadAt ||
    new Date(lastMessageAt).getTime() > new Date(lastReadAt).getTime()
  );
}

function toSpaceWire(
  space: typeof spaces.$inferSelect,
  role: SpaceRole | null,
  memberCount: number,
): SpaceWire {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    icon: space.icon,
    colour: space.colour,
    kind: space.kind,
    visibility: space.visibility,
    role,
    memberCount,
    createdAt: space.createdAt.toISOString(),
  };
}
