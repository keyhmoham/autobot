/**
 * The social side of OpenDuet, read from both sides: profiles, follows, posts and what happens to
 * them, the feeds and the explore page, and the notifications they send.
 *
 * A post is the author's own, published either to everybody on the deployment or into one space,
 * where only the space's people see it. A comment is a post with a parent and is seen wherever its
 * parent is. A share is a post that carries a copy of another, so it outlives the original.
 *
 * Talking privately is not here: a direct conversation is a channel (workspace/service.ts
 * `openDirect`), and a profile only says who may start one.
 */

/** A handle: lower case letters, digits and underscores, so it reads the same everywhere it is typed. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

/** Who may start a direct conversation with somebody. */
export const DIRECT_POLICIES = ["everyone", "following", "nobody"] as const;
export type DirectPolicy = (typeof DIRECT_POLICIES)[number];

export const FEED_KINDS = ["following", "everyone", "spaces"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "abuse",
  "scam",
  "inappropriate",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const NOTIFICATION_KINDS = [
  "follow",
  "like",
  "comment",
  "share",
  "mention",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const MAX_POST_LENGTH = 5_000;
export const MAX_BIO_LENGTH = 300;

/** Somebody, as a post or a list shows them. */
export type PersonRefWire = {
  userId: string;
  handle: string;
  name: string;
  image: string | null;
};

export type ProfileWire = PersonRefWire & {
  bio: string;
  directs: DirectPolicy;
  followers: number;
  following: number;
  posts: number;
  /** From the viewer's side; false on their own profile. */
  isFollowing: boolean;
  followsYou: boolean;
  /** Whether the viewer may open a direct conversation with them. */
  canMessage: boolean;
  isYou: boolean;
};

export type PostWire = {
  id: string;
  author: PersonRefWire;
  /** The space it was posted into; null for a post to everybody. */
  space: { id: string; name: string } | null;
  parentId: string | null;
  body: string;
  tags: string[];
  /** The post this one shares, as it was when shared. */
  shared: {
    postId: string | null;
    author: PersonRefWire;
    body: string;
    createdAt: string;
  } | null;
  likes: number;
  comments: number;
  shares: number;
  likedByYou: boolean;
  editedAt: string | null;
  createdAt: string;
};

export type NotificationWire = {
  id: string;
  kind: NotificationKind;
  actor: PersonRefWire;
  postId: string | null;
  /** The start of the post it is about, so the line says what it was. */
  excerpt: string | null;
  readAt: string | null;
  createdAt: string;
};

export type ReportWire = {
  id: string;
  reason: ReportReason;
  note: string;
  status: ReportStatus;
  post: { id: string | null; body: string; author: PersonRefWire };
  reporter: PersonRefWire;
  createdAt: string;
  resolvedAt: string | null;
};

/** The tags a body carries: `#launch` and `#Launch` are one tag. */
export function tagsIn(body: string): string[] {
  const found =
    body.match(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{2,40})/gu) ?? [];
  return [
    ...new Set(
      found.map((match) => match.slice(match.indexOf("#") + 1).toLowerCase()),
    ),
  ].slice(0, 20);
}

/** The handles a body mentions. */
export function mentionsIn(body: string): string[] {
  const found = body.match(/(?:^|[^a-z0-9_@])@([a-z0-9_]{3,30})/giu) ?? [];
  return [
    ...new Set(
      found.map((match) => match.slice(match.indexOf("@") + 1).toLowerCase()),
    ),
  ].slice(0, 20);
}
