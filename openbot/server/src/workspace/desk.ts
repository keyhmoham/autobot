/**
 * A room's desk, kept and changed: one document per room, shared by every channel in it.
 *
 * Changes go through `applyDeskOp` (shared/desk.ts) and are written under a version compare, so two
 * hands moving windows at the same time each land or retry rather than one silently undoing the
 * other. Every change is announced to the room's readers with the desk's new version, so a client
 * that made the change itself skips the refetch.
 *
 * WHO MAY TOUCH IT. A person who reads the room and holds `room.desk`, or a Bot answering such a
 * person in one of the room's channels. What a window shows is checked before it is put up: a page on
 * the desk is a page somebody in the room made or may open, an app is one installed in the space, so
 * a desk cannot be used to show a room something none of its people could open themselves.
 */
import {
  applyDeskOp,
  type Desk,
  type DeskOp,
  DeskOpError,
  type DeskTarget,
  emptyDesk,
} from "@openbot/shared/desk";
import { can } from "@openbot/shared/workspace";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { announceChannelActivity } from "../channels/notifications";
import type { Database } from "../db/client";
import { roomDesks } from "../db/schema/workspace";
import { roomAccess, roomById } from "./access";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "./errors";

/** Who is changing the desk: a person, or a Bot answering one. */
export type DeskHand =
  | { kind: "person"; userId: string }
  | { kind: "agent"; agentId: string; actingFor: string };

/**
 * Whether a target may be shown in this room's space. Each kind's owner answers for its own kind (the
 * app gateway for apps, pages for pages); a kind nobody checks is allowed as the shared rules left it.
 */
export type DeskTargetCheck = (input: {
  target: DeskTarget;
  spaceId: string;
  roomId: string;
  userId: string;
}) => Promise<void>;

const MAX_ATTEMPTS = 5;

const targetSchema: z.ZodType<DeskTarget> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("app"),
    appId: z.string(),
    path: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("file"), path: z.string() }),
  z.strictObject({ kind: z.literal("computer") }),
  z.strictObject({ kind: z.literal("page"), pageId: z.string() }),
  z.strictObject({
    kind: z.literal("component"),
    name: z.string(),
    props: z.record(z.string(), z.unknown()),
  }),
]);
const rect = {
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().finite().optional(),
  h: z.number().finite().optional(),
};
const gadget = z
  .strictObject({
    shape: z.enum(["card", "squircle", "pill", "circle"]).optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
  })
  .optional();

export const deskOpSchema: z.ZodType<DeskOp> = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("open"),
    title: z.string().max(120).optional(),
    target: targetSchema,
    gadget,
    ...rect,
  }),
  z.strictObject({ op: z.literal("move"), id: z.string(), ...rect }),
  z.strictObject({ op: z.literal("focus"), id: z.string() }),
  z.strictObject({
    op: z.literal("arrange"),
    id: z.string(),
    order: z.number().int().optional(),
    shape: z.enum(["card", "squircle", "pill", "circle"]).optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
  }),
  z.strictObject({ op: z.literal("close"), id: z.string() }),
  z.strictObject({ op: z.literal("close_all") }),
  z.strictObject({ op: z.literal("pin"), id: z.string() }),
  z.strictObject({ op: z.literal("unpin"), id: z.string() }),
  z.strictObject({ op: z.literal("open_pin"), id: z.string() }),
  z.strictObject({
    op: z.literal("viewport"),
    w: z.number().finite(),
    h: z.number().finite(),
  }),
]);

export type Desks = ReturnType<typeof createDesks>;

export function createDesks(deps: {
  database: Database;
  /** Each kind of target's own check. Kinds without one are allowed as shared/desk.ts left them. */
  checks?: Partial<Record<DeskTarget["kind"], DeskTargetCheck>>;
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());

  /** The person the change is decided for, and refused unless they may use this room's desk. */
  async function authorise(roomId: string, hand: DeskHand) {
    const userId = hand.kind === "person" ? hand.userId : hand.actingFor;
    const access = await roomAccess(database, roomId, userId);
    if (!access) throw new WorkspaceNotFoundError("That room");
    if (!can(access.role, "room.desk"))
      throw new WorkspaceForbiddenError(
        "Your role in this space cannot change the room's desk.",
      );
    if (hand.kind === "agent") {
      const [inSpace] = await database.execute<{ ok: number }>(
        sql`select 1 as ok from space_agents where space_id = ${access.spaceId} and agent_id = ${hand.agentId}`,
      );
      if (!inSpace)
        throw new WorkspaceForbiddenError(
          "Only a Bot of this space can use its desks.",
        );
    }
    return { ...access, userId };
  }

  async function read(roomId: string): Promise<Desk> {
    const [row] = await database
      .select()
      .from(roomDesks)
      .where(eq(roomDesks.roomId, roomId))
      .limit(1);
    return row
      ? {
          version: row.version,
          viewport: row.viewport,
          windows: row.windows,
          pins: row.pins,
        }
      : emptyDesk();
  }

  /** The desk as a person who reads the room sees it. */
  async function get(userId: string, roomId: string): Promise<Desk> {
    if (!(await roomAccess(database, roomId, userId)))
      throw new WorkspaceNotFoundError("That room");
    return read(roomId);
  }

  /**
   * One change, by a person or a Bot, retried against a newer desk when another change landed first.
   * Returns the desk after it and the window it was about.
   */
  async function apply(roomId: string, hand: DeskHand, input: unknown) {
    const op = deskOpSchema.parse(input);
    const access = await authorise(roomId, hand);
    if (op.op === "open")
      await deps.checks?.[op.target.kind]?.({
        target: op.target,
        spaceId: access.spaceId,
        roomId,
        userId: access.userId,
      });
    const actor =
      hand.kind === "person" ? hand.userId : `agent:${hand.agentId}`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await read(roomId);
      let result: ReturnType<typeof applyDeskOp>;
      try {
        result = applyDeskOp(current, op, {
          actor,
          now: now(),
          newId: () => crypto.randomUUID().slice(0, 12),
        });
      } catch (error) {
        if (error instanceof DeskOpError)
          throw new WorkspaceRefusedError(error.message);
        throw error;
      }
      const next = { ...result.desk, version: current.version + 1 };
      const written = await database.transaction(async (transaction) => {
        const values = {
          version: next.version,
          viewport: next.viewport,
          windows: next.windows,
          pins: next.pins,
          updatedAt: now(),
        };
        const rows =
          current.version === 0
            ? await transaction
                .insert(roomDesks)
                .values({ roomId, ...values })
                .onConflictDoNothing()
                .returning({ roomId: roomDesks.roomId })
            : await transaction
                .update(roomDesks)
                .set(values)
                .where(
                  and(
                    eq(roomDesks.roomId, roomId),
                    eq(roomDesks.version, current.version),
                  ),
                )
                .returning({ roomId: roomDesks.roomId });
        if (!rows.length) return false;
        await announceDesk(transaction, roomId, next.version);
        return true;
      });
      if (written) return { desk: next, windowId: result.windowId };
    }
    throw new WorkspaceRefusedError(
      "The desk kept changing while this change was being made. Try again.",
    );
  }

  /** Tell the room's readers the desk moved on, by its version. */
  async function announceDesk(
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    roomId: string,
    version: number,
  ) {
    const found = await roomById(transaction, roomId);
    if (!found) return;
    const readers = await transaction.execute<{ user_id: string }>(sql`
      select distinct cm.user_id
      from channel_memberships cm
      join channels c on c.id = cm.channel_id
      where c.room_id = ${roomId} and c.deleted_at is null`);
    if (!readers.length) return;
    await announceChannelActivity(transaction, {
      type: "workspace",
      memberIds: readers.map((row) => row.user_id),
      spaceId: found.space.id,
      roomId,
      change: "desk",
      version,
    });
  }

  /** Whether something is shown on a room's desk now or kept pinned there: what makes it the room's. */
  async function shows(
    roomId: string,
    matches: (target: DeskTarget) => boolean,
  ) {
    const desk = await read(roomId);
    return (
      desk.windows.some((window) => matches(window.target)) ||
      desk.pins.some((pin) => matches(pin.target))
    );
  }

  return { get, apply, read, shows, authorise };
}
