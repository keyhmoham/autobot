import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mentionsIn, tagsIn } from "@openbot/shared/social";
import { inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import { channels, spaceMembers, spaces, users } from "../src/db/schema";
import { createSocial } from "../src/social/service";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "../src/workspace/errors";
import { createWorkspace } from "../src/workspace/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const social = createSocial({
  database,
  discoverSpaces: (userId, query) => workspace.discover(userId, query),
});
const workspace = createWorkspace({
  database,
  actorFor: async (id) => ({ id, role: "user" }),
  profiles: createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  ),
  mayMessage: (from, to) => social.mayMessage(from, to),
});
const prefix = `social${randomUUID().slice(0, 6).replaceAll("-", "")}`;
const people: string[] = [];

afterEach(async () => {
  const ids = people.splice(0);
  await database.delete(spaces).where(inArray(spaces.createdByUserId, ids));
  await database.delete(channels).where(inArray(channels.createdByUserId, ids));
  await database.delete(users).where(inArray(users.id, ids));
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name: string) {
  const id = `${prefix}-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@example.test`,
    name,
  });
  people.push(id);
  const profile = await social.profile(id, id);
  return { id, handle: profile.handle };
}

describe("reading a post", () => {
  test("finds tags and mentions however they are written", () => {
    expect(tagsIn("Shipping #Launch today, #launch #v2! not#this")).toEqual([
      "launch",
      "v2",
    ]);
    expect(
      mentionsIn("Thanks @ana_b and @Bobby, mail ana@example.com"),
    ).toEqual(["ana_b", "bobby"]);
  });
});

describe("profiles", () => {
  test("every person gets a handle of their own, and can choose another one nobody has", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    expect(ana.handle).toMatch(/^ana/);
    await expect(
      social.updateProfile(bo.id, { handle: ana.handle }),
    ).rejects.toBeInstanceOf(WorkspaceRefusedError);
    await expect(
      social.updateProfile(bo.id, { handle: "admin" }),
    ).rejects.toThrow("reserved");
    const changed = await social.updateProfile(bo.id, {
      handle: `${prefix}_bo`,
      bio: "Builds things.",
    });
    expect(changed).toMatchObject({
      handle: `${prefix}_bo`,
      bio: "Builds things.",
      isYou: true,
    });
    expect((await social.profile(ana.id, `@${prefix}_bo`)).userId).toBe(bo.id);
  });

  test("following is counted from both sides and notifies the person followed", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    const seen = await social.follow(ana.id, bo.handle);
    expect(seen).toMatchObject({
      followers: 1,
      isFollowing: true,
      followsYou: false,
    });
    await social.follow(ana.id, bo.handle);
    expect((await social.profile(bo.id, ana.id)).followsYou).toBe(true);
    expect(
      (await social.connections(bo.handle, "followers")).map((p) => p.userId),
    ).toEqual([ana.id]);
    const { notifications, unread } = await social.inbox(bo.id);
    expect(unread).toBe(1);
    expect(notifications[0]).toMatchObject({
      kind: "follow",
      actor: { userId: ana.id },
    });
    await social.markRead(bo.id);
    expect((await social.inbox(bo.id)).unread).toBe(0);
    await expect(social.follow(ana.id, ana.handle)).rejects.toBeInstanceOf(
      WorkspaceRefusedError,
    );
  });
});

describe("posts", () => {
  test("a post in a space is seen only by the space's people, comments and all", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    const space = await workspace.create(ana.id, { name: "Launch" });
    const post = await social.create(ana.id, {
      body: "Plan for #launch",
      spaceId: space.id,
    });
    expect(post?.space?.name).toBe("Launch");
    await expect(social.get(bo.id, post?.id ?? "")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    await expect(
      social.create(bo.id, { body: "Sneaking in", spaceId: space.id }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(await social.feed(bo.id, "everyone")).not.toContainEqual(
      expect.objectContaining({ id: post?.id }),
    );
    await database
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: bo.id, role: "member" });
    const comment = await social.comment(bo.id, post?.id ?? "", {
      body: "Looks good",
    });
    expect(comment?.space?.id).toBe(space.id);
    expect((await social.feed(bo.id, "spaces"))[0]).toMatchObject({
      id: post?.id,
      comments: 1,
    });
  });

  test("likes, comments and shares are counted once each and tell the author", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    const post = await social.create(ana.id, { body: "Hello everyone" });
    const id = post?.id ?? "";
    await social.like(bo.id, id);
    const liked = await social.like(bo.id, id);
    expect(liked).toMatchObject({ likes: 1, likedByYou: true });
    expect(await social.unlike(bo.id, id)).toMatchObject({
      likes: 0,
      likedByYou: false,
    });
    await social.comment(bo.id, id, { body: "Hi!" });
    const shared = await social.share(bo.id, id, { body: "Worth reading" });
    expect(shared?.shared).toMatchObject({
      postId: id,
      author: { userId: ana.id },
      body: "Hello everyone",
    });
    expect(
      (await social.inbox(ana.id)).notifications.map((n) => n.kind).sort(),
    ).toEqual(["comment", "like", "share"]);
    // The share outlives the original; what was said about the original goes with it.
    await social.remove(ana.id, id);
    expect((await social.get(bo.id, shared?.id ?? ""))?.shared?.body).toBe(
      "Hello everyone",
    );
    expect((await social.inbox(ana.id)).notifications).toEqual([]);
    await expect(
      social.update(bo.id, shared?.id ?? "", { body: "x" }),
    ).resolves.toBeDefined();
    await expect(
      social.remove(ana.id, shared?.id ?? ""),
    ).rejects.toBeInstanceOf(WorkspaceForbiddenError);
  });

  test("the following feed holds your posts and the people you follow, and mentions notify", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    const cy = await person("Cy");
    await social.follow(ana.id, bo.handle);
    await social.create(bo.id, { body: `Hey @${ana.handle} see #roadmap` });
    await social.create(cy.id, { body: "Not followed" });
    await social.create(ana.id, { body: "Mine" });
    const bodies = (await social.feed(ana.id, "following")).map(
      (post) => post.body,
    );
    expect(bodies).toEqual(["Mine", `Hey @${ana.handle} see #roadmap`]);
    expect((await social.inbox(ana.id)).notifications[0]?.kind).toBe("mention");
    const found = await social.search(ana.id, "#roadmap");
    expect(found.posts.map((post) => post.author.userId)).toContain(bo.id);
    expect(
      (await social.search(ana.id, cy.handle)).people.map((p) => p.userId),
    ).toContain(cy.id);
  });
});

describe("reports", () => {
  test("a reported post can be removed by an administrator, settling every report of it", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    const cy = await person("Cy");
    const post = await social.create(ana.id, { body: "Buy cheap tokens now" });
    await social.report(bo.id, post?.id ?? "", { reason: "spam" });
    await social.report(cy.id, post?.id ?? "", {
      reason: "scam",
      note: "Link is a scam",
    });
    const open = (await social.reports("open")).filter(
      (report) => report.post.author.userId === ana.id,
    );
    expect(open).toHaveLength(2);
    await social.resolveReport(cy.id, open[0]?.id ?? "", "remove");
    expect(
      (await social.reports("open")).filter(
        (r) => r.post.author.userId === ana.id,
      ),
    ).toEqual([]);
    await expect(social.get(bo.id, post?.id ?? "")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });
});

describe("direct conversations", () => {
  test("start only as the other person allows, and stay open once started", async () => {
    const ana = await person("Ana");
    const bo = await person("Bo");
    await social.updateProfile(bo.id, { directs: "following" });
    await expect(
      workspace.openDirect(ana.id, { userId: bo.id }),
    ).rejects.toBeInstanceOf(WorkspaceForbiddenError);
    await social.follow(bo.id, ana.handle);
    expect((await social.profile(ana.id, bo.id)).canMessage).toBe(true);
    const direct = await workspace.openDirect(ana.id, { userId: bo.id });
    await social.updateProfile(bo.id, { directs: "nobody" });
    expect((await workspace.openDirect(ana.id, { userId: bo.id })).id).toBe(
      direct.id,
    );
  });
});
