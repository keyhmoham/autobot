import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { Row, Tile } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { openDirectMutationOptions } from "@/lib/spaces/mutations";
import { directsQueryOptions } from "@/lib/spaces/queries";

/** Private one-to-one conversations, outside any space. */
export const Route = createFileRoute("/_authed/_app/directs")({
  component: DirectsPage,
});

function DirectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const directs = useQuery(directsQueryOptions());
  const open = useMutation(openDirectMutationOptions(queryClient));
  const [handle, setHandle] = useState("");

  return (
    <PageShell
      backButton={{ linkProps: { to: "/spaces" }, label: "Spaces" }}
      description="Private conversations with one person."
      title="Directs"
    >
      <form
        className="mb-5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = handle.trim().replace(/^@/, "");
          if (!trimmed) return;
          open.mutate(
            { handle: trimmed },
            {
              onSuccess: (channel) =>
                void navigate({
                  to: "/spaces/channels/$channelId",
                  params: { channelId: channel.id },
                }),
            },
          );
        }}
      >
        <label className="duet-face flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[22px] bg-duet-tile px-3">
          <DuetIcon className="text-duet-ink-3" name="search" size={18} />
          <input
            className="type-body min-w-0 flex-1 bg-transparent text-duet-ink outline-none placeholder:text-duet-ink-3"
            onChange={(event) => setHandle(event.target.value)}
            placeholder="Open by handle…"
            value={handle}
          />
        </label>
        <button
          className="type-sub duet-touch shrink-0 rounded-full bg-duet-black px-4 font-medium text-duet-on-black disabled:opacity-50"
          disabled={!handle.trim() || open.isPending}
          type="submit"
        >
          Message
        </button>
      </form>
      {open.error ? (
        <p className="type-sub mb-3 text-duet-red" role="alert">
          {open.error.message}
        </p>
      ) : null}

      {directs.isPending ? null : directs.error ? (
        <p className="type-sub text-duet-red" role="alert">
          {directs.error.message}
        </p>
      ) : !directs.data?.length ? (
        <p className="type-sub text-duet-ink-2">
          No direct conversations yet. Open one by someone's handle.
        </p>
      ) : (
        <ul className="space-y-1">
          {directs.data.map((channel) => (
            <li key={channel.id}>
              <Row
                chevron
                leading={<Tile icon="chat" tone={channel.unread ? "violet" : "neutral"} />}
                link={({ className, children }) => (
                  <Link
                    className={className}
                    params={{ channelId: channel.id }}
                    to="/spaces/channels/$channelId"
                  >
                    {children}
                  </Link>
                )}
                title={channel.name}
                detail={channel.lastMessage ?? channel.purpose ?? "No messages yet"}
              />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
