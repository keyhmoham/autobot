import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PostCard } from "@/components/shell/feed-screen";
import { SectionLabel } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { openDirectMutationOptions } from "@/lib/spaces/mutations";
import { followMutationOptions } from "@/lib/social/mutations";
import {
  postsByQueryOptions,
  profileQueryOptions,
} from "@/lib/social/queries";

/** Somebody's profile: follow them, message them when allowed, and their posts. */
export const Route = createFileRoute("/_authed/_app/feed/people/$handle")({
  component: FeedPersonPage,
});

function FeedPersonPage() {
  const { handle } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQueryOptions(handle));
  const posts = useQuery(postsByQueryOptions(handle));
  const follow = useMutation(followMutationOptions(queryClient));
  const message = useMutation(openDirectMutationOptions(queryClient));

  const person = profile.data;

  return (
    <PageShell
      action={
        person && !person.isYou ? (
          <div className="flex items-center gap-2">
            {person.canMessage ? (
              <button
                className="type-sub duet-touch font-medium text-duet-ink-2 disabled:opacity-50"
                disabled={message.isPending}
                onClick={() =>
                  message.mutate(
                    { handle: person.handle },
                    {
                      onSuccess: (channel) =>
                        void navigate({
                          to: "/spaces/channels/$channelId",
                          params: { channelId: channel.id },
                        }),
                    },
                  )
                }
                type="button"
              >
                Message
              </button>
            ) : null}
            <button
              className="type-sub duet-touch rounded-full bg-duet-black px-4 font-medium text-duet-on-black disabled:opacity-50"
              disabled={follow.isPending}
              onClick={() =>
                follow.mutate({
                  handle: person.handle,
                  follow: !person.isFollowing,
                })
              }
              type="button"
            >
              {person.isFollowing ? "Following" : "Follow"}
            </button>
          </div>
        ) : null
      }
      backButton={{ linkProps: { to: "/feed" }, label: "Feed" }}
      description={person?.bio || undefined}
      title={person ? `@${person.handle}` : "Profile"}
    >
      {profile.isPending ? null : profile.error || !person ? (
        <p className="type-sub text-duet-red" role="alert">
          {profile.error?.message ?? "Couldn't open that profile."}
        </p>
      ) : (
        <div className="mb-5 space-y-1">
          <p className="type-body font-medium text-duet-ink">{person.name}</p>
          <p className="type-sub text-duet-ink-2">
            {person.followers} followers · {person.following} following ·{" "}
            {person.posts} posts
            {person.followsYou ? " · follows you" : ""}
          </p>
          {follow.error ? (
            <p className="type-sub text-duet-red" role="alert">
              {follow.error.message}
            </p>
          ) : null}
          {message.error ? (
            <p className="type-sub text-duet-red" role="alert">
              {message.error.message}
            </p>
          ) : null}
        </div>
      )}

      <section className="space-y-3">
        <SectionLabel>Posts</SectionLabel>
        {posts.isPending ? null : posts.error ? (
          <p className="type-sub text-duet-red" role="alert">
            {posts.error.message}
          </p>
        ) : !posts.data?.length ? (
          <p className="type-sub text-duet-ink-2">No posts yet.</p>
        ) : (
          posts.data.map((post) => <PostCard key={post.id} post={post} />)
        )}
      </section>
    </PageShell>
  );
}
