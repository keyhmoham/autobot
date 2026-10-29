/**
 * The social side: profiles and follows, posts and what people do to them, the feeds, the explore
 * page, reports, and the notifications all of it sends.
 *
 * Who sees a post is decided in one place (`visibleTo`): a post to everybody is seen by everybody
 * signed in here, a post into a space only by the space's people, and a comment wherever its parent
 * is. Every read goes through it, the feeds and search included, so nothing is reachable by a route
 * that forgot to ask. Refusals reuse the workspace's three errors, so "not found" is also what
 * somebody outside a space hears about a post in it.
 */
import {
  DIRECT_POLICIES,
  type FeedKind,
  HANDLE_PATTERN,
  MAX_BIO_LENGTH,
  MAX_POST_LENGTH,
  mentionsIn,
  type NotificationKind,
  type NotificationWire,
  type PersonRefWire,
  type PostWire,
  type ProfileWire,
  REPORT_REASONS,
  type ReportWire,
  tagsIn,
} from "@openbot/shared/social";
import {
  and,
  arrayContains,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { announceChannelActivity } from "../channels/notifications";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import {
  follows,
  notifications,
  postLikes,
  postReports,
  posts,
  profiles,
} from "../db/schema/social";
import { spaceMembers, spaces } from "../db/schema/workspace";
import type { Transaction } from "../workspace/access";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "../workspace/errors";

type Reader = Database | Transaction;

const RESERVED_HANDLES = new Set([
  "admin",
  "administrator",
  "openduet",
  "openbot",
  "support",
  "system",
  "everyone",
  "here",
]);

const profilePatch = z.strictObject({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      HANDLE_PATTERN,
      "A handle is 3 to 30 letters, digits or underscores.",
    )
    .optional(),
  bio: z.string().trim().max(MAX_BIO_LENGTH).optional(),
  directs: z.enum(DIRECT_POLICIES).optional(),
});

const body = z
  .string()
  .trim()
  .min(1, "Write something first.")
  .max(MAX_POST_LENGTH, `A post is at most ${MAX_POST_LENGTH} characters.`);

const postInput = z.strictObject({
  body,
  spaceId: z.string().min(1).nullable().optional(),
});

const shareInput = z.strictObject({
  body: z.string().trim().max(MAX_POST_LENGTH).default(""),
  spaceId: z.string().min(1).nullable().optional(),
});

const reportInput = z.strictObject({
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(1_000).default(""),
});

type PostRow = typeof posts.$inferSelect;

export type Social = ReturnType<typeof createSocial>;

export function createSocial(deps: {
  database: Database;
  /** Spaces anybody may find and join, for the explore page. */
  discoverSpaces?: (
    userId: string,
    query: string,
  ) => Promise<
    { id: string; name: string; description: string; memberCount?: number }[]
  >;
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());

  /* ------------------------------------------------------------- profiles */

  /** A handle nobody holds yet, made from what the person is called. */
  async function freeHandle(reader: Reader, seed: string) {
    const base =
      seed
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24)
        .padEnd(3, "0") || "person";
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate =
        attempt === 0 && !RESERVED_HANDLES.has(base)
          ? base
          : `${base.slice(0, 24)}_${Math.floor(Math.random() * 10_000)}`;
      const [taken] = await reader
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.handle, candidate));
      if (!taken) return candidate;
    }
    return `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  }

  /** The person's profile, made the first time anybody looks for it. */
  async function ensureProfiles(userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    const have = new Set(
      (
        await database
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(inArray(profiles.userId, ids))
      ).map((row) => row.userId),
    );
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length === 0) return;
    const people = await database
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, missing));
    for (const person of people)
      for (let attempt = 0; attempt < 3; attempt++) {
        const handle = await freeHandle(
          database,
          person.email.split("@")[0] ?? person.name ?? "person",
        );
        // Two first looks at once race for the same handle: the loser picks again.
        const made = await database
          .insert(profiles)
          .values({ userId: person.id, handle })
          .onConflictDoNothing()
          .returning({ userId: profiles.userId });
        if (made.length > 0) break;
        const [exists] = await database
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(eq(profiles.userId, person.id));
        if (exists) break;
      }
  }

  async function refs(userIds: string[]): Promise<Map<string, PersonRefWire>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    await ensureProfiles(ids);
    const rows = await database
      .select({
        userId: users.id,
        handle: profiles.handle,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(inArray(users.id, ids));
    return new Map(
      rows.map((row) => [
        row.userId,
        {
          userId: row.userId,
          handle: row.handle,
          name: row.name ?? row.handle,
          image: row.image,
        },
      ]),
    );
  }

  async function userByHandle(handleOrId: string) {
    const key = handleOrId.replace(/^@/, "").toLowerCase();
    const [row] = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(or(eq(profiles.handle, key), eq(profiles.userId, handleOrId)));
    if (row) return row.userId;
    const [person] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, handleOrId));
    if (!person) throw new WorkspaceNotFoundError("That person");
    return person.id;
  }

  async function isFollowing(followerId: string, followeeId: string) {
    const [row] = await database
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, followerId),
          eq(follows.followeeId, followeeId),
        ),
      );
    return Boolean(row);
  }

  /** Whether `fromUserId` may start a direct conversation with `toUserId`, by the latter's choice. */
  async function mayMessage(fromUserId: string, toUserId: string) {
    await ensureProfiles([toUserId]);
    const [row] = await database
      .select({ directs: profiles.directs })
      .from(profiles)
      .where(eq(profiles.userId, toUserId));
    if (!row || row.directs === "everyone") return true;
    if (row.directs === "nobody") return false;
    return isFollowing(toUserId, fromUserId);
  }

  async function profile(
    viewerId: string,
    handleOrId: string,
  ): Promise<ProfileWire> {
    const userId = await userByHandle(handleOrId);
    const ref = (await refs([userId])).get(userId);
    if (!ref) throw new WorkspaceNotFoundError("That person");
    const [row] = await database
      .select({ bio: profiles.bio, directs: profiles.directs })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const count = async (
      where: SQL | undefined,
      table: typeof follows | typeof posts,
    ) =>
      (
        await database
          .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
          .from(table)
          .where(where)
      )[0]?.count ?? 0;
    const isYou = viewerId === userId;
    return {
      ...ref,
      bio: row?.bio ?? "",
      directs: row?.directs ?? "everyone",
      followers: await count(eq(follows.followeeId, userId), follows),
      following: await count(eq(follows.followerId, userId), follows),
      posts: await count(
        and(
          eq(posts.authorId, userId),
          isNull(posts.parentId),
          isNull(posts.spaceId),
        ),
        posts,
      ),
      isFollowing: !isYou && (await isFollowing(viewerId, userId)),
      followsYou: !isYou && (await isFollowing(userId, viewerId)),
      canMessage: !isYou && (await mayMessage(viewerId, userId)),
      isYou,
    };
  }

  async function updateProfile(userId: string, input: unknown) {
    const patch = profilePatch.parse(input);
    await ensureProfiles([userId]);
    if (patch.handle) {
      if (RESERVED_HANDLES.has(patch.handle))
        throw new WorkspaceRefusedError("That handle is reserved.");
      const [taken] = await database
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(
          and(eq(profiles.handle, patch.handle), ne(profiles.userId, userId)),
        );
      if (taken)
        throw new WorkspaceRefusedError("Somebody already has that handle.");
    }
    await database
      .update(profiles)
      .set({ ...patch, updatedAt: now() })
      .where(eq(profiles.userId, userId));
    return profile(userId, userId);
  }

  /* -------------------------------------------------------------- follows */

  async function follow(userId: string, handleOrId: string) {
    const followeeId = await userByHandle(handleOrId);
    if (followeeId === userId)
      throw new WorkspaceRefusedError("You cannot follow yourself.");
    const made = await database
      .insert(follows)
      .values({ followerId: userId, followeeId })
      .onConflictDoNothing()
      .returning({ followeeId: follows.followeeId });
    if (made.length > 0) await notify(followeeId, "follow", userId, null);
    return profile(userId, followeeId);
  }

  async function unfollow(userId: string, handleOrId: string) {
    const followeeId = await userByHandle(handleOrId);
    await database
      .delete(follows)
      .where(
        and(eq(follows.followerId, userId), eq(follows.followeeId, followeeId)),
      );
    return profile(userId, followeeId);
  }

  /** Who follows somebody, or whom they follow, newest first. */
  async function connections(
    handleOrId: string,
    direction: "followers" | "following",
    page: { before?: string; limit?: number } = {},
  ) {
    const userId = await userByHandle(handleOrId);
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
    const mine =
      direction === "followers" ? follows.followeeId : follows.followerId;
    const theirs =
      direction === "followers" ? follows.followerId : follows.followeeId;
    const rows = await database
      .select({ id: theirs, createdAt: follows.createdAt })
      .from(follows)
      .where(
        and(
          eq(mine, userId),
          page.before
            ? lt(follows.createdAt, new Date(page.before))
            : undefined,
        ),
      )
      .orderBy(desc(follows.createdAt))
      .limit(limit);
    const people = await refs(rows.map((row) => row.id));
    return rows.flatMap((row) => {
      const person = people.get(row.id);
      return person ? [{ ...person, since: row.createdAt.toISOString() }] : [];
    });
  }

  /* ---------------------------------------------------------------- posts */

  async function mySpaces(userId: string) {
    return (
      await database
        .select({ spaceId: spaceMembers.spaceId })
        .from(spaceMembers)
        .where(eq(spaceMembers.userId, userId))
    ).map((row) => row.spaceId);
  }

  /** The condition a post must meet for `userId` to see it. */
  function visibleTo(spaceIds: string[]) {
    return spaceIds.length
      ? or(isNull(posts.spaceId), inArray(posts.spaceId, spaceIds))
      : isNull(posts.spaceId);
  }

  /** A post the person can see, or not found. */
  async function visiblePost(userId: string, postId: string) {
    const [row] = await database
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), visibleTo(await mySpaces(userId))));
    if (!row) throw new WorkspaceNotFoundError("That post");
    return row;
  }

  async function wires(viewerId: string, rows: PostRow[]): Promise<PostWire[]> {
    if (rows.length === 0) return [];
    const people = await refs(
      rows.flatMap((row) => [
        row.authorId,
        ...(row.sharedAuthorId ? [row.sharedAuthorId] : []),
      ]),
    );
    const spaceIds = [
      ...new Set(rows.flatMap((row) => (row.spaceId ? [row.spaceId] : []))),
    ];
    const spaceNames = new Map(
      spaceIds.length
        ? (
            await database
              .select({ id: spaces.id, name: spaces.name })
              .from(spaces)
              .where(inArray(spaces.id, spaceIds))
          ).map((row) => [row.id, row.name])
        : [],
    );
    const liked = new Set(
      (
        await database
          .select({ postId: postLikes.postId })
          .from(postLikes)
          .where(
            and(
              eq(postLikes.userId, viewerId),
              inArray(
                postLikes.postId,
                rows.map((row) => row.id),
              ),
            ),
          )
      ).map((row) => row.postId),
    );
    const gone: PersonRefWire = {
      userId: "",
      handle: "",
      name: "Somebody",
      image: null,
    };
    return rows.map((row) => ({
      id: row.id,
      author: people.get(row.authorId) ?? gone,
      space: row.spaceId
        ? { id: row.spaceId, name: spaceNames.get(row.spaceId) ?? "A space" }
        : null,
      parentId: row.parentId,
      body: row.body,
      tags: row.tags,
      shared:
        row.sharedBody !== null && row.sharedAt
          ? {
              postId: row.sharedPostId,
              author:
                (row.sharedAuthorId && people.get(row.sharedAuthorId)) || gone,
              body: row.sharedBody,
              createdAt: row.sharedAt.toISOString(),
            }
          : null,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      likedByYou: liked.has(row.id),
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Refused unless the person may post into the space they named. */
  async function postingInto(
    userId: string,
    spaceId: string | null | undefined,
  ) {
    if (!spaceId) return null;
    if (!(await mySpaces(userId)).includes(spaceId))
      throw new WorkspaceNotFoundError("That space");
    return spaceId;
  }

  /** Tell the people a post mentions, who can see it, that it does. */
  async function notifyMentions(row: PostRow) {
    const handles = mentionsIn(row.body);
    if (handles.length === 0) return;
    const mentioned = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(inArray(profiles.handle, handles));
    for (const { userId } of mentioned) {
      if (userId === row.authorId) continue;
      if (row.spaceId && !(await mySpaces(userId)).includes(row.spaceId))
        continue;
      await notify(userId, "mention", row.authorId, row.id);
    }
  }

  async function create(userId: string, input: unknown) {
    const { body: text, spaceId } = postInput.parse(input);
    await ensureProfiles([userId]);
    const [row] = await database
      .insert(posts)
      .values({
        id: `post_${crypto.randomUUID()}`,
        authorId: userId,
        spaceId: await postingInto(userId, spaceId),
        body: text,
        tags: tagsIn(text),
      })
      .returning();
    if (!row) throw new Error("The post was not saved.");
    await notifyMentions(row);
    return (await wires(userId, [row]))[0];
  }

  async function get(userId: string, postId: string) {
    return (await wires(userId, [await visiblePost(userId, postId)]))[0];
  }

  async function update(userId: string, postId: string, input: unknown) {
    const { body: text } = z.strictObject({ body }).parse(input);
    const row = await visiblePost(userId, postId);
    if (row.authorId !== userId)
      throw new WorkspaceForbiddenError("Only its author can change a post.");
    const [updated] = await database
      .update(posts)
      .set({ body: text, tags: tagsIn(text), editedAt: now() })
      .where(eq(posts.id, postId))
      .returning();
    if (!updated) throw new WorkspaceNotFoundError("That post");
    return (await wires(userId, [updated]))[0];
  }

  /** Remove a post: by its author, or by an administrator acting on a report. */
  async function remove(userId: string, postId: string, asAdmin = false) {
    const row = asAdmin
      ? (await database.select().from(posts).where(eq(posts.id, postId)))[0]
      : await visiblePost(userId, postId);
    if (!row) throw new WorkspaceNotFoundError("That post");
    if (!asAdmin && row.authorId !== userId)
      throw new WorkspaceForbiddenError("Only its author can remove a post.");
    await database.transaction(async (tx) => {
      await tx.delete(posts).where(eq(posts.id, postId));
      if (row.parentId)
        await tx
          .update(posts)
          .set({ comments: sql`greatest(${posts.comments} - 1, 0)` })
          .where(eq(posts.id, row.parentId));
    });
  }

  async function like(userId: string, postId: string) {
    const row = await visiblePost(userId, postId);
    const added = await database.transaction(async (tx) => {
      const made = await tx
        .insert(postLikes)
        .values({ postId, userId })
        .onConflictDoNothing()
        .returning({ postId: postLikes.postId });
      if (made.length)
        await tx
          .update(posts)
          .set({ likes: sql`${posts.likes} + 1` })
          .where(eq(posts.id, postId));
      return made.length > 0;
    });
    if (added && row.authorId !== userId)
      await notify(row.authorId, "like", userId, postId);
    return get(userId, postId);
  }

  async function unlike(userId: string, postId: string) {
    await visiblePost(userId, postId);
    await database.transaction(async (tx) => {
      const gone = await tx
        .delete(postLikes)
        .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, userId)))
        .returning({ postId: postLikes.postId });
      if (gone.length)
        await tx
          .update(posts)
          .set({ likes: sql`greatest(${posts.likes} - 1, 0)` })
          .where(eq(posts.id, postId));
    });
    return get(userId, postId);
  }

  /** Comment on a post: a post of its own, seen wherever its parent is. */
  async function comment(userId: string, postId: string, input: unknown) {
    const { body: text } = z.strictObject({ body }).parse(input);
    const parent = await visiblePost(userId, postId);
    if (parent.parentId)
      throw new WorkspaceRefusedError(
        "Reply to the post itself, not to a comment.",
      );
    await ensureProfiles([userId]);
    const row = await database.transaction(async (tx) => {
      const [made] = await tx
        .insert(posts)
        .values({
          id: `post_${crypto.randomUUID()}`,
          authorId: userId,
          spaceId: parent.spaceId,
          parentId: parent.id,
          body: text,
          tags: tagsIn(text),
        })
        .returning();
      await tx
        .update(posts)
        .set({ comments: sql`${posts.comments} + 1` })
        .where(eq(posts.id, parent.id));
      return made;
    });
    if (!row) throw new Error("The comment was not saved.");
    if (parent.authorId !== userId)
      await notify(parent.authorId, "comment", userId, parent.id);
    await notifyMentions(row);
    return (await wires(userId, [row]))[0];
  }

  async function comments(
    userId: string,
    postId: string,
    page: { before?: string } = {},
  ) {
    await visiblePost(userId, postId);
    const rows = await database
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.parentId, postId),
          page.before ? lt(posts.createdAt, new Date(page.before)) : undefined,
        ),
      )
      .orderBy(desc(posts.createdAt))
      .limit(100);
    return wires(userId, rows.reverse());
  }

  /**
   * Share a post, with a word of one's own. The share carries a copy of what it shares, so it reads
   * the same after the original is gone. A post in a space is shared only within that space.
   */
  async function share(userId: string, postId: string, input: unknown) {
    const { body: text, spaceId } = shareInput.parse(input);
    const original = await visiblePost(userId, postId);
    if (original.parentId)
      throw new WorkspaceRefusedError("Share the post itself, not a comment.");
    const into = await postingInto(userId, spaceId);
    if (original.spaceId && into !== original.spaceId)
      throw new WorkspaceRefusedError(
        "A post in a space can only be shared inside that space.",
      );
    // Sharing a share shares what it shared.
    const source = original.sharedBody !== null ? original : null;
    await ensureProfiles([userId]);
    const row = await database.transaction(async (tx) => {
      const [made] = await tx
        .insert(posts)
        .values({
          id: `post_${crypto.randomUUID()}`,
          authorId: userId,
          spaceId: into,
          body: text,
          tags: tagsIn(text),
          sharedPostId: source ? source.sharedPostId : original.id,
          sharedAuthorId: source ? source.sharedAuthorId : original.authorId,
          sharedBody: source ? source.sharedBody : original.body,
          sharedAt: source ? source.sharedAt : original.createdAt,
        })
        .returning();
      await tx
        .update(posts)
        .set({ shares: sql`${posts.shares} + 1` })
        .where(eq(posts.id, original.id));
      return made;
    });
    if (!row) throw new Error("The share was not saved.");
    if (original.authorId !== userId)
      await notify(original.authorId, "share", userId, original.id);
    return (await wires(userId, [row]))[0];
  }

  /* ---------------------------------------------------------------- feeds */

  /** A page of top-level posts, newest first, before the post named by `before`. */
  async function page(
    viewerId: string,
    where: SQL | undefined,
    before?: string,
    limit = 30,
  ) {
    const cursor = before
      ? (await database.select().from(posts).where(eq(posts.id, before)))[0]
      : undefined;
    const rows = await database
      .select()
      .from(posts)
      .where(
        and(
          isNull(posts.parentId),
          visibleTo(await mySpaces(viewerId)),
          where,
          cursor
            ? or(
                lt(posts.createdAt, cursor.createdAt),
                and(
                  eq(posts.createdAt, cursor.createdAt),
                  lt(posts.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return wires(viewerId, rows);
  }

  /**
   * `following`: the person's own posts and those of the people they follow, wherever they can see
   * them. `everyone`: every post to everybody. `spaces`: every post in the spaces they are in, or in
   * one of them.
   */
  async function feed(
    viewerId: string,
    kind: FeedKind,
    options: { before?: string; spaceId?: string; limit?: number } = {},
  ) {
    if (kind === "everyone")
      return page(
        viewerId,
        isNull(posts.spaceId),
        options.before,
        options.limit,
      );
    if (kind === "spaces") {
      const mine = await mySpaces(viewerId);
      if (options.spaceId && !mine.includes(options.spaceId))
        throw new WorkspaceNotFoundError("That space");
      const ids = options.spaceId ? [options.spaceId] : mine;
      if (ids.length === 0) return [];
      return page(
        viewerId,
        inArray(posts.spaceId, ids),
        options.before,
        options.limit,
      );
    }
    const followed = database
      .select({ id: follows.followeeId })
      .from(follows)
      .where(eq(follows.followerId, viewerId));
    return page(
      viewerId,
      or(eq(posts.authorId, viewerId), inArray(posts.authorId, followed)),
      options.before,
      options.limit,
    );
  }

  /** Somebody's posts, as the viewer may see them. */
  async function postsBy(
    viewerId: string,
    handleOrId: string,
    before?: string,
  ) {
    const authorId = await userByHandle(handleOrId);
    return page(viewerId, eq(posts.authorId, authorId), before);
  }

  /* -------------------------------------------------------------- explore */

  /** Tags used most in the last week, in posts to everybody. */
  async function trending(limit = 10) {
    const since = new Date(now().getTime() - 7 * 86_400_000);
    const rows = await database.execute<{ tag: string; posts: number }>(sql`
      select tag, count(*)::int as posts
      from ${posts}, unnest(${posts.tags}) as tag
      where ${posts.spaceId} is null and ${posts.createdAt} >= ${since}
      group by tag
      order by posts desc, tag
      limit ${limit}
    `);
    return [...rows].map((row) => ({ tag: row.tag, posts: Number(row.posts) }));
  }

  /** People worth following: those the people you follow follow, then the most followed. */
  async function suggestions(userId: string, limit = 10) {
    const rows = await database.execute<{ id: string; score: number }>(sql`
      select u.id, (
        select count(*) from ${follows} f2
        where f2.followee_id = u.id
          and f2.follower_id in (select followee_id from ${follows} where follower_id = ${userId})
      ) * 1000 + (select count(*) from ${follows} f3 where f3.followee_id = u.id) as score
      from ${users} u
      where u.id <> ${userId}
        and u.id not in (select followee_id from ${follows} where follower_id = ${userId})
      order by score desc, u.created_at desc
      limit ${limit}
    `);
    const ids = [...rows].map((row) => row.id);
    const people = await refs(ids);
    return ids.flatMap((id) => people.get(id) ?? []);
  }

  /** Everything the explore page finds for a query: people, posts, spaces and tags. */
  async function search(userId: string, query: string) {
    const term = query.trim();
    if (!term)
      return {
        people: await suggestions(userId),
        posts: await feed(userId, "everyone", { limit: 20 }),
        spaces: (await deps.discoverSpaces?.(userId, "")) ?? [],
        tags: await trending(),
      };
    const like = `%${term.replace(/^[@#]/, "").replace(/[%_\\]/g, "\\$&")}%`;
    const peopleRows = await database
      .select({ userId: profiles.userId })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(or(ilike(profiles.handle, like), ilike(users.name, like)))
      .limit(20);
    const people = await refs(peopleRows.map((row) => row.userId));
    const matching = term.startsWith("#")
      ? arrayContains(posts.tags, [term.slice(1).toLowerCase()])
      : sql`to_tsvector('simple', ${posts.body}) @@ plainto_tsquery('simple', ${term})`;
    return {
      people: peopleRows.flatMap((row) => people.get(row.userId) ?? []),
      posts: await page(userId, matching, undefined, 30),
      spaces:
        (await deps.discoverSpaces?.(userId, term.replace(/^[@#]/, ""))) ?? [],
      tags: (await trending(50)).filter((tag) =>
        tag.tag.includes(term.replace(/^#/, "").toLowerCase()),
      ),
    };
  }

  /* -------------------------------------------------------- notifications */

  async function notify(
    userId: string,
    kind: NotificationKind,
    actorUserId: string,
    postId: string | null,
  ) {
    await database.transaction(async (tx) => {
      await tx.insert(notifications).values({
        id: `ntf_${crypto.randomUUID()}`,
        userId,
        kind,
        actorUserId,
        postId,
      });
      await announceChannelActivity(tx, {
        type: "social",
        memberIds: [userId],
        change: "notifications",
      });
    });
  }

  async function inbox(userId: string, before?: string) {
    const rows = await database
      .select({ notification: notifications, body: posts.body })
      .from(notifications)
      .leftJoin(posts, eq(posts.id, notifications.postId))
      .where(
        and(
          eq(notifications.userId, userId),
          before ? lt(notifications.createdAt, new Date(before)) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    const people = await refs(rows.map((row) => row.notification.actorUserId));
    const [unread] = await database
      .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      );
    const items: NotificationWire[] = rows.flatMap(
      ({ notification, body: text }) => {
        const actor = people.get(notification.actorUserId);
        return actor
          ? [
              {
                id: notification.id,
                kind: notification.kind,
                actor,
                postId: notification.postId,
                excerpt: text ? text.slice(0, 140) : null,
                readAt: notification.readAt?.toISOString() ?? null,
                createdAt: notification.createdAt.toISOString(),
              },
            ]
          : [];
      },
    );
    return { notifications: items, unread: unread?.count ?? 0 };
  }

  async function markRead(userId: string) {
    await database
      .update(notifications)
      .set({ readAt: now() })
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      );
  }

  /* -------------------------------------------------------------- reports */

  async function report(userId: string, postId: string, input: unknown) {
    const { reason, note } = reportInput.parse(input);
    const row = await visiblePost(userId, postId);
    if (row.authorId === userId)
      throw new WorkspaceRefusedError("You cannot report your own post.");
    await database
      .insert(postReports)
      .values({
        id: `rpt_${crypto.randomUUID()}`,
        postId,
        reporterId: userId,
        accusedId: row.authorId,
        reason,
        note,
        body: row.body,
      })
      .onConflictDoNothing();
  }

  /** Admin → Reports: what people reported, open ones first. */
  async function reports(
    status?: "open" | "resolved" | "dismissed",
  ): Promise<ReportWire[]> {
    const rows = await database
      .select()
      .from(postReports)
      .where(status ? eq(postReports.status, status) : undefined)
      .orderBy(
        sql`${postReports.status} = 'open' desc`,
        desc(postReports.createdAt),
      )
      .limit(200);
    const people = await refs(
      rows.flatMap((row) => [row.reporterId, row.accusedId]),
    );
    const gone: PersonRefWire = {
      userId: "",
      handle: "",
      name: "Somebody",
      image: null,
    };
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      note: row.note,
      status: row.status,
      post: {
        id: row.postId,
        body: row.body,
        author: people.get(row.accusedId) ?? gone,
      },
      reporter: people.get(row.reporterId) ?? gone,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  }

  /** An administrator closing a report: resolved, dismissed, or resolved by removing the post. */
  async function resolveReport(
    adminUserId: string,
    reportId: string,
    action: "resolve" | "dismiss" | "remove" | "reopen",
  ) {
    const [row] = await database
      .select()
      .from(postReports)
      .where(eq(postReports.id, reportId));
    if (!row) throw new WorkspaceNotFoundError("That report");
    const status =
      action === "dismiss"
        ? "dismissed"
        : action === "reopen"
          ? "open"
          : "resolved";
    // Every open report of a removed post is settled with it.
    await database
      .update(postReports)
      .set({
        status,
        resolvedByUserId: status === "open" ? null : adminUserId,
        resolvedAt: status === "open" ? null : now(),
      })
      .where(
        action === "remove" && row.postId
          ? or(
              eq(postReports.id, reportId),
              and(
                eq(postReports.postId, row.postId),
                eq(postReports.status, "open"),
              ),
            )
          : eq(postReports.id, reportId),
      );
    // Removed after the reports are settled: removing it lets go of the post they point at.
    if (action === "remove" && row.postId)
      await remove(adminUserId, row.postId, true);
  }

  return {
    ensureProfiles,
    refs,
    profile,
    updateProfile,
    mayMessage,
    follow,
    unfollow,
    connections,
    create,
    get,
    update,
    remove,
    like,
    unlike,
    comment,
    comments,
    share,
    feed,
    postsBy,
    trending,
    suggestions,
    search,
    inbox,
    markRead,
    report,
    reports,
    resolveReport,
  };
}
