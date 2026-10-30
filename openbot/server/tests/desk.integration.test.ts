import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, spaces, users } from "../src/db/schema";
import { createDesks } from "../src/workspace/desk";
import { createDeskTools } from "../src/workspace/desk-tools";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "../src/workspace/errors";
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
const prefix = `desk-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];

afterEach(async () => {
  const ids = createdUsers.splice(0);
  if (!ids.length) return;
  await database.delete(spaces).where(inArray(spaces.createdByUserId, ids));
  const agentIds = createdAgents.splice(0);
  if (agentIds.length) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
  }
  await database.delete(users).where(inArray(users.id, ids));
});
afterAll(async () => {
  await database.$client.close();
});

async function person() {
  const id = `${prefix}-user-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  createdUsers.push(id);
  return id;
}

describe("room desks in PostgreSQL", () => {
  test("every channel of a room shares one desk, and changes at once all land", async () => {
    const owner = await person();
    const desks = createDesks({ database });
    const space = await workspace.create(owner, { name: "Studio" });
    const room = (await workspace.get(owner, space.id)).rooms[0];
    const roomId = room?.id ?? "";
    await workspace.createChannel(owner, roomId, { name: "second" });
    await Promise.all(
      ["a", "b", "c", "d"].map((pageId) =>
        desks.apply(
          roomId,
          { kind: "person", userId: owner },
          {
            op: "open",
            target: { kind: "page", pageId },
          },
        ),
      ),
    );
    const desk = await desks.get(owner, roomId);
    expect(desk.windows).toHaveLength(4);
    expect(desk.version).toBe(4);
    expect(new Set(desk.windows.map((window) => window.gadget.order))).toEqual(
      new Set([0, 1, 2, 3]),
    );
  });

  test("a guest reads the desk but cannot change it, and an outsider cannot see it", async () => {
    const owner = await person();
    const guest = await person();
    const stranger = await person();
    const desks = createDesks({ database });
    const space = await workspace.create(owner, { name: "Studio" });
    const roomId = (await workspace.get(owner, space.id)).rooms[0]?.id ?? "";
    await database.transaction((transaction) =>
      workspace.admit(transaction, space.id, guest, "guest", owner),
    );
    expect((await desks.get(guest, roomId)).windows).toEqual([]);
    await expect(
      desks.apply(
        roomId,
        { kind: "person", userId: guest },
        {
          op: "open",
          target: { kind: "computer" },
        },
      ),
    ).rejects.toThrow(WorkspaceForbiddenError);
    await expect(desks.get(stranger, roomId)).rejects.toThrow(
      WorkspaceNotFoundError,
    );
    await expect(
      desks.apply(
        roomId,
        { kind: "person", userId: owner },
        { op: "close", id: "nope" },
      ),
    ).rejects.toThrow(WorkspaceRefusedError);
  });

  test("a Bot of the space uses the desk through its tools; one outside it is refused", async () => {
    const owner = await person();
    const desks = createDesks({ database });
    const space = await workspace.create(owner, { name: "Studio" });
    const roomId = (await workspace.get(owner, space.id)).rooms[0]?.id ?? "";
    const bot = await profileStore.create(
      { id: owner, role: "user" },
      {
        name: "Ada",
        title: "Designer",
        roleDescription: "Draw things.",
        visibility: "private",
      },
    );
    createdAgents.push(bot.id);
    const tools = createDeskTools(desks, {
      channelId: "unused",
      roomId,
      spaceId: space.id,
      agentId: bot.id,
      actingFor: owner,
    });
    const run = (name: string, args: unknown) =>
      tools
        .find((tool) => tool.definition.name === name)
        ?.execute(args, {
          toolCallId: "t",
          signal: new AbortController().signal,
        });
    expect(await run("desk_open", { target: { kind: "computer" } })).toEqual({
      error: "Only a Bot of this space can use its desks.",
    });
    await workspace.addAgent(owner, space.id, bot.id);
    const opened = (await run("desk_open", {
      title: "Screen",
      target: { kind: "computer" },
    })) as { opened: string };
    expect(opened.opened).toBeString();
    const view = (await run("desk_view", {})) as {
      windows: { title: string }[];
    };
    expect(view.windows.map((window) => window.title)).toEqual(["Screen"]);
    expect((await desks.read(roomId)).windows[0]?.openedBy).toBe(
      `agent:${bot.id}`,
    );
    await run("desk_change", { op: "close_all" });
    expect((await desks.read(roomId)).windows).toEqual([]);
  });
});
