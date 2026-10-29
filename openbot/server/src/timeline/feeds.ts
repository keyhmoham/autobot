/**
 * What fills the spaces' timelines: the records the rest of the deployment already keeps, read in
 * time order and turned into dated statements. A feed only reads; the records stay their owners'.
 *
 * Each feed keeps a cursor (the last record's time and id), and reading the same record again adds
 * nothing (statements are keyed by their source), so a pass interrupted halfway is simply repeated.
 * A record that is not final yet (a Bot still answering) holds its feed's cursor back while it is
 * young, so how it ended is not missed; one that never finishes is let go after HOLD_BACK_MS.
 */
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { channelMessages } from "../db/schema/conversation";
import { agents, auditEvents, channels, users } from "../db/schema/core";
import { llmUsage } from "../db/schema/llm";
import { timelineCursors } from "../db/schema/timeline";
import { rooms, spaces } from "../db/schema/workspace";
import type { Timeline, TimelineRef, TimelineStatementInput } from "./service";

const BATCH = 200;
const HOLD_BACK_MS = 30 * 60_000;
/** The most of a message a statement keeps: enough to say what it was about. */
const EXCERPT = 400;

type Row = {
  at: Date;
  ref: string;
  statements: TimelineStatementInput[];
  /** Not final yet: the cursor waits here while the record is young. */
  pending?: boolean;
};

export type Cursor = { at: Date; ref: string };

export type TimelineFeed = {
  name: string;
  read: (after: Cursor | null, limit: number) => Promise<Row[]>;
};

/** Names for the ids in records, read once per pass. */
function namer(database: Database) {
  const cache = new Map<string, string>();
  const named = async (
    key: string,
    load: () => Promise<string | null | undefined>,
    fallback: string,
  ) => {
    const hit = cache.get(key);
    if (hit) return hit;
    const name = (await load()) || fallback;
    cache.set(key, name);
    return name;
  };
  return {
    person: async (id: string): Promise<TimelineRef> => ({
      kind: "person",
      ref: id,
      name: await named(
        `person:${id}`,
        async () => {
          const [row] = await database
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, id));
          return row?.name ?? row?.email;
        },
        "Somebody",
      ),
    }),
    agent: async (id: string): Promise<TimelineRef> => ({
      kind: "agent",
      ref: id,
      name: await named(
        `agent:${id}`,
        async () =>
          (
            await database
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, id))
          )[0]?.name,
        "A Bot",
      ),
    }),
    room: async (id: string): Promise<TimelineRef> => ({
      kind: "room",
      ref: id,
      name: await named(
        `room:${id}`,
        async () =>
          (
            await database
              .select({ name: rooms.name })
              .from(rooms)
              .where(eq(rooms.id, id))
          )[0]?.name,
        "A room",
      ),
    }),
    channel: async (id: string): Promise<TimelineRef> => ({
      kind: "channel",
      ref: id,
      name: await named(
        `channel:${id}`,
        async () =>
          (
            await database
              .select({ name: channels.name })
              .from(channels)
              .where(eq(channels.id, id))
          )[0]?.name,
        "A channel",
      ),
    }),
    space: async (id: string): Promise<TimelineRef> => ({
      kind: "space",
      ref: id,
      name: await named(
        `space:${id}`,
        async () =>
          (
            await database
              .select({ name: spaces.name })
              .from(spaces)
              .where(eq(spaces.id, id))
          )[0]?.name,
        "This space",
      ),
    }),
  };
}

/** The keyset condition "after this cursor" over a time column and an id column. */
export function afterCursor(
  cursor: Cursor | null,
  at: Parameters<typeof gt>[0],
  ref: Parameters<typeof gt>[0],
) {
  if (!cursor) return undefined;
  return or(gt(at, cursor.at), and(eq(at, cursor.at), gt(ref, cursor.ref)));
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Joins, departures, roles, rooms, channels and Bots, from the workspace's audit trail. */
function workspaceFeed(database: Database): TimelineFeed {
  const handled = [
    "space.created",
    "space.updated",
    "space.member_added",
    "space.invitation_accepted",
    "space.member_role_changed",
    "space.member_removed",
    "space.agent_added",
    "space.agent_removed",
    "room.created",
    "room.updated",
    "room.deleted",
    "room.member_added",
    "room.member_removed",
    "channel.created",
    "channel.updated",
    "channel.deleted",
    "app.installed",
    "app.updated",
    "app.removed",
  ];
  return {
    name: "workspace",
    async read(cursor, limit) {
      const rows = await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetType, "space"),
            isNotNull(auditEvents.targetId),
            inArray(auditEvents.eventType, handled),
            afterCursor(
              cursor,
              auditEvents.createdAt,
              sql`${auditEvents.id}::text`,
            ),
          ),
        )
        .orderBy(asc(auditEvents.createdAt), asc(sql`${auditEvents.id}::text`))
        .limit(limit);
      const name = namer(database);
      const out: Row[] = [];
      for (const row of rows) {
        const spaceId = row.targetId as string;
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const at = row.createdAt;
        const sourceKey = `audit:${row.id}`;
        const actor = row.actorUserId
          ? await name.person(row.actorUserId)
          : null;
        const member = text(payload.member)
          ? await name.person(text(payload.member))
          : null;
        const space = await name.space(spaceId);
        const base = { spaceId, at, sourceKey };
        const said = (
          statement: Omit<
            TimelineStatementInput,
            "spaceId" | "at" | "sourceKey"
          >,
        ) => [{ ...base, ...statement }];
        let statements: TimelineStatementInput[] = [];
        switch (row.eventType) {
          case "space.created":
            if (actor)
              statements = [
                ...said({ subject: actor, phrase: "created", object: space }),
                {
                  ...base,
                  sourceKey: `${sourceKey}:member`,
                  subject: actor,
                  phrase: "is a member of",
                  object: space,
                  stateKey: `membership:${actor.ref}`,
                },
                {
                  ...base,
                  sourceKey: `${sourceKey}:role`,
                  subject: actor,
                  phrase: "has the role",
                  value: "owner",
                  stateKey: `role:${actor.ref}`,
                },
              ];
            break;
          case "space.updated":
            if (actor)
              statements = said({
                subject: actor,
                phrase: "changed",
                object: space,
                value: fields(payload),
              });
            break;
          case "space.member_added":
            if (member)
              statements = said({
                subject: member,
                phrase: "is a member of",
                object: space,
                stateKey: `membership:${member.ref}`,
              });
            break;
          case "space.invitation_accepted":
            // The person accepting is the actor: they are now a member, with the role they were invited to.
            if (actor)
              statements = [
                ...said({
                  subject: actor,
                  phrase: "is a member of",
                  object: space,
                  stateKey: `membership:${actor.ref}`,
                }),
                {
                  ...base,
                  sourceKey: `${sourceKey}:role`,
                  subject: actor,
                  phrase: "has the role",
                  value: text(payload.role),
                  stateKey: `role:${actor.ref}`,
                },
              ];
            break;
          case "space.member_role_changed":
            if (member)
              statements = said({
                subject: member,
                phrase: "has the role",
                value: text(payload.role),
                qualifiers: actor ? { by: actor.name } : {},
                stateKey: `role:${member.ref}`,
              });
            break;
          case "space.member_removed":
            if (member)
              statements = said({
                subject: member,
                phrase: "left",
                object: space,
                stateKey: `membership:${member.ref}`,
              });
            break;
          case "space.agent_added":
          case "space.agent_removed": {
            const agent = await name.agent(text(payload.agent));
            statements = said({
              subject: agent,
              phrase:
                row.eventType === "space.agent_added"
                  ? "works in"
                  : "was taken off",
              object: space,
              stateKey: `agent:${agent.ref}`,
            });
            break;
          }
          case "room.created":
          case "room.updated":
          case "room.deleted": {
            const room = await name.room(text(payload.room));
            if (actor)
              statements = said({
                subject: actor,
                phrase: {
                  "room.created": "created",
                  "room.updated": "changed",
                  "room.deleted": "removed",
                }[row.eventType],
                object: room,
                value:
                  row.eventType === "room.updated" ? fields(payload) : null,
              });
            break;
          }
          case "room.member_added":
          case "room.member_removed": {
            const room = await name.room(text(payload.room));
            if (member)
              statements = said({
                subject: member,
                phrase:
                  row.eventType === "room.member_added"
                    ? "can read"
                    : "can no longer read",
                object: room,
                stateKey: `room:${room.ref}:${member.ref}`,
              });
            break;
          }
          case "app.installed":
          case "app.updated":
          case "app.removed": {
            const builder = text(payload.agent)
              ? await name.agent(text(payload.agent))
              : actor;
            if (builder)
              statements = said({
                subject: builder,
                phrase: {
                  "app.installed": "built",
                  "app.updated": "rebuilt",
                  "app.removed": "removed",
                }[row.eventType],
                object: {
                  kind: "app",
                  ref: text(payload.app),
                  name: text(payload.name) || "An app",
                },
                value:
                  row.eventType === "app.removed"
                    ? null
                    : text(payload.status) || null,
                qualifiers:
                  text(payload.agent) && actor ? { for: actor.name } : {},
              });
            break;
          }
          case "channel.created":
          case "channel.updated":
          case "channel.deleted": {
            const channel = await name.channel(text(payload.channel));
            const room = text(payload.room)
              ? await name.room(text(payload.room))
              : null;
            if (actor)
              statements = said({
                subject: actor,
                phrase: {
                  "channel.created": "opened",
                  "channel.updated": "changed",
                  "channel.deleted": "removed",
                }[row.eventType],
                object: channel,
                value:
                  row.eventType === "channel.updated" ? fields(payload) : null,
                qualifiers: room ? { room: room.name } : {},
              });
            break;
          }
        }
        out.push({ at, ref: row.id, statements });
      }
      return out;
    },
  };
}

function fields(payload: Record<string, unknown>) {
  return Array.isArray(payload.fields) ? payload.fields.join(", ") : null;
}

/** What was said in the space's rooms, by people and by Bots. */
function messageFeed(database: Database, now: () => Date): TimelineFeed {
  return {
    name: "messages",
    async read(cursor, limit) {
      const rows = await database
        .select({
          message: channelMessages,
          roomId: channels.roomId,
          spaceId: rooms.spaceId,
        })
        .from(channelMessages)
        .innerJoin(channels, eq(channels.id, channelMessages.channelId))
        .innerJoin(rooms, eq(rooms.id, channels.roomId))
        .where(
          afterCursor(cursor, channelMessages.createdAt, channelMessages.id),
        )
        .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id))
        .limit(limit);
      const name = namer(database);
      const out: Row[] = [];
      for (const { message, roomId, spaceId } of rows) {
        const final =
          message.status === "completed" || message.status === "failed";
        const young =
          now().getTime() - message.createdAt.getTime() < HOLD_BACK_MS;
        if (!final && young) {
          out.push({
            at: message.createdAt,
            ref: message.id,
            statements: [],
            pending: true,
          });
          continue;
        }
        if (!final || !roomId) {
          out.push({ at: message.createdAt, ref: message.id, statements: [] });
          continue;
        }
        const channel = await name.channel(message.channelId);
        const room = await name.room(roomId);
        const person = await name.person(message.actorUserId);
        const excerpt = message.text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, EXCERPT);
        const qualifiers = { channel: channel.name, room: room.name };
        const statement: TimelineStatementInput = message.agentId
          ? {
              spaceId,
              subject: await name.agent(message.agentId),
              phrase:
                message.status === "failed" ? "could not answer" : "answered",
              object: person,
              value: excerpt || null,
              qualifiers,
              at: message.createdAt,
              sourceKey: `message:${message.id}`,
            }
          : {
              spaceId,
              subject: person,
              phrase: "said",
              object: channel,
              value: excerpt || null,
              qualifiers: { room: room.name },
              at: message.createdAt,
              sourceKey: `message:${message.id}`,
            };
        out.push({
          at: message.createdAt,
          ref: message.id,
          statements: excerpt ? [statement] : [],
        });
      }
      return out;
    },
  };
}

/** Which models the space's work ran on, and what it used. */
function usageFeed(database: Database): TimelineFeed {
  return {
    name: "usage",
    async read(cursor, limit) {
      const rows = await database
        .select()
        .from(llmUsage)
        .where(
          and(
            isNotNull(llmUsage.spaceId),
            afterCursor(cursor, llmUsage.createdAt, sql`${llmUsage.id}::text`),
          ),
        )
        .orderBy(asc(llmUsage.createdAt), asc(sql`${llmUsage.id}::text`))
        .limit(limit);
      const name = namer(database);
      const out: Row[] = [];
      for (const row of rows) {
        const subject = row.agentId
          ? await name.agent(row.agentId)
          : row.payerUserId
            ? await name.person(row.payerUserId)
            : null;
        out.push({
          at: row.createdAt,
          ref: row.id,
          statements: subject
            ? [
                {
                  spaceId: row.spaceId as string,
                  subject,
                  phrase: "used",
                  object: {
                    kind: "model",
                    ref: row.modelName,
                    name: row.modelName,
                  },
                  value: `${row.inputTokens} tokens in, ${row.outputTokens} out`,
                  qualifiers: {
                    purpose: row.purpose,
                    credits: String(row.cost),
                  },
                  at: row.createdAt,
                  sourceKey: `usage:${row.id}`,
                },
              ]
            : [],
        });
      }
      return out;
    },
  };
}

export function createTimelineFeeds(deps: {
  database: Database;
  timeline: Pick<Timeline, "record">;
  /** Feeds other modules add (the space's apps, say), read alongside these. */
  extra?: TimelineFeed[];
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());
  const feeds = [
    workspaceFeed(database),
    messageFeed(database, now),
    usageFeed(database),
    ...(deps.extra ?? []),
  ];

  /** Read one batch of one feed, record it, and move its cursor past what is final. */
  async function pass(feed: TimelineFeed) {
    const [stored] = await database
      .select()
      .from(timelineCursors)
      .where(eq(timelineCursors.feed, feed.name));
    const rows = await feed.read(
      stored ? { at: stored.at, ref: stored.ref } : null,
      BATCH,
    );
    let last: Cursor | null = null;
    let recorded = 0;
    for (const row of rows) {
      if (row.pending) break;
      recorded += await deps.timeline.record(row.statements);
      last = { at: row.at, ref: row.ref };
    }
    if (last)
      await database
        .insert(timelineCursors)
        .values({ feed: feed.name, at: last.at, ref: last.ref })
        .onConflictDoUpdate({
          target: timelineCursors.feed,
          set: { at: last.at, ref: last.ref, updatedAt: now() },
        });
    return recorded;
  }

  /** One pass of every feed. Returns how many statements were new. */
  async function sync() {
    let recorded = 0;
    for (const feed of feeds) {
      try {
        recorded += await pass(feed);
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "timeline-feed-failed",
            feed: feed.name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return recorded;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    sync,
    start(intervalMs = 10_000) {
      let busy = false;
      timer ??= setInterval(() => {
        if (busy) return;
        busy = true;
        void sync().finally(() => {
          busy = false;
        });
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
