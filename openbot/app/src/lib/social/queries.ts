/**
 * Profiles, feeds, posts, explore and notifications — what the Feed tab is drawn from.
 */
import { queryOptions } from "@tanstack/react-query";
import type {
  FeedKind,
  NotificationWire,
  PostWire,
  ProfileWire,
  ReportWire,
} from "@openbot/shared/social";
import { client } from "@/lib/client";

export const socialKeys = {
  all: ["social"] as const,
  me: () => ["social", "me"] as const,
  profile: (handle: string) => ["social", "profile", handle] as const,
  postsBy: (handle: string) => ["social", "posts-by", handle] as const,
  feed: (kind: FeedKind, spaceId?: string) =>
    ["social", "feed", kind, spaceId ?? ""] as const,
  explore: (q: string) => ["social", "explore", q] as const,
  post: (id: string) => ["social", "post", id] as const,
  comments: (id: string) => ["social", "comments", id] as const,
  notifications: () => ["social", "notifications"] as const,
  reports: (status?: string) => ["social", "reports", status ?? ""] as const,
};

/** What explore returns: people, posts, public spaces and trending tags. */
export type ExploreResult = {
  people: ProfileWire[];
  posts: PostWire[];
  spaces: { id: string; name: string }[];
  tags: { tag: string; posts: number }[];
};

export type NotificationsInbox = {
  notifications: NotificationWire[];
  unread: number;
};

export const myProfileQueryOptions = () =>
  queryOptions({
    queryKey: socialKeys.me(),
    queryFn: (): Promise<ProfileWire> =>
      client("/api/social/me", "profile", {
        fallback: "Couldn't load your profile.",
      }),
  });

export const profileQueryOptions = (handle: string) =>
  queryOptions({
    queryKey: socialKeys.profile(handle),
    queryFn: (): Promise<ProfileWire> =>
      client(
        `/api/social/people/${encodeURIComponent(handle)}`,
        "profile",
        { fallback: "Couldn't open that profile." },
      ),
  });

export const postsByQueryOptions = (handle: string) =>
  queryOptions({
    queryKey: socialKeys.postsBy(handle),
    queryFn: (): Promise<PostWire[]> =>
      client(
        `/api/social/people/${encodeURIComponent(handle)}/posts`,
        "posts",
        { fallback: "Couldn't load their posts." },
      ),
  });

export const feedQueryOptions = (kind: FeedKind, spaceId?: string) =>
  queryOptions({
    queryKey: socialKeys.feed(kind, spaceId),
    queryFn: (): Promise<PostWire[]> => {
      const params = new URLSearchParams({ kind });
      if (spaceId) params.set("spaceId", spaceId);
      return client(`/api/social/feed?${params}`, "posts", {
        fallback: "Couldn't load the feed.",
      });
    },
    refetchInterval: 30_000,
  });

export const exploreQueryOptions = (q: string) =>
  queryOptions({
    queryKey: socialKeys.explore(q),
    queryFn: async (): Promise<ExploreResult> => {
      // The explore route returns the search object itself (people, posts, spaces, tags), not an
      // envelope with one key — so we read the body as a whole rather than unwrapping a field.
      const response = await client(
        `/api/social/explore?q=${encodeURIComponent(q)}`,
        { fallback: "Couldn't search." },
      );
      const body = (await response.json()) as Partial<ExploreResult>;
      return {
        people: body.people ?? [],
        posts: body.posts ?? [],
        spaces: body.spaces ?? [],
        tags: body.tags ?? [],
      };
    },
  });

export const postQueryOptions = (id: string) =>
  queryOptions({
    queryKey: socialKeys.post(id),
    queryFn: (): Promise<PostWire> =>
      client(`/api/social/posts/${encodeURIComponent(id)}`, "post", {
        fallback: "Couldn't open that post.",
      }),
  });

export const commentsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: socialKeys.comments(id),
    queryFn: (): Promise<PostWire[]> =>
      client(
        `/api/social/posts/${encodeURIComponent(id)}/comments`,
        "comments",
        { fallback: "Couldn't load comments." },
      ),
  });

export const notificationsQueryOptions = () =>
  queryOptions({
    queryKey: socialKeys.notifications(),
    queryFn: async (): Promise<NotificationsInbox> => {
      // Inbox answers as `{ notifications, unread }`, never a bare array.
      const response = await client("/api/social/notifications", {
        fallback: "Couldn't load notifications.",
      });
      const body = (await response.json()) as Partial<NotificationsInbox>;
      return {
        notifications: body.notifications ?? [],
        unread: body.unread ?? 0,
      };
    },
    refetchInterval: 30_000,
  });

export const reportsQueryOptions = (status?: "open" | "resolved" | "dismissed") =>
  queryOptions({
    queryKey: socialKeys.reports(status),
    queryFn: (): Promise<ReportWire[]> =>
      client(
        `/api/admin/reports${status ? `?status=${status}` : ""}`,
        "reports",
        { fallback: "Couldn't load reports." },
      ),
  });
