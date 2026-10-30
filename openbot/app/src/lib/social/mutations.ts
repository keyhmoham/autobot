/**
 * Writes against the social side: profile, follow, post, like, comment, share, report.
 */
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  DirectPolicy,
  PostWire,
  ProfileWire,
  ReportReason,
} from "@openbot/shared/social";
import { client } from "@/lib/client";
import { socialKeys } from "./queries";

function invalidateSocial(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: socialKeys.all });
}

export function updateProfileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      handle?: string;
      name?: string;
      bio?: string;
      directs?: DirectPolicy;
    }): Promise<ProfileWire> =>
      client("/api/social/me", "profile", {
        method: "PATCH",
        body: input,
        fallback: "Couldn't save your profile.",
      }),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function followMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      handle: string;
      follow: boolean;
    }): Promise<ProfileWire> =>
      client(
        `/api/social/people/${encodeURIComponent(variables.handle)}/follow`,
        "profile",
        {
          method: variables.follow ? "POST" : "DELETE",
          fallback: variables.follow
            ? "Couldn't follow them."
            : "Couldn't unfollow them.",
        },
      ),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function createPostMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      body: string;
      spaceId?: string | null;
    }): Promise<PostWire> =>
      client("/api/social/posts", "post", {
        method: "POST",
        body: input,
        fallback: "Couldn't publish that.",
      }),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function likePostMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      postId: string;
      like: boolean;
    }): Promise<PostWire> =>
      client(
        `/api/social/posts/${encodeURIComponent(variables.postId)}/like`,
        "post",
        {
          method: variables.like ? "POST" : "DELETE",
          fallback: "Couldn't update that like.",
        },
      ),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function commentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      postId: string;
      body: string;
    }): Promise<PostWire> =>
      client(
        `/api/social/posts/${encodeURIComponent(variables.postId)}/comments`,
        "comment",
        {
          method: "POST",
          body: { body: variables.body },
          fallback: "Couldn't post that comment.",
        },
      ),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function sharePostMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      postId: string;
      body?: string;
    }): Promise<PostWire> =>
      client(
        `/api/social/posts/${encodeURIComponent(variables.postId)}/share`,
        "post",
        {
          method: "POST",
          body: { body: variables.body },
          fallback: "Couldn't share that.",
        },
      ),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function reportPostMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      postId: string;
      reason: ReportReason;
      note?: string;
    }) =>
      client(
        `/api/social/posts/${encodeURIComponent(variables.postId)}/report`,
        {
          method: "POST",
          body: { reason: variables.reason, note: variables.note },
          fallback: "Couldn't send that report.",
        },
      ),
    onSuccess: () => invalidateSocial(queryClient),
  });
}

export function markNotificationsReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      client("/api/social/notifications/read", {
        method: "POST",
        fallback: "Couldn't mark notifications read.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: socialKeys.notifications() }),
  });
}

export function resolveReportMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      action: "resolve" | "dismiss" | "remove" | "reopen";
    }) =>
      client(`/api/admin/reports/${encodeURIComponent(variables.id)}`, {
        method: "POST",
        body: { action: variables.action },
        fallback: "Couldn't update that report.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: socialKeys.reports() }),
  });
}

export function deletePostMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (postId: string) =>
      client(`/api/social/posts/${encodeURIComponent(postId)}`, {
        method: "DELETE",
        fallback: "Couldn't remove that post.",
      }),
    onSuccess: () => invalidateSocial(queryClient),
  });
}
