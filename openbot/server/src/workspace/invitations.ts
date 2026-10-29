/**
 * Invitations into a space, and optionally straight into one of its private rooms.
 *
 * Addressed to an email, because the person asked may never have signed in here. There are two ways
 * to accept one, and both end in the same `admit`:
 *
 * - signed in as that address: the invitation is waiting in the app, and accepting needs nothing else;
 * - with the link: the token in it is the authority, for whoever is signed in when it is opened, so an
 *   invitation can be passed to a colleague who signs in with a different address.
 *
 * The token is shown once, when the invitation is made, and only its hash is kept: a database dump
 * must not be a set of working invitations. Inviting the same address again refreshes the one live
 * invitation, with a new token, rather than adding a second.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  assignableRoles,
  INVITATION_DAYS,
  type InvitationWire,
  type SpaceRole,
} from "@openbot/shared/workspace";
import { aliasedTable, and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import {
  rooms,
  roomMembers,
  spaceInvitations,
  spaces,
} from "../db/schema/workspace";
import {
  requirePermission,
  roleIn,
  roomById,
  syncRoomChannels,
} from "./access";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "./errors";
import type { Workspace } from "./service";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const inviteInput = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["admin", "member", "guest"]).default("member"),
  roomId: z.string().min(1).nullable().optional(),
});

export type Invitations = ReturnType<typeof createInvitations>;

export function createInvitations(deps: {
  database: Database;
  workspace: Pick<Workspace, "admit" | "announce" | "audit">;
  /** Tell a person who has signed in here before that an invitation is waiting. */
  notify?: (input: {
    userId: string;
    spaceName: string;
    invitedBy: string;
  }) => Promise<void>;
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());
  const inviter = aliasedTable(users, "inviter");

  async function wires(
    where: ReturnType<typeof and>,
  ): Promise<InvitationWire[]> {
    const rows = await database
      .select({
        invitation: spaceInvitations,
        spaceName: spaces.name,
        inviterId: inviter.id,
        inviterName: inviter.name,
        inviterEmail: inviter.email,
      })
      .from(spaceInvitations)
      .innerJoin(spaces, eq(spaces.id, spaceInvitations.spaceId))
      .leftJoin(inviter, eq(inviter.id, spaceInvitations.invitedByUserId))
      .where(and(where, sql`${spaces.deletedAt} is null`))
      .orderBy(desc(spaceInvitations.createdAt))
      .limit(200);
    return rows.map((row) => ({
      id: row.invitation.id,
      spaceId: row.invitation.spaceId,
      spaceName: row.spaceName,
      roomId: row.invitation.roomId,
      email: row.invitation.email,
      role: row.invitation.role,
      status: row.invitation.status,
      invitedBy: {
        userId: row.inviterId ?? "",
        name: row.inviterName,
        email: row.inviterEmail ?? "",
      },
      expiresAt: row.invitation.expiresAt.toISOString(),
      createdAt: row.invitation.createdAt.toISOString(),
    }));
  }

  /** Invite an address. Returns the invitation and its token, which is never readable again. */
  async function invite(userId: string, spaceId: string, input: unknown) {
    const body = inviteInput.parse(input);
    const token = randomBytes(24).toString("base64url");
    const id = await database.transaction(async (transaction) => {
      const role = await requirePermission(
        transaction,
        spaceId,
        userId,
        "space.invite",
      );
      if (!assignableRoles(role).includes(body.role))
        throw new WorkspaceForbiddenError(
          `You cannot invite somebody as ${body.role}.`,
        );
      const [space] = await transaction
        .select({ kind: spaces.kind })
        .from(spaces)
        .where(eq(spaces.id, spaceId));
      if (space?.kind === "home" && body.role === "admin")
        throw new WorkspaceRefusedError(
          "Nobody else administers a home space.",
        );
      if (body.roomId) {
        const room = await roomById(transaction, body.roomId);
        if (!room || room.space.id !== spaceId)
          throw new WorkspaceNotFoundError("That room");
      }
      const [already] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, body.email))
        .limit(1);
      if (
        already &&
        (await roleIn(transaction, spaceId, already.id)) &&
        !body.roomId
      )
        throw new WorkspaceRefusedError("They are already in this space.");
      const values = {
        role: body.role,
        roomId: body.roomId ?? null,
        tokenHash: hashToken(token),
        invitedByUserId: userId,
        expiresAt: new Date(now().getTime() + INVITATION_DAYS * 86_400_000),
      };
      // One live invitation per address and space: asking again refreshes it, with a new token.
      const [refreshed] = await transaction
        .update(spaceInvitations)
        .set({ ...values, createdAt: now() })
        .where(
          and(
            eq(spaceInvitations.spaceId, spaceId),
            eq(sql`lower(${spaceInvitations.email})`, body.email),
            eq(spaceInvitations.status, "pending"),
          ),
        )
        .returning({ id: spaceInvitations.id });
      const [row] = refreshed
        ? [refreshed]
        : await transaction
            .insert(spaceInvitations)
            .values({
              id: `invitation_${crypto.randomUUID()}`,
              spaceId,
              email: body.email,
              ...values,
            })
            .returning({ id: spaceInvitations.id });
      await deps.workspace.announce(transaction, spaceId, "invitations", {
        ...(already ? { also: [already.id] } : {}),
      });
      return { id: row?.id ?? "", inviteeId: already?.id ?? null };
    });
    await deps.workspace.audit("space.invitation_sent", userId, spaceId, {
      invitation: id.id,
      role: body.role,
      room: body.roomId ?? null,
    });
    if (id.inviteeId && deps.notify) {
      const [space] = await database
        .select({ name: spaces.name })
        .from(spaces)
        .where(eq(spaces.id, spaceId));
      const [me] = await database
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, userId));
      await deps
        .notify({
          userId: id.inviteeId,
          spaceName: space?.name ?? "a space",
          invitedBy: me?.name ?? me?.email ?? "Someone",
        })
        .catch(() => {});
    }
    const [wire] = await wires(eq(spaceInvitations.id, id.id));
    return { invitation: wire, token };
  }

  /** The space's invitations still waiting, for the people who may invite. */
  async function forSpace(userId: string, spaceId: string) {
    await requirePermission(database, spaceId, userId, "space.invite");
    return wires(
      and(
        eq(spaceInvitations.spaceId, spaceId),
        eq(spaceInvitations.status, "pending"),
        gt(spaceInvitations.expiresAt, now()),
      ),
    );
  }

  /** The invitations waiting for the person's own address. */
  async function mine(userId: string) {
    const [me] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!me) return [];
    return wires(
      and(
        eq(sql`lower(${spaceInvitations.email})`, me.email.toLowerCase()),
        eq(spaceInvitations.status, "pending"),
        gt(spaceInvitations.expiresAt, now()),
      ),
    );
  }

  /** What a link is an invitation to, before the person decides. */
  async function preview(token: string) {
    const [wire] = await wires(
      and(
        eq(spaceInvitations.tokenHash, hashToken(token)),
        eq(spaceInvitations.status, "pending"),
        gt(spaceInvitations.expiresAt, now()),
      ),
    );
    if (!wire) throw new WorkspaceNotFoundError("That invitation");
    return wire;
  }

  /**
   * Accept by id (the person's own address) or by token (whoever holds the link). Either way the
   * person is admitted at the invitation's role, and added to its room when it names one.
   */
  async function accept(userId: string, input: unknown) {
    const body = z
      .union([
        z.strictObject({ id: z.string().min(1) }),
        z.strictObject({ token: z.string().min(16).max(200) }),
      ])
      .parse(input);
    const result = await database.transaction(async (transaction) => {
      const [me] = await transaction
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId));
      const [invitation] = await transaction
        .select()
        .from(spaceInvitations)
        .where(
          "id" in body
            ? eq(spaceInvitations.id, body.id)
            : eq(spaceInvitations.tokenHash, hashToken(body.token)),
        )
        .for("update")
        .limit(1);
      if (
        invitation?.status !== "pending" ||
        invitation.expiresAt <= now() ||
        ("id" in body &&
          invitation.email.toLowerCase() !== me?.email.toLowerCase())
      )
        throw new WorkspaceNotFoundError("That invitation");
      const role = invitation.role as Exclude<SpaceRole, "owner">;
      await deps.workspace.admit(
        transaction,
        invitation.spaceId,
        userId,
        role,
        invitation.invitedByUserId,
      );
      if (invitation.roomId) {
        const [room] = await transaction
          .select({ visibility: rooms.visibility })
          .from(rooms)
          .where(eq(rooms.id, invitation.roomId));
        if (room?.visibility === "private") {
          await transaction
            .insert(roomMembers)
            .values({ roomId: invitation.roomId, userId })
            .onConflictDoNothing();
          await syncRoomChannels(transaction, invitation.roomId);
        }
      }
      await transaction
        .update(spaceInvitations)
        .set({
          status: "accepted",
          respondedAt: now(),
          respondedByUserId: userId,
        })
        .where(eq(spaceInvitations.id, invitation.id));
      await deps.workspace.announce(
        transaction,
        invitation.spaceId,
        "invitations",
      );
      return invitation;
    });
    await deps.workspace.audit(
      "space.invitation_accepted",
      userId,
      result.spaceId,
      {
        invitation: result.id,
        role: result.role,
      },
    );
    return { spaceId: result.spaceId, roomId: result.roomId };
  }

  async function decline(userId: string, invitationId: string) {
    const [me] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    const updated = await database
      .update(spaceInvitations)
      .set({
        status: "declined",
        respondedAt: now(),
        respondedByUserId: userId,
      })
      .where(
        and(
          eq(spaceInvitations.id, invitationId),
          eq(spaceInvitations.status, "pending"),
          eq(
            sql`lower(${spaceInvitations.email})`,
            (me?.email ?? "").toLowerCase(),
          ),
        ),
      )
      .returning({ id: spaceInvitations.id });
    if (!updated.length) throw new WorkspaceNotFoundError("That invitation");
  }

  async function revoke(userId: string, invitationId: string) {
    const spaceId = await database.transaction(async (transaction) => {
      const [invitation] = await transaction
        .select({
          spaceId: spaceInvitations.spaceId,
          status: spaceInvitations.status,
        })
        .from(spaceInvitations)
        .where(eq(spaceInvitations.id, invitationId))
        .for("update");
      if (!invitation) throw new WorkspaceNotFoundError("That invitation");
      await requirePermission(
        transaction,
        invitation.spaceId,
        userId,
        "space.invite",
      );
      if (invitation.status !== "pending")
        throw new WorkspaceRefusedError(
          "Only a waiting invitation can be withdrawn.",
        );
      await transaction
        .update(spaceInvitations)
        .set({
          status: "revoked",
          respondedAt: now(),
          respondedByUserId: userId,
        })
        .where(eq(spaceInvitations.id, invitationId));
      await deps.workspace.announce(
        transaction,
        invitation.spaceId,
        "invitations",
      );
      return invitation.spaceId;
    });
    await deps.workspace.audit("space.invitation_revoked", userId, spaceId, {
      invitation: invitationId,
    });
  }

  return { invite, forSpace, mine, preview, accept, decline, revoke };
}
