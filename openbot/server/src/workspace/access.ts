/**
 * Who is where: the reads every workspace decision starts from, and the one write that keeps channel
 * membership equal to room membership.
 *
 * Everything here takes either the database or a transaction the caller holds, so a check and the
 * change it guards can share one connection and one snapshot.
 */
import {
  can,
  type Permission,
  type SpaceRole,
} from "@openbot/shared/workspace";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { channels } from "../db/schema/core";
import { rooms, spaceMembers, spaces } from "../db/schema/workspace";
import { WorkspaceForbiddenError, WorkspaceNotFoundError } from "./errors";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Reader = Database | Transaction;

/** The person's role in a live space, or null when they are not in it or it is gone. */
export async function roleIn(
  reader: Reader,
  spaceId: string,
  userId: string,
): Promise<SpaceRole | null> {
  const [row] = await reader
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(
        eq(spaceMembers.spaceId, spaceId),
        eq(spaceMembers.userId, userId),
        isNull(spaces.deletedAt),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

/**
 * The person's role, refused unless it carries `permission`. Somebody outside the space hears that
 * it was not found, whatever the truth; somebody inside without the permission is told so.
 */
export async function requirePermission(
  reader: Reader,
  spaceId: string,
  userId: string,
  permission: Permission,
): Promise<SpaceRole> {
  const role = await roleIn(reader, spaceId, userId);
  if (!role || !can(role, "space.view"))
    throw new WorkspaceNotFoundError("That space");
  if (!can(role, permission))
    throw new WorkspaceForbiddenError(
      `Your role in this space (${role}) cannot do that.`,
    );
  return role;
}

/** A live room and its space, or null. */
export async function roomById(reader: Reader, roomId: string) {
  const [row] = await reader
    .select()
    .from(rooms)
    .innerJoin(spaces, eq(spaces.id, rooms.spaceId))
    .where(
      and(
        eq(rooms.id, roomId),
        isNull(rooms.deletedAt),
        isNull(spaces.deletedAt),
      ),
    )
    .limit(1);
  return row ? { room: row.rooms, space: row.spaces } : null;
}

/**
 * The people who read a room: every member of its space for an open room, and only the members of
 * the space who were added to it for a private one.
 */
function roomReaders(roomId: string) {
  return sql`
    select sm.user_id
    from space_members sm
    join rooms r on r.space_id = sm.space_id
    where r.id = ${roomId}
      and (
        r.visibility = 'open'
        or exists (
          select 1 from room_members rm where rm.room_id = r.id and rm.user_id = sm.user_id
        )
      )`;
}

/** Whether the person reads this room, and their role in its space when they do. */
export async function roomAccess(
  reader: Reader,
  roomId: string,
  userId: string,
): Promise<{ role: SpaceRole; spaceId: string } | null> {
  const found = await roomById(reader, roomId);
  if (!found) return null;
  const role = await roleIn(reader, found.space.id, userId);
  if (!role) return null;
  const rows = await reader.execute<{ user_id: string }>(
    sql`select 1 as user_id from (${roomReaders(roomId)}) readers where readers.user_id = ${userId}`,
  );
  return rows.length > 0 ? { role, spaceId: found.space.id } : null;
}

/**
 * Make the memberships of every channel in a room equal to the room's readers.
 *
 * The one place channel membership is derived. Called in the same transaction as every change that
 * can move it: somebody joining or leaving the space, being added to or taken out of a private room,
 * a room changing visibility, a channel being made. Adds the missing and removes the extra, so it is
 * safe to call any number of times, and a person's pins and read markers survive it.
 */
export async function syncRoomChannels(
  transaction: Transaction,
  roomId: string,
): Promise<void> {
  await transaction.execute(sql`
    insert into channel_memberships (channel_id, user_id)
    select c.id, readers.user_id
    from channels c
    cross join (${roomReaders(roomId)}) readers
    where c.room_id = ${roomId} and c.deleted_at is null
    on conflict do nothing`);
  await transaction.execute(sql`
    delete from channel_memberships m
    using channels c
    where m.channel_id = c.id
      and c.room_id = ${roomId}
      and m.user_id not in (${roomReaders(roomId)})`);
}

/** The same, for every room in a space: what a change in who is in the space takes. */
export async function syncSpaceChannels(
  transaction: Transaction,
  spaceId: string,
): Promise<void> {
  const ids = await transaction
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.spaceId, spaceId), isNull(rooms.deletedAt)));
  for (const { id } of ids) await syncRoomChannels(transaction, id);
}

/** Everybody in a space, for announcing a change to them. */
export async function spaceMemberIds(
  reader: Reader,
  spaceId: string,
): Promise<string[]> {
  const rows = await reader
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId));
  return rows.map((row) => row.userId);
}

/** Where a channel is: its kind, and its room and space when it is a room's. Null when gone. */
export async function channelPlace(reader: Reader, channelId: string) {
  const [row] = await reader
    .select({
      id: channels.id,
      kind: channels.kind,
      roomId: channels.roomId,
      spaceId: rooms.spaceId,
      directKey: channels.directKey,
    })
    .from(channels)
    .leftJoin(rooms, eq(rooms.id, channels.roomId))
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
    .limit(1);
  return row ?? null;
}
