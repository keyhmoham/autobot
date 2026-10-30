import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Row, Tile } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { markNotificationsReadMutationOptions } from "@/lib/social/mutations";
import { notificationsQueryOptions } from "@/lib/social/queries";

const KIND_WORDS: Record<string, string> = {
  follow: "followed you",
  like: "liked your post",
  comment: "commented on your post",
  share: "shared your post",
  mention: "mentioned you",
};

/** Notifications from follows, likes, comments and shares. */
export const Route = createFileRoute("/_authed/_app/feed/notifications")({
  component: FeedNotificationsPage,
});

function FeedNotificationsPage() {
  const queryClient = useQueryClient();
  const inbox = useQuery(notificationsQueryOptions());
  const markRead = useMutation(markNotificationsReadMutationOptions(queryClient));

  return (
    <PageShell
      action={
        (inbox.data?.unread ?? 0) > 0 ? (
          <button
            className="type-sub duet-touch font-medium text-duet-accent disabled:opacity-50"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate()}
            type="button"
          >
            Mark all read
          </button>
        ) : null
      }
      backButton={{ linkProps: { to: "/feed" }, label: "Feed" }}
      description={
        inbox.data
          ? inbox.data.unread
            ? `${inbox.data.unread} unread`
            : "You're caught up"
          : undefined
      }
      title="Notifications"
    >
      {inbox.isPending ? null : inbox.error ? (
        <p className="type-sub text-duet-red" role="alert">
          {inbox.error.message}
        </p>
      ) : !inbox.data?.notifications.length ? (
        <p className="type-sub text-duet-ink-2">No notifications yet.</p>
      ) : (
        <ul className="space-y-1">
          {inbox.data.notifications.map((item) => {
            const word = KIND_WORDS[item.kind] ?? item.kind;
            const postId = item.postId;
            return (
              <li key={item.id}>
                <Row
                  leading={
                    <Tile
                      icon={item.kind === "follow" ? "sparkle" : "bell"}
                      tone={item.readAt ? "neutral" : "violet"}
                    />
                  }
                  link={
                    postId
                      ? ({ className, children }) => (
                          <Link
                            className={className}
                            params={{ postId }}
                            to="/feed/posts/$postId"
                          >
                            {children}
                          </Link>
                        )
                      : ({ className, children }) => (
                          <Link
                            className={className}
                            params={{ handle: item.actor.handle }}
                            to="/feed/people/$handle"
                          >
                            {children}
                          </Link>
                        )
                  }
                  title={`@${item.actor.handle} ${word}`}
                  detail={item.excerpt ?? undefined}
                />
              </li>
            );
          })}
        </ul>
      )}
      {markRead.error ? (
        <p className="type-sub mt-3 text-duet-red" role="alert">
          {markRead.error.message}
        </p>
      ) : null}
    </PageShell>
  );
}
