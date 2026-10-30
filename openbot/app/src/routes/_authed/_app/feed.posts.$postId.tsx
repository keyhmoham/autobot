import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PostCard } from "@/components/shell/feed-screen";
import { DuetCard, SectionLabel } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { commentMutationOptions } from "@/lib/social/mutations";
import {
  commentsQueryOptions,
  postQueryOptions,
} from "@/lib/social/queries";

/** One post and the comments under it. */
export const Route = createFileRoute("/_authed/_app/feed/posts/$postId")({
  component: FeedPostPage,
});

function FeedPostPage() {
  const { postId } = Route.useParams();
  const queryClient = useQueryClient();
  const post = useQuery(postQueryOptions(postId));
  const comments = useQuery(commentsQueryOptions(postId));
  const comment = useMutation(commentMutationOptions(queryClient));
  const [body, setBody] = useState("");

  return (
    <PageShell
      backButton={{ linkProps: { to: "/feed" }, label: "Feed" }}
      title="Post"
    >
      {post.isPending ? null : post.error || !post.data ? (
        <p className="type-sub text-duet-red" role="alert">
          {post.error?.message ?? "Couldn't open that post."}
        </p>
      ) : (
        <PostCard post={post.data} />
      )}

      <section className="mt-6 space-y-3">
        <SectionLabel>Comments</SectionLabel>
        <DuetCard>
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = body.trim();
              if (!trimmed) return;
              comment.mutate(
                { postId, body: trimmed },
                { onSuccess: () => setBody("") },
              );
            }}
          >
            <textarea
              className="type-body min-h-[72px] w-full resize-none bg-transparent outline-none placeholder:text-duet-ink-3"
              onChange={(event) => setBody(event.target.value)}
              placeholder="Write a comment…"
              value={body}
            />
            {comment.error ? (
              <p className="type-sub text-duet-red" role="alert">
                {comment.error.message}
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                className="type-sub duet-touch rounded-full bg-duet-black px-4 font-medium text-duet-on-black disabled:opacity-50"
                disabled={!body.trim() || comment.isPending}
                type="submit"
              >
                Comment
              </button>
            </div>
          </form>
        </DuetCard>

        {comments.isPending ? null : comments.error ? (
          <p className="type-sub text-duet-red" role="alert">
            {comments.error.message}
          </p>
        ) : !comments.data?.length ? (
          <p className="type-sub text-duet-ink-2">No comments yet.</p>
        ) : (
          comments.data.map((entry) => (
            <PostCard key={entry.id} post={entry} />
          ))
        )}
      </section>
    </PageShell>
  );
}
