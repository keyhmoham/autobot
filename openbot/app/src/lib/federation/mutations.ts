import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  federationKeys,
  type FederationSelf,
  type JoinCode,
} from "./queries";

function invalidateFederation(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: federationKeys.all });
}

/** A new join code: the secret once, and the row as the list shows it (without the secret). */
export type CreatedJoinCode = JoinCode & { code: string };

export function createJoinCodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      label?: string;
      days?: number;
    }): Promise<CreatedJoinCode> => {
      // Create answers as `{ code, joinCode }`: the secret once, then never again on the list.
      const response = await client("/api/admin/federation/join-codes", {
        method: "POST",
        body: input,
        fallback: "Couldn't make a join code.",
      });
      const body = (await response.json()) as {
        code: string;
        joinCode: Omit<JoinCode, "code"> & { code?: string };
      };
      return {
        id: body.joinCode.id,
        code: body.code,
        label: body.joinCode.label,
        expiresAt: body.joinCode.expiresAt,
        createdAt: body.joinCode.createdAt,
      };
    },
    onSuccess: () => invalidateFederation(queryClient),
  });
}

export function revokeJoinCodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/admin/federation/join-codes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't revoke that code.",
      }),
    onSuccess: () => invalidateFederation(queryClient),
  });
}

export function joinFederationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      code: string;
      /** Address of the central node. */
      centralUrl: string;
    }): Promise<FederationSelf> =>
      client("/api/admin/federation/join", "self", {
        method: "POST",
        body: input,
        fallback: "Couldn't join that federation.",
      }),
    onSuccess: () => invalidateFederation(queryClient),
  });
}

export function removeFederationNodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/admin/federation/nodes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't remove that node.",
      }),
    onSuccess: () => invalidateFederation(queryClient),
  });
}

export function federationHeartbeatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      client("/api/admin/federation/heartbeat", {
        method: "POST",
        fallback: "Couldn't ping the federation.",
      }),
    onSuccess: () => invalidateFederation(queryClient),
  });
}
