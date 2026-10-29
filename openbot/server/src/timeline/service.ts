/**
 * Spaces' timelines: recorded from what the deployment already keeps (timeline/feeds.ts), read by
 * the space's people on its timeline screen and by its Bots through their timeline tools.
 *
 * A timeline is the space's: anybody who can see the space can read all of it, the same rule that
 * lets them read every room, so it shows nobody anything their rooms would not.
 */
import type {
  TimelineEntityWire,
  TimelineKind,
  TimelineStatementWire,
  TimelineThing,
} from "@openbot/shared/timeline";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import { timelineEntities, timelineStatements } from "../db/schema/timeline";
import { spaces } from "../db/schema/workspace";
import { requirePermission, type Transaction } from "../workspace/access";

/** A thing a feed names, by what it stands for. */
export type TimelineRef = { kind: TimelineKind; ref: string; name: string };

export type TimelineStatementInput = {
  spaceId: string;
  subject: TimelineRef;
  phrase: string;
  object?: TimelineRef | null;
  value?: string | null;
  qualifiers?: Record<string, string>;
  at: Date;
  /** A state that can change, which this statement ends the last statement about. */
  stateKey?: string;
  sourceKey: string;
};

export type TimelineQuery = {
  /** Only statements from this time. */
  from?: Date;
  /** Only statements before this time. */
  to?: Date;
  /** Only statements about a thing whose name holds this. */
  about?: string;
  /** What was true at this time: statements begun by then and not yet ended. */
  asOf?: Date;
  limit?: number;
};

const subjects = alias(timelineEntities, "subjects");
const objects = alias(timelineEntities, "objects");

export type Timeline = ReturnType<typeof createTimeline>;

export function createTimeline(deps: { database: Database }) {
  const { database } = deps;

  async function entity(tx: Transaction, spaceId: string, thing: TimelineRef) {
    const [row] = await tx
      .insert(timelineEntities)
      .values({
        id: `tle_${crypto.randomUUID()}`,
        spaceId,
        kind: thing.kind,
        ref: thing.ref,
        name: thing.name,
      })
      .onConflictDoUpdate({
        target: [
          timelineEntities.spaceId,
          timelineEntities.kind,
          timelineEntities.ref,
        ],
        // A renamed thing keeps its history under its newest name.
        set: { name: thing.name },
      })
      .returning({ id: timelineEntities.id });
    if (!row) throw new Error("The timeline entity was not saved.");
    return row.id;
  }

  /**
   * Record statements. One already recorded from the same source is left as it was, so a feed may
   * read a record again at no cost. Returns how many were new.
   */
  async function record(statements: TimelineStatementInput[]) {
    if (statements.length === 0) return 0;
    let added = 0;
    // A record read after its space was deleted has no timeline left to go on.
    const live = new Set(
      (
        await database
          .select({ id: spaces.id })
          .from(spaces)
          .where(
            inArray(spaces.id, [
              ...new Set(statements.map((each) => each.spaceId)),
            ]),
          )
      ).map((row) => row.id),
    );
    for (const statement of statements.filter((each) => live.has(each.spaceId)))
      await database.transaction(async (tx) => {
        const subjectId = await entity(
          tx,
          statement.spaceId,
          statement.subject,
        );
        const objectId = statement.object
          ? await entity(tx, statement.spaceId, statement.object)
          : null;
        const [inserted] = await tx
          .insert(timelineStatements)
          .values({
            id: `tls_${crypto.randomUUID()}`,
            spaceId: statement.spaceId,
            subjectId,
            phrase: statement.phrase,
            objectId,
            value: statement.value ?? null,
            qualifiers: statement.qualifiers ?? {},
            at: statement.at,
            stateKey: statement.stateKey ?? null,
            sourceKey: statement.sourceKey,
          })
          .onConflictDoNothing()
          .returning({ id: timelineStatements.id });
        if (!inserted) return;
        added += 1;
        if (statement.stateKey)
          // The last statement about this state, before this one, ends where this one begins.
          await tx
            .update(timelineStatements)
            .set({ endedAt: statement.at })
            .where(
              and(
                eq(timelineStatements.spaceId, statement.spaceId),
                eq(timelineStatements.stateKey, statement.stateKey),
                lt(timelineStatements.at, statement.at),
                isNull(timelineStatements.endedAt),
              ),
            );
      });
    return added;
  }

  /** Statements in a space, newest first, as an agent or a person asked for them. */
  async function statements(
    spaceId: string,
    query: TimelineQuery = {},
  ): Promise<TimelineStatementWire[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const about = query.about?.trim();
    const rows = await database
      .select({
        statement: timelineStatements,
        subject: { name: subjects.name, kind: subjects.kind },
        object: { name: objects.name, kind: objects.kind },
      })
      .from(timelineStatements)
      .innerJoin(subjects, eq(subjects.id, timelineStatements.subjectId))
      .leftJoin(objects, eq(objects.id, timelineStatements.objectId))
      .where(
        and(
          eq(timelineStatements.spaceId, spaceId),
          query.from ? gte(timelineStatements.at, query.from) : undefined,
          query.to ? lt(timelineStatements.at, query.to) : undefined,
          query.asOf
            ? and(
                lte(timelineStatements.at, query.asOf),
                or(
                  isNull(timelineStatements.endedAt),
                  gt(timelineStatements.endedAt, query.asOf),
                ),
              )
            : undefined,
          about
            ? or(
                ilike(subjects.name, `%${about}%`),
                ilike(objects.name, `%${about}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(timelineStatements.at), desc(timelineStatements.id))
      .limit(limit);
    return rows.map(({ statement, subject, object }) => ({
      id: statement.id,
      subject: subject as TimelineThing,
      phrase: statement.phrase,
      object: object?.name ? (object as TimelineThing) : null,
      value: statement.value,
      qualifiers: statement.qualifiers,
      at: statement.at.toISOString(),
      endedAt: statement.endedAt?.toISOString() ?? null,
      recordedAt: statement.recordedAt.toISOString(),
    }));
  }

  /** The things in a space's timeline, most recently active first. */
  async function entities(
    spaceId: string,
    search?: string,
  ): Promise<TimelineEntityWire[]> {
    const term = search?.trim();
    const rows = await database
      .select({
        id: timelineEntities.id,
        name: timelineEntities.name,
        kind: timelineEntities.kind,
        statements: sql<number>`count(${timelineStatements.id})::int`.mapWith(
          Number,
        ),
        firstAt: sql<Date>`min(${timelineStatements.at})`,
        lastAt: sql<Date>`max(${timelineStatements.at})`,
      })
      .from(timelineEntities)
      .innerJoin(
        timelineStatements,
        or(
          eq(timelineStatements.subjectId, timelineEntities.id),
          eq(timelineStatements.objectId, timelineEntities.id),
        ),
      )
      .where(
        and(
          eq(timelineEntities.spaceId, spaceId),
          term ? ilike(timelineEntities.name, `%${term}%`) : undefined,
        ),
      )
      .groupBy(timelineEntities.id)
      .orderBy(desc(sql`max(${timelineStatements.at})`))
      .limit(100);
    return rows.map((row) => ({
      ...row,
      firstAt: new Date(row.firstAt).toISOString(),
      lastAt: new Date(row.lastAt).toISOString(),
    }));
  }

  /** The same reads for a person, who must be able to see the space. */
  async function read(
    actorUserId: string,
    spaceId: string,
    query: TimelineQuery,
  ) {
    await requirePermission(database, spaceId, actorUserId, "space.view");
    return statements(spaceId, query);
  }

  async function things(actorUserId: string, spaceId: string, search?: string) {
    await requirePermission(database, spaceId, actorUserId, "space.view");
    return entities(spaceId, search);
  }

  return { record, statements, entities, read, things };
}
