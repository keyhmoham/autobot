import {
  FEED_KINDS,
  type FeedKind,
  type PostWire,
} from "@openbot/shared/social";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import {
  DuetCard,
  Row,
  Rule,
  Segmented,
  Tile,
} from "@/components/duet/kit";
import {
  createPostMutationOptions,
  likePostMutationOptions,
} from "@/lib/social/mutations";
import { feedQueryOptions } from "@/lib/social/queries";
import { cn } from "@/lib/utils";
import { ScreenScroll, ScreenTitle } from "./screen";

const FEED_OPTIONS: readonly { value: FeedKind; label: string }[] = [
  { value: "following", label: "Following" },
  { value: "everyone", label: "Everyone" },
  { value: "spaces", label: "Spaces" },
];

/** Confirm FEED_KINDS stays the switch's source of truth. */
void FEED_KINDS;

/**
 * The Feed tab: posts from people you follow, everybody, or your spaces, with a short composer and
 * links to explore and notifications.
 */
export function FeedScreen() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<FeedKind>("following");
  const [draft, setDraft] = useState("");
  const feed = useQuery(feedQueryOptions(kind));
  const create = useMutation(createPostMutationOptions(queryClient));

  return (
    <ScreenScroll>
      <ScreenTitle title="Feed">
        What people are saying, and what you want to share.
      </ScreenTitle>

      <div className="mb-4 flex gap-2">
        <Row
          leading={<Tile icon="search" size={36} />}
          link={({ className, children }) => (
            <Link className={cn(className, "flex-1")} to="/feed/explore">
              {children}
            </Link>
          )}
          title="Explore"
          detail="Find people and posts"
        />
        <Row
          leading={<Tile icon="bell" size={36} />}
          link={({ className, children }) => (
            <Link className={cn(className, "flex-1")} to="/feed/notifications">
              {children}
            </Link>
          )}
          title="Alerts"
          detail="Likes, follows, replies"
        />
      </div>

      <Segmented
        label="Which feed"
        onChange={setKind}
        options={FEED_OPTIONS}
        value={kind}
      />

      <DuetCard className="mt-4">
        <form
          className="flex flex-col gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const body = draft.trim();
            if (!body) return;
            create.mutate(
              { body },
              {
                onSuccess: () => setDraft(""),
              },
            );
          }}
        >
          <textarea
            className="type-body min-h-[88px] w-full resize-none bg-transparent text-duet-ink outline-none placeholder:text-duet-ink-3"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Share something…"
            value={draft}
          />
          {create.error ? (
            <p className="type-sub text-duet-red" role="alert">
              {create.error.message}
            </p>
          ) : null}
          <div className="flex justify-end">
            <button
              className="type-sub duet-touch rounded-full bg-duet-black px-4 font-medium text-duet-on-black disabled:opacity-50"
              disabled={!draft.trim() || create.isPending}
              type="submit"
            >
              Post
            </button>
          </div>
        </form>
      </DuetCard>

      <section className="mt-5 space-y-3">
        {feed.isPending ? null : feed.error ? (
          <p className="type-sub px-1 text-duet-red" role="alert">
            {feed.error.message}
          </p>
        ) : !feed.data?.length ? (
          <p className="type-sub px-1 text-duet-ink-2">
            Nothing here yet. Follow people, or be the first to post.
          </p>
        ) : (
          feed.data.map((post) => <PostCard key={post.id} post={post} />)
        )}
      </section>
    </ScreenScroll>
  );
}

/** One post on the feed or a profile: who said it, the body, and like / comments. */
export function PostCard({ post }: { post: PostWire }) {
  const queryClient = useQueryClient();
  const like = useMutation(likePostMutationOptions(queryClient));

  return (
    <DuetCard>
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <Link
            className="type-body font-medium text-duet-ink hover:underline"
            params={{ handle: post.author.handle }}
            to="/feed/people/$handle"
          >
            @{post.author.handle}
          </Link>
          <span className="type-caption shrink-0 text-duet-ink-3">
            {post.author.name}
          </span>
        </div>
        <p className="type-body whitespace-pre-wrap text-duet-ink [overflow-wrap:anywhere]">
          {post.body}
        </p>
        {post.space ? (
          <p className="type-caption text-duet-ink-2">in {post.space.name}</p>
        ) : null}
        {post.shared ? (
          <div className="rounded-[14px] bg-duet-tile px-3 py-2">
            <p className="type-caption text-duet-ink-2">
              @{post.shared.author.handle}
            </p>
            <p className="type-sub mt-0.5 text-duet-ink [overflow-wrap:anywhere]">
              {post.shared.body}
            </p>
          </div>
        ) : null}
      </div>
      <Rule />
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          className={cn(
            "type-sub duet-touch flex flex-1 items-center justify-center gap-1.5 rounded-[18px] font-medium",
            post.likedByYou ? "text-duet-accent" : "text-duet-ink-2",
          )}
          disabled={like.isPending}
          onClick={() =>
            like.mutate({ postId: post.id, like: !post.likedByYou })
          }
          type="button"
        >
          <DuetIcon
            name={post.likedByYou ? "check" : "sparkle"}
            size={16}
          />
          {post.likes}
        </button>
        <Link
          className="type-sub duet-touch flex flex-1 items-center justify-center gap-1.5 rounded-[18px] font-medium text-duet-ink-2"
          params={{ postId: post.id }}
          to="/feed/posts/$postId"
        >
          <DuetIcon name="chat" size={16} />
          {post.comments}
        </Link>
      </div>
      {like.error ? (
        <p className="type-sub px-4 pb-3 text-duet-red" role="alert">
          {like.error.message}
        </p>
      ) : null}
    </DuetCard>
  );
}
