import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DuetCard, Row, Rule, SectionLabel, Tile } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { applyDeskMutationOptions } from "@/lib/spaces/mutations";
import {
  roomDeskQueryOptions,
  spaceQueryOptions,
} from "@/lib/spaces/queries";

/** A room: its conversations and the desk of windows and pins everyone in it shares. */
export const Route = createFileRoute(
  "/_authed/_app/spaces/$spaceId/rooms/$roomId",
)({
  component: RoomDeskPage,
});

function RoomDeskPage() {
  const { spaceId, roomId } = Route.useParams();
  const queryClient = useQueryClient();
  const space = useQuery(spaceQueryOptions(spaceId));
  const desk = useQuery(roomDeskQueryOptions(roomId));
  const apply = useMutation(applyDeskMutationOptions(queryClient));

  const room = space.data?.rooms.find((candidate) => candidate.id === roomId);
  const title = room?.name ?? "Room";

  return (
    <PageShell
      backButton={{
        linkProps: { to: "/spaces/$spaceId", params: { spaceId } },
        label: space.data?.name ?? "Space",
      }}
      description={room?.topic || "Channels and the shared desk"}
      title={title}
    >
      {space.error ? (
        <p className="type-sub mb-3 text-duet-red" role="alert">
          {space.error.message}
        </p>
      ) : null}

      <section className="space-y-2">
        <SectionLabel>Conversations</SectionLabel>
        {!room ? (
          space.isPending ? null : (
            <p className="type-sub text-duet-ink-2">Couldn't find this room.</p>
          )
        ) : !room.channels.length ? (
          <p className="type-sub text-duet-ink-2">
            No conversations in this room yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {room.channels.map((channel) => (
              <li key={channel.id}>
                <Row
                  chevron
                  leading={
                    <Tile
                      icon="chat"
                      tone={channel.unread ? "violet" : "neutral"}
                    />
                  }
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
                  detail={
                    channel.lastMessage ?? channel.purpose ?? "No messages yet"
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 space-y-2">
        <SectionLabel>Desk</SectionLabel>
        {desk.isPending ? null : desk.error ? (
          <p className="type-sub text-duet-red" role="alert">
            {desk.error.message}
          </p>
        ) : !desk.data ? null : (
          <>
            {!desk.data.windows.length ? (
              <p className="type-sub text-duet-ink-2">
                No windows open on this desk.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {desk.data.windows.map((window) => (
                  <DuetCard key={window.id}>
                    <div className="flex items-start gap-3 p-4">
                      <Tile icon="layout" tone="blue" />
                      <div className="min-w-0 flex-1">
                        <p className="type-body font-medium text-duet-ink">
                          {window.title}
                        </p>
                        <p className="type-sub text-duet-ink-2">
                          {window.target.kind}
                        </p>
                      </div>
                      <button
                        aria-label={`Close ${window.title}`}
                        className="type-caption duet-touch shrink-0 font-medium text-duet-ink-2 disabled:opacity-50"
                        disabled={apply.isPending}
                        onClick={() =>
                          apply.mutate({
                            roomId,
                            op: { op: "close", id: window.id },
                          })
                        }
                        type="button"
                      >
                        Close
                      </button>
                    </div>
                  </DuetCard>
                ))}
              </div>
            )}

            {desk.data.pins.length > 0 ? (
              <div className="mt-4 space-y-2">
                <SectionLabel>Pins</SectionLabel>
                <DuetCard>
                  {desk.data.pins.map((pin, index) => (
                    <div key={pin.id}>
                      {index > 0 ? <Rule /> : null}
                      <Row
                        leading={<Tile icon="pin" tone="amber" />}
                        title={pin.title}
                        detail={pin.target.kind}
                      />
                    </div>
                  ))}
                </DuetCard>
              </div>
            ) : null}

            {apply.error ? (
              <p className="type-sub text-duet-red" role="alert">
                {apply.error.message}
              </p>
            ) : null}
          </>
        )}
      </section>
    </PageShell>
  );
}
