/**
 * A space's timeline, read from both sides: what happened in the space and when, as dated statements
 * about the things in it (people, Bots, rooms, channels, models, apps).
 *
 * Bitemporal: every statement says when it was true (`at`) and when this deployment learned it
 * (`recordedAt`). A statement about a state that can change (a person's role, a room's name) ends
 * when a later one about the same state begins (`endedAt`), so the timeline answers both "what
 * happened between these dates" and "what was true on this date".
 */

export const TIMELINE_KINDS = [
  "space",
  "room",
  "channel",
  "person",
  "agent",
  "model",
  "app",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type TimelineThing = { name: string; kind: TimelineKind };

export type TimelineStatementWire = {
  id: string;
  subject: TimelineThing;
  /** What the subject did or was: "joined", "said", "created", "used". */
  phrase: string;
  object: TimelineThing | null;
  /** A literal the statement carries when its object is not a thing: what was said, a role, a count. */
  value: string | null;
  qualifiers: Record<string, string>;
  at: string;
  endedAt: string | null;
  recordedAt: string;
};

export type TimelineEntityWire = TimelineThing & {
  id: string;
  statements: number;
  firstAt: string;
  lastAt: string;
};
