import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelMessages,
  llmUsage,
  spaces,
  timelineCursors,
  users,
} from "../src/db/schema";
import { createTimelineFeeds } from "../src/timeline/feeds";
import { createTimeline } from "../src/timeline/service";
import { createTimelineTools } from "../src/timeline/tools";
import { WorkspaceNotFoundError } from "../src/workspace/errors";
import { createInvitations } from "../src/workspace/invitations";
import { createWorkspace } from "../src/workspace/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const workspace = createWorkspace({
  database,
  actorFor: async (id) => ({ id, role: "user" }),
  profiles: createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  ),
  auditStore: createAuditStore(database),
});
const invitations = createInvitations({ database, workspace });
const timeline = createTimeline({ database });
let clock = new Date();
const feeds = createTimelineFeeds({ database, timeline, now: () => clock });
const prefix = `timeline-${randomUUID()}`;
const people: string[] = [];
const agentIds: string[] = [];

beforeEach(async () => {
  clock = new Date();
  // Start every feed at now, so only this test's records are read.
  await database.delete(timelineCursors);
  const start = new Date(Date.now() - 1);
  await database.insert(timelineCursors).values(
    ["workspace", "messages", "usage"].map((feed) => ({
      feed,
      at: start,
      ref: "",
    })),
  );
});
afterEach(async () => {
  const ids = people.splice(0);
  await database.delete(spaces).where(inArray(spaces.createdByUserId, ids));
  await database.delete(users).where(inArray(users.id, ids));
  if (agentIds.length)
    await database.delete(agents).where(inArray(agents.id, agentIds.splice(0)));
  await database.delete(timelineCursors);
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name: string) {
  const id = `${prefix}-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name });
  people.push(id);
  return { id, email };
}

const phrases = (
  events: { subject: { name: string }; phrase: string; value: string | null }[],
) =>
  events.map(
    (event) =>
      `${event.subject.name} ${event.phrase}${event.value ? ` ${event.value}` : ""}`,
  );

describe("a space's timeline", () => {
  test("records who joined, with which role, and says what was true at a moment", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    const space = await workspace.create(ana.id, { name: "Launch" });
    const sent = await invitations.invite(ana.id, space.id, {
      email: bo.email,
      role: "member",
    });
    await invitations.accept(bo.id, { token: sent.token });
    await feeds.sync();
    const joined = new Date();
    await Bun.sleep(5);
    await workspace.setRole(ana.id, space.id, bo.id, { role: "admin" });
    await workspace.removeMember(ana.id, space.id, bo.id);
    await feeds.sync();

    const events = await timeline.read(ana.id, space.id, {});
    expect(phrases(events)).toEqual(
      expect.arrayContaining([
        "Ana created",
        "Bo has the role member",
        "Bo has the role admin",
        "Bo left",
      ]),
    );
    // At the moment Bo joined, Bo was a member with the role they were invited to.
    const then = phrases(
      await timeline.read(ana.id, space.id, { asOf: joined, about: "Bo" }),
    );
    expect(then).toEqual(
      expect.arrayContaining(["Bo is a member of", "Bo has the role member"]),
    );
    expect(then).not.toContain("Bo has the role admin");
    // Now Bo is not a member: their membership ended when they left.
    const now = phrases(
      await timeline.read(ana.id, space.id, { asOf: new Date(), about: "Bo" }),
    );
    expect(now).not.toContain("Bo is a member of");
    expect(now).toContain("Bo has the role admin");
    // Reading the same records again adds nothing.
    await database.delete(timelineCursors);
    const start = new Date(Date.now() - 60_000);
    await database.insert(timelineCursors).values(
      ["workspace", "messages", "usage"].map((feed) => ({
        feed,
        at: start,
        ref: "",
      })),
    );
    await feeds.sync();
    expect((await timeline.read(ana.id, space.id, { limit: 200 })).length).toBe(
      events.length,
    );
  });

  test("waits for a Bot's answer to finish before recording it, and records model use", async () => {
    const ana = await person("Ana");
    const space = await workspace.create(ana.id, { name: "Launch" });
    const detail = await workspace.get(ana.id, space.id);
    const room = detail.rooms[0];
    if (!room) throw new Error("A new space opens with a room.");
    const channel = await workspace.createChannel(ana.id, room.id, {
      name: "plans",
    });
    const agentId = `${prefix}-bot-${randomUUID()}`;
    await database.insert(agents).values({
      id: agentId,
      name: "Scout",
      type: "built_in",
      configuration: {},
    });
    agentIds.push(agentId);
    await database.insert(channelMessages).values([
      {
        id: `m1-${randomUUID()}`,
        channelId: channel.id,
        actorUserId: ana.id,
        text: "What  is\nnext?",
      },
    ]);
    await Bun.sleep(2);
    const answerId = `m2-${randomUUID()}`;
    await database.insert(channelMessages).values({
      id: answerId,
      channelId: channel.id,
      actorUserId: ana.id,
      agentId,
      text: "",
      status: "running",
    });
    await feeds.sync();
    let said = phrases(await timeline.read(ana.id, space.id, {}));
    expect(said).toContain("Ana said What is next?");
    expect(said.some((line) => line.startsWith("Scout"))).toBe(false);

    await database
      .update(channelMessages)
      .set({ status: "completed", text: "Shipping on Friday." })
      .where(eq(channelMessages.id, answerId));
    await database.insert(llmUsage).values({
      modelId: "m",
      modelName: "fast-chat",
      providerId: "p",
      payerUserId: ana.id,
      agentId,
      spaceId: space.id,
      purpose: "turn",
      inputTokens: 120,
      outputTokens: 30,
      cost: 7,
      status: 200,
      durationMs: 10,
    });
    await feeds.sync();
    said = phrases(await timeline.read(ana.id, space.id, {}));
    expect(said).toContain("Scout answered Shipping on Friday.");
    expect(said).toContain("Scout used 120 tokens in, 30 out");

    // A Bot in the space reads it through its tools.
    const context = { toolCallId: "t", signal: new AbortController().signal };
    const [events] = createTimelineTools(timeline, { spaceId: space.id });
    const read = (await events?.execute({ about: "fast-chat" }, context)) as {
      events: { object: { name: string } }[];
    };
    expect(read.events[0]?.object.name).toBe("fast-chat");
    const refused = (await events?.execute(
      { from: "not a date" },
      context,
    )) as {
      error: string;
    };
    expect(refused.error).toContain("Give a date");
    expect((await timeline.things(ana.id, space.id, "Scout"))[0]).toMatchObject(
      { name: "Scout", kind: "agent" },
    );
  });

  test("is shown to nobody outside the space", async () => {
    const ana = await person("Ana");
    const stranger = await person("Cy");
    const space = await workspace.create(ana.id, { name: "Launch" });
    await expect(
      timeline.read(stranger.id, space.id, {}),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});
