/**
 * Spaces, rooms, desks, directs and invitations — the workspace the Spaces tab is drawn from.
 *
 * Wire shapes live in `@openbot/shared/workspace` and `@openbot/shared/desk`, so the browser and the
 * server never disagree on what a space or a desk is.
 */
import { queryOptions } from "@tanstack/react-query";
import type { Desk } from "@openbot/shared/desk";
import type {
  ChannelWire,
  InvitationWire,
  MemberWire,
  RoomWire,
  SpaceWire,
} from "@openbot/shared/workspace";
import { client } from "@/lib/client";

export type SpaceDetail = SpaceWire & { rooms: RoomWire[] };

export const spaceKeys = {
  all: ["spaces"] as const,
  list: () => ["spaces", "list"] as const,
  discover: (q: string) => ["spaces", "discover", q] as const,
  detail: (id: string) => ["spaces", "detail", id] as const,
  members: (id: string) => ["spaces", "members", id] as const,
  agents: (id: string) => ["spaces", "agents", id] as const,
  invitations: (id: string) => ["spaces", "invitations", id] as const,
  desk: (roomId: string) => ["spaces", "desk", roomId] as const,
  roomPeople: (roomId: string) => ["spaces", "room-people", roomId] as const,
  channel: (id: string) => ["spaces", "channel", id] as const,
  directs: () => ["spaces", "directs"] as const,
  mineInvites: () => ["spaces", "invites", "mine"] as const,
};

export const spacesListQueryOptions = () =>
  queryOptions({
    queryKey: spaceKeys.list(),
    queryFn: (): Promise<SpaceWire[]> =>
      client("/api/spaces", "spaces", {
        fallback: "Couldn't load your spaces.",
      }),
  });

export const spacesDiscoverQueryOptions = (q: string) =>
  queryOptions({
    queryKey: spaceKeys.discover(q),
    queryFn: (): Promise<SpaceWire[]> =>
      client(
        `/api/spaces/discover?q=${encodeURIComponent(q)}`,
        "spaces",
        { fallback: "Couldn't search spaces." },
      ),
  });

export const spaceQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.detail(spaceId),
    queryFn: (): Promise<SpaceDetail> =>
      client(`/api/spaces/${encodeURIComponent(spaceId)}`, "space", {
        fallback: "Couldn't open this space.",
      }),
  });

export const spaceMembersQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.members(spaceId),
    queryFn: (): Promise<MemberWire[]> =>
      client(`/api/spaces/${encodeURIComponent(spaceId)}/members`, "members", {
        fallback: "Couldn't load members.",
      }),
  });

export const spaceAgentsQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.agents(spaceId),
    queryFn: (): Promise<{ id: string; name: string }[]> =>
      client(`/api/spaces/${encodeURIComponent(spaceId)}/agents`, "agents", {
        fallback: "Couldn't load this space's Bots.",
      }),
  });

export const spaceInvitationsQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.invitations(spaceId),
    queryFn: (): Promise<InvitationWire[]> =>
      client(
        `/api/spaces/${encodeURIComponent(spaceId)}/invitations`,
        "invitations",
        { fallback: "Couldn't load invitations." },
      ),
  });

export const roomDeskQueryOptions = (roomId: string) =>
  queryOptions({
    queryKey: spaceKeys.desk(roomId),
    queryFn: (): Promise<Desk> =>
      client(`/api/rooms/${encodeURIComponent(roomId)}/desk`, "desk", {
        fallback: "Couldn't load this room's desk.",
      }),
  });

export const roomPeopleQueryOptions = (roomId: string) =>
  queryOptions({
    queryKey: spaceKeys.roomPeople(roomId),
    queryFn: (): Promise<MemberWire[]> =>
      client(`/api/rooms/${encodeURIComponent(roomId)}/people`, "people", {
        fallback: "Couldn't load who is in this room.",
      }),
  });

export const roomChannelQueryOptions = (channelId: string) =>
  queryOptions({
    queryKey: spaceKeys.channel(channelId),
    queryFn: (): Promise<ChannelWire> =>
      client(
        `/api/room-channels/${encodeURIComponent(channelId)}`,
        "channel",
        { fallback: "Couldn't open this conversation." },
      ),
  });

export const directsQueryOptions = () =>
  queryOptions({
    queryKey: spaceKeys.directs(),
    queryFn: (): Promise<ChannelWire[]> =>
      client("/api/directs", "directs", {
        fallback: "Couldn't load your direct messages.",
      }),
  });

export const myInvitationsQueryOptions = () =>
  queryOptions({
    queryKey: spaceKeys.mineInvites(),
    queryFn: (): Promise<InvitationWire[]> =>
      client("/api/invitations", "invitations", {
        fallback: "Couldn't load your invitations.",
      }),
  });
