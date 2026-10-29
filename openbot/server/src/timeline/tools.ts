/**
 * The space's timeline, as a Bot reads it: what happened and when, what was true on a date, and the
 * things the timeline is about. Read-only; the timeline is written by its feeds, never by a Bot.
 */
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import { type TurnPlace, workspaceTool } from "../workspace/tools";
import type { Timeline } from "./service";

export const TIMELINE_GUIDANCE =
  "The space keeps a timeline of what happened in it: who joined and left, rooms and channels, what was said in its rooms, and which models its work ran on. When somebody asks what happened, what changed, who did something or when, read it with timeline_events, timeline_as_of or timeline_things rather than guessing.";

const date = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Give a date, like 2026-10-01 or 2026-10-01T09:00Z.",
  );

export function createTimelineTools(
  timeline: Pick<Timeline, "statements" | "entities">,
  place: Pick<TurnPlace, "spaceId">,
): HeadlessTool[] {
  return [
    workspaceTool(
      "timeline_events",
      "Read what happened in this space, newest first: dated statements like 'Ana joined', 'Bot answered Bo', 'Ana opened #launch'. Narrow it by a period and by a thing's name.",
      z.strictObject({
        from: date.optional().describe("Only what happened from this date."),
        to: date.optional().describe("Only what happened before this date."),
        about: z
          .string()
          .optional()
          .describe(
            "Only statements about a thing whose name holds this: a person, a Bot, a room, a channel, a model.",
          ),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      async ({ from, to, about, limit }) => ({
        events: await timeline.statements(place.spaceId, {
          ...(from ? { from: new Date(from) } : {}),
          ...(to ? { to: new Date(to) } : {}),
          ...(about ? { about } : {}),
          ...(limit ? { limit } : {}),
        }),
      }),
    ),
    workspaceTool(
      "timeline_as_of",
      "What was true in this space at a moment: who was a member and with which role, which Bots worked in it, who could read which room.",
      z.strictObject({
        at: date.describe("The moment to read the space at."),
        about: z.string().optional(),
      }),
      async (input) => ({
        facts: await timeline.statements(place.spaceId, {
          asOf: new Date(input.at),
          ...(input.about ? { about: input.about } : {}),
          limit: 200,
        }),
      }),
    ),
    workspaceTool(
      "timeline_things",
      "The people, Bots, rooms, channels and models this space's timeline is about, most recently active first, with when each first and last appeared.",
      z.strictObject({ search: z.string().optional() }),
      async (input) => ({
        things: await timeline.entities(place.spaceId, input.search),
      }),
    ),
  ];
}
