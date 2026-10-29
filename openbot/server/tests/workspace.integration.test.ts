import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  spaces,
  users,
} from "../src/db/schema";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "../src/workspace/errors";
import { createInvitations } from "../src/workspace/invitations";
import { createWorkspace } from "../src/workspace/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const workspace = createWorkspace({
  database,
  actorFor: async (id) => ({ id, role: "user" }),
  profiles: profileStore,
});
const invitations = createInvitations({ database, workspace });
const prefix = `workspace-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];

afterEach(async () => {
  if (createdUsers.length) {
    const ids = createdUsers.splice(0);
    await database.delete(spaces).where(inArray(spaces.createdByUserId, ids));
    await database
      .delete(channels)
      .where(inArray(channels.createdByUserId, ids));
    if (createdAgents.length) {
      const agentIds = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, agentIds));
      await database.delete(agents).where(inArray(agents.id, agentIds));
    }
    await database.delete(users).where(inArray(users.id, ids));
  }
});
afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<AgentActor & { email: string }> {
  const id = `${prefix}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name: id.slice(-6) });
  createdUsers.push(id);
  return { id, role: "user", email };
}

async function readers(channelId: string) {
  const rows = await database
    .select({ userId: channelMemberships.userId })
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));
  return rows.map((row) => row.userId).sort();
}

async function teamSpace(owner: AgentActor) {
  const space = await workspace.create(owner.id, { name: "Launch" });
  const detail = await workspace.get(owner.id, space.id);
  const room = detail.rooms[0];
  if (!room) throw new Error("A new space opens with a room.");
  return { space, room, channel: room.channels[0] };
}

describe("workspace in PostgreSQL", () => {
  test("everybody gets one home space with a room and a channel, first in their list", async () => {
    const ana = await person();
    const [first, again] = await Promise.all([
      workspace.home(ana.id),
      workspace.home(ana.id),
    ]);
    expect(first).toBe(again);
    await workspace.create(ana.id, { name: "Another" });
    const list = await workspace.list(ana.id);
    expect(list.map((space) => [space.kind, space.role])).toEqual([
      ["home", "owner"],
      ["team", "owner"],
    ]);
    const home = await workspace.get(ana.id, first);
    expect(home.rooms.map((room) => room.name)).toEqual(["General"]);
    expect(home.rooms[0]?.channels.map((channel) => channel.name)).toEqual([
      "general",
    ]);
    await expect(workspace.remove(ana.id, first)).rejects.toThrow(
      WorkspaceRefusedError,
    );
    await expect(workspace.removeMember(ana.id, first, ana.id)).rejects.toThrow(
      WorkspaceRefusedError,
    );
  });

  test("an outsider learns nothing, a member reads, and roles decide who changes what", async () => {
    const owner = await person();
    const member = await person();
    const stranger = await person();
    const { space, room } = await teamSpace(owner);
    await expect(workspace.get(stranger.id, space.id)).rejects.toThrow(
      WorkspaceNotFoundError,
    );
    await database.transaction((transaction) =>
      workspace.admit(transaction, space.id, member.id, "member", owner.id),
    );
    expect((await workspace.get(member.id, space.id)).rooms).toHaveLength(1);
    await expect(
      workspace.createRoom(member.id, space.id, { name: "Ops" }),
    ).rejects.toThrow(WorkspaceForbiddenError);
    await expect(
      workspace.setRole(member.id, space.id, owner.id, { role: "guest" }),
    ).rejects.toThrow(WorkspaceForbiddenError);
    // A member can still open channels in the room they read.
    const channel = await workspace.createChannel(member.id, room.id, {
      name: "notes",
    });
    expect(await readers(channel.id)).toEqual([member.id, owner.id].sort());
    // Promoted to admin, they manage rooms; an admin still cannot touch the owner.
    await workspace.setRole(owner.id, space.id, member.id, { role: "admin" });
    await workspace.createRoom(member.id, space.id, { name: "Ops" });
    await expect(
      workspace.removeMember(member.id, space.id, owner.id),
    ).rejects.toThrow(WorkspaceForbiddenError);
    // Handing the space over leaves the old owner an admin.
    await workspace.setRole(owner.id, space.id, member.id, { role: "owner" });
    const people = await workspace.members(owner.id, space.id);
    expect(people.map((row) => [row.userId, row.role])).toEqual([
      [member.id, "owner"],
      [owner.id, "admin"],
    ]);
  });

  test("a private room's channels are read only by the people added to it", async () => {
    const owner = await person();
    const member = await person();
    const { space } = await teamSpace(owner);
    await database.transaction((transaction) =>
      workspace.admit(transaction, space.id, member.id, "member", owner.id),
    );
    const roomId = await workspace.createRoom(owner.id, space.id, {
      name: "Board",
      visibility: "private",
    });
    const detail = await workspace.get(member.id, space.id);
    expect(detail.rooms.map((room) => room.name)).toEqual(["General"]);
    const boardChannel = (await workspace.get(owner.id, space.id)).rooms.find(
      (room) => room.id === roomId,
    )?.channels[0];
    expect(await readers(boardChannel?.id ?? "")).toEqual([owner.id]);
    await workspace.setRoomMember(owner.id, roomId, member.id, true);
    expect(await readers(boardChannel?.id ?? "")).toEqual(
      [member.id, owner.id].sort(),
    );
    // Leaving the space takes them out of the private room too.
    await workspace.removeMember(member.id, space.id, member.id);
    expect(await readers(boardChannel?.id ?? "")).toEqual([owner.id]);
    // Making the General room private keeps whoever reads it now.
    const general = detail.rooms[0];
    await workspace.updateRoom(owner.id, general?.id ?? "", {
      visibility: "private",
    });
    expect(await readers(general?.channels[0]?.id ?? "")).toEqual([owner.id]);
  });

  test("a channel's Bots come from its space, and leaving the space takes them out of it", async () => {
    const owner = await person();
    const { space, room } = await teamSpace(owner);
    const bot = await profileStore.create(owner, {
      name: "Ada",
      title: "Tester",
      roleDescription: "Answer briefly.",
      visibility: "private",
    });
    createdAgents.push(bot.id);
    await expect(
      workspace.createChannel(owner.id, room.id, {
        name: "x",
        agentIds: [bot.id],
      }),
    ).rejects.toThrow(WorkspaceRefusedError);
    await workspace.addAgent(owner.id, space.id, bot.id);
    const channel = await workspace.createChannel(owner.id, room.id, {
      name: "with-ada",
      agentIds: [bot.id],
    });
    expect(await workspace.roster(owner.id, channel.id)).toEqual([
      { id: bot.id, name: "Ada" },
    ]);
    await workspace.removeAgent(owner.id, space.id, bot.id);
    expect(await workspace.roster(owner.id, channel.id)).toEqual([]);
  });

  test("an invitation is accepted by its address, or by whoever holds its link, once", async () => {
    const owner = await person();
    const ana = await person();
    const bo = await person();
    const { space, channel } = await teamSpace(owner);
    const sent = await invitations.invite(owner.id, space.id, {
      email: ana.email.toUpperCase(),
      role: "guest",
    });
    expect(sent.invitation?.role).toBe("guest");
    // Inviting again refreshes the one waiting invitation with a new token.
    const again = await invitations.invite(owner.id, space.id, {
      email: ana.email,
    });
    expect(again.invitation?.id).toBe(sent.invitation?.id);
    expect(again.token).not.toBe(sent.token);
    await expect(
      invitations.accept(bo.id, { token: sent.token }),
    ).rejects.toThrow(WorkspaceNotFoundError);
    expect((await invitations.mine(ana.id)).map((row) => row.spaceId)).toEqual([
      space.id,
    ]);
    await expect(
      invitations.accept(bo.id, { id: again.invitation?.id ?? "" }),
    ).rejects.toThrow(WorkspaceNotFoundError);
    await invitations.accept(bo.id, { token: again.token });
    expect(await readers(channel?.id ?? "")).toContain(bo.id);
    await expect(
      invitations.accept(ana.id, { token: again.token }),
    ).rejects.toThrow(WorkspaceNotFoundError);
    // A member cannot invite; nobody invites somebody already in the space.
    await expect(
      invitations.invite(bo.id, space.id, { email: "x@example.test" }),
    ).rejects.toThrow(WorkspaceForbiddenError);
    await expect(
      invitations.invite(owner.id, space.id, { email: bo.email }),
    ).rejects.toThrow(WorkspaceRefusedError);
  });

  test("a direct conversation is one channel per pair, found from either side", async () => {
    const ana = await person();
    const bo = await person();
    const opened = await workspace.openDirect(ana.id, { userId: bo.id });
    const back = await workspace.openDirect(bo.id, { userId: ana.id });
    expect(back.id).toBe(opened.id);
    expect(opened.kind).toBe("direct");
    expect(await readers(opened.id)).toEqual([ana.id, bo.id].sort());
    const list = await workspace.directs(ana.id);
    expect(list.map((row) => [row.channelId, row.with.userId])).toEqual([
      [opened.id, bo.id],
    ]);
    expect(await workspace.roster(ana.id, opened.id)).toEqual([]);
    await expect(
      workspace.openDirect(ana.id, { userId: ana.id }),
    ).rejects.toThrow(WorkspaceRefusedError);
    const [row] = await database
      .select({ kind: channels.kind })
      .from(channels)
      .where(and(eq(channels.id, opened.id)));
    expect(row?.kind).toBe("direct");
  });
});
