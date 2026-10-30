/**
 * Writes against the workspace: make a space or a room, join one, open a direct, change a desk.
 */
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { Desk, DeskOp } from "@openbot/shared/desk";
import type {
  ChannelWire,
  SpaceRole,
  SpaceWire,
} from "@openbot/shared/workspace";
import { client } from "@/lib/client";
import { spaceKeys } from "./queries";

const FALLBACK = "Couldn't save that change.";

function invalidateSpaces(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: spaceKeys.all });
}

export function createSpaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      name: string;
      description?: string;
      visibility?: "private" | "public";
    }): Promise<SpaceWire> =>
      client("/api/spaces", "space", {
        method: "POST",
        body: input,
        fallback: "Couldn't make that space.",
      }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function joinSpaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (spaceId: string): Promise<SpaceWire> =>
      client(`/api/spaces/${encodeURIComponent(spaceId)}/join`, "space", {
        method: "POST",
        fallback: "Couldn't join that space.",
      }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function updateSpaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      spaceId: string;
      input: Partial<{
        name: string;
        description: string;
        visibility: "private" | "public";
      }>;
    }): Promise<SpaceWire> =>
      client(`/api/spaces/${encodeURIComponent(variables.spaceId)}`, "space", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function createRoomMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      spaceId: string;
      name: string;
      topic?: string;
    }): Promise<string> =>
      client(
        `/api/spaces/${encodeURIComponent(variables.spaceId)}/rooms`,
        "roomId",
        {
          method: "POST",
          body: { name: variables.name, topic: variables.topic },
          fallback: "Couldn't make that room.",
        },
      ),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function createRoomChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      roomId: string;
      name: string;
      agentIds?: string[];
    }): Promise<ChannelWire> =>
      client(
        `/api/rooms/${encodeURIComponent(variables.roomId)}/channels`,
        "channel",
        {
          method: "POST",
          body: { name: variables.name, agentIds: variables.agentIds },
          fallback: "Couldn't make that conversation.",
        },
      ),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function openDirectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      userId?: string;
      handle?: string;
    }): Promise<ChannelWire> =>
      client("/api/directs", "channel", {
        method: "POST",
        body: input,
        fallback: "Couldn't open that conversation.",
      }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

/** One change to a room's desk. The body is the op itself. */
export function applyDeskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      roomId: string;
      op: DeskOp;
    }): Promise<Desk> =>
      client(`/api/rooms/${encodeURIComponent(variables.roomId)}/desk`, "desk", {
        method: "POST",
        body: variables.op,
        fallback: "Couldn't update the desk.",
      }),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: spaceKeys.desk(variables.roomId),
      }),
  });
}

export function inviteToSpaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      spaceId: string;
      email: string;
      role?: SpaceRole;
    }) =>
      client(
        `/api/spaces/${encodeURIComponent(variables.spaceId)}/invitations`,
        {
          method: "POST",
          body: { email: variables.email, role: variables.role },
          fallback: "Couldn't send that invitation.",
        },
      ),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: spaceKeys.invitations(variables.spaceId),
      }),
  });
}

export function acceptInvitationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { id: string }) =>
      client("/api/invitations/accept", {
        method: "POST",
        body: input,
        fallback: "Couldn't accept that invitation.",
      }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function markRoomChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (channelId: string) =>
      client(`/api/room-channels/${encodeURIComponent(channelId)}/read`, {
        method: "POST",
        fallback: "Couldn't mark that conversation read.",
      }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}
