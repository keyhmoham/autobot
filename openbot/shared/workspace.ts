/**
 * Spaces, rooms and channels: the shapes and the permission model both sides read.
 *
 * A SPACE is a shared place of work: its people, its Bots, its rooms, and one computer every room in
 * it works on. A ROOM groups channels around one subject and owns one desk, the board of windows the
 * Bots and people put things on. A CHANNEL is a conversation inside a room (or, for a direct message,
 * between two people with no room at all), held by every member of its room, with any number of Bots.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, like channel-look.ts: the server keeps each set with a check
 * constraint and decides every request with `can`, and the app draws exactly these roles and greys out
 * what `can` refuses. A second list in either place would be a contract with two authors.
 */
import type { ChannelColour, ChannelIcon } from "./channel-look";

/** Who someone is in a space. The order is rank: an earlier role can do everything a later one can. */
export const SPACE_ROLES = ["owner", "admin", "member", "guest"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/** What a space is: a person's own (made for them, one each) or one made to share. */
export const SPACE_KINDS = ["home", "team"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/** Who can find a space without an invitation. */
export const SPACE_VISIBILITIES = ["private", "public"] as const;
export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number];

/** Who is in a room: every member of its space, or only the people added to it. */
export const ROOM_VISIBILITIES = ["open", "private"] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

/**
 * What a channel is, which decides how it is held.
 *
 * `assistant`: one person's own conversation with one Bot, kept in that person's Intelligence thread.
 * `task`: an OpenDuet task's conversation, the same way. `room`: a conversation in a room, shared by
 * the room's members and its Bots. `direct`: a conversation between two people, outside any room.
 */
export const CHANNEL_KINDS = ["assistant", "task", "room", "direct"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** The kinds held as a shared transcript rather than in one person's thread. */
export const SHARED_CHANNEL_KINDS = [
  "room",
  "direct",
] as const satisfies readonly ChannelKind[];
export type SharedChannelKind = (typeof SHARED_CHANNEL_KINDS)[number];

export function isSharedChannelKind(kind: string): kind is SharedChannelKind {
  return (SHARED_CHANNEL_KINDS as readonly string[]).includes(kind);
}

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "revoked",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Everything a role can be granted, named for what it lets a person do. */
export const PERMISSIONS = [
  "space.view",
  "space.edit",
  "space.delete",
  "space.invite",
  "space.manage_members",
  "space.manage_bots",
  "space.manage_rooms",
  "space.manage_computer",
  "space.build_apps",
  "space.manage_apps",
  "space.manage_budget",
  "room.read",
  "room.send",
  "room.create_channel",
  "room.manage_channels",
  "room.desk",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MEMBER_PERMISSIONS: readonly Permission[] = [
  "space.view",
  "space.build_apps",
  "room.read",
  "room.send",
  "room.create_channel",
  "room.desk",
];

/** What each role may do. The owner may do everything, so it is not listed. */
const ROLE_PERMISSIONS: Record<
  Exclude<SpaceRole, "owner">,
  readonly Permission[]
> = {
  admin: PERMISSIONS.filter((permission) => permission !== "space.delete"),
  member: MEMBER_PERMISSIONS,
  guest: ["space.view", "room.read", "room.send"],
};

/** Whether a role may do something. A person outside the space (null) may do nothing. */
export function can(role: SpaceRole | null, permission: Permission): boolean {
  if (!role) return false;
  if (role === "owner") return true;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Whether `actor` outranks `target`, which is what changing or removing somebody takes. */
export function outranks(actor: SpaceRole, target: SpaceRole): boolean {
  return SPACE_ROLES.indexOf(actor) < SPACE_ROLES.indexOf(target);
}

/** The roles a person in `role` may hand out: their own rank and below, never ownership. */
export function assignableRoles(role: SpaceRole | null): SpaceRole[] {
  if (!role || !can(role, "space.manage_members")) return [];
  return SPACE_ROLES.filter(
    (candidate) =>
      candidate !== "owner" &&
      SPACE_ROLES.indexOf(candidate) >= SPACE_ROLES.indexOf(role),
  );
}

export function isSpaceRole(value: unknown): value is SpaceRole {
  return (
    typeof value === "string" &&
    (SPACE_ROLES as readonly string[]).includes(value)
  );
}

export const MAX_SPACE_NAME = 60;
export const MAX_ROOM_NAME = 60;
export const MAX_DESCRIPTION = 500;
/** How long an invitation can be accepted for, in days. */
export const INVITATION_DAYS = 14;

/** The wire shapes the API answers with. */
export type SpaceWire = {
  id: string;
  name: string;
  description: string;
  icon: ChannelIcon;
  colour: ChannelColour;
  kind: SpaceKind;
  visibility: SpaceVisibility;
  /** The caller's role, or null for a public space they have not joined. */
  role: SpaceRole | null;
  memberCount: number;
  createdAt: string;
};

export type RoomWire = {
  id: string;
  spaceId: string;
  name: string;
  topic: string;
  icon: ChannelIcon;
  colour: ChannelColour;
  visibility: RoomVisibility;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  channels: ChannelWire[];
};

export type ChannelWire = {
  id: string;
  kind: ChannelKind;
  roomId: string | null;
  name: string;
  purpose: string | null;
  icon: ChannelIcon;
  colour: ChannelColour;
  agentIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  /** Whether the caller has not read what was said here last. */
  unread: boolean;
  archivedAt: string | null;
  createdAt: string;
};

export type MemberWire = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: SpaceRole;
  joinedAt: string;
};

export type InvitationWire = {
  id: string;
  spaceId: string;
  spaceName: string;
  roomId: string | null;
  email: string;
  role: SpaceRole;
  status: InvitationStatus;
  invitedBy: { userId: string; name: string | null; email: string };
  expiresAt: string;
  createdAt: string;
};
