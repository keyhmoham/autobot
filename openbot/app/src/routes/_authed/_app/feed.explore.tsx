import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PostCard } from "@/components/shell/feed-screen";
import { DuetIcon } from "@/components/duet/icons";
import { Row, SectionLabel, Tile } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { exploreQueryOptions } from "@/lib/social/queries";

/** Search people and posts across the social side. */
export const Route = createFileRoute("/_authed/_app/feed/explore")({
  component: FeedExplorePage,
});

function FeedExplorePage() {
  const [query, setQuery] = useState("");
  const explore = useQuery(exploreQueryOptions(query.trim()));

  return (
    <PageShell
      backButton={{ linkProps: { to: "/feed" }, label: "Feed" }}
      description="Find people and posts."
      title="Explore"
    >
      <label className="duet-face mb-5 flex min-h-11 items-center gap-2 rounded-[22px] bg-duet-tile px-3">
        <DuetIcon className="text-duet-ink-3" name="search" size={18} />
        <input
          autoFocus
          className="type-body min-w-0 flex-1 bg-transparent text-duet-ink outline-none placeholder:text-duet-ink-3"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people or posts"
          type="search"
          value={query}
        />
      </label>

      {explore.isPending ? null : explore.error ? (
        <p className="type-sub text-duet-red" role="alert">
          {explore.error.message}
        </p>
      ) : (
        <div className="space-y-6">
          <section className="space-y-2">
            <SectionLabel>People</SectionLabel>
            {!explore.data?.people.length ? (
              <p className="type-sub text-duet-ink-2">No people matched.</p>
            ) : (
              <ul className="space-y-1">
                {explore.data.people.map((person) => (
                  <li key={person.userId}>
                    <Row
                      chevron
                      leading={<Tile icon="sparkle" />}
                      link={({ className, children }) => (
                        <Link
                          className={className}
                          params={{ handle: person.handle }}
                          to="/feed/people/$handle"
                        >
                          {children}
                        </Link>
                      )}
                      title={`@${person.handle}`}
                      detail={person.name}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <SectionLabel>Posts</SectionLabel>
            {!explore.data?.posts.length ? (
              <p className="type-sub text-duet-ink-2">No posts matched.</p>
            ) : (
              explore.data.posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))
            )}
          </section>
        </div>
      )}
    </PageShell>
  );
}
