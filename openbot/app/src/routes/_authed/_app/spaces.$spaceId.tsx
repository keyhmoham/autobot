import { can } from "@openbot/shared/workspace";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { DuetCard, Row, Rule, SectionLabel, Tile } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  createRoomChannelMutationOptions,
  createRoomMutationOptions,
} from "@/lib/spaces/mutations";
import { spaceQueryOptions } from "@/lib/spaces/queries";

/** One space: its rooms and channels, apps, and actions to make more of them. */
export const Route = createFileRoute("/_authed/_app/spaces/$spaceId")({
  component: SpaceDetailRoute,
});

function SpaceDetailRoute() {
  const { spaceId } = Route.useParams();
  const path =
    useRouterState({ select: (state) => state.location.pathname }).replace(
      /\/+$/,
      "",
    ) || "/";
  const atSpace = path === `/spaces/${spaceId}`;
  return (
    <>
      {atSpace ? <SpaceDetailPage spaceId={spaceId} /> : null}
      <Outlet />
    </>
  );
}

function SpaceDetailPage({ spaceId }: { spaceId: string }) {
  const queryClient = useQueryClient();
  const space = useQuery(spaceQueryOptions(spaceId));
  const createRoom = useMutation(createRoomMutationOptions(queryClient));
  const createChannel = useMutation(
    createRoomChannelMutationOptions(queryClient),
  );
  const [roomSheet, setRoomSheet] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [channelFor, setChannelFor] = useState<string | null>(null);
  const [channelName, setChannelName] = useState("");

  const role = space.data?.role ?? null;
  const mayRooms = can(role, "space.manage_rooms");
  const mayChannels = can(role, "room.create_channel");

  if (space.isPending) {
    return (
      <PageShell
        backButton={{ linkProps: { to: "/spaces" }, label: "Spaces" }}
        title="Space"
      >
        {null}
      </PageShell>
    );
  }
  if (space.error || !space.data) {
    return (
      <PageShell
        backButton={{ linkProps: { to: "/spaces" }, label: "Spaces" }}
        title="Space"
      >
        <p className="type-sub text-duet-red" role="alert">
          {space.error?.message ?? "Couldn't open this space."}
        </p>
      </PageShell>
    );
  }

  const detail = space.data;

  return (
    <PageShell
      action={
        mayRooms ? (
          <button
            className="type-sub duet-touch font-medium text-duet-accent"
            onClick={() => setRoomSheet(true)}
            type="button"
          >
            New room
          </button>
        ) : null
      }
      backButton={{ linkProps: { to: "/spaces" }, label: "Spaces" }}
      description={
        detail.description ||
        `${detail.memberCount} ${detail.memberCount === 1 ? "person" : "people"} · ${detail.visibility}`
      }
      title={detail.name}
    >
      <Row
        chevron
        leading={<Tile icon="box" tone="blue" />}
        link={({ className, children }) => (
          <Link
            className={className}
            params={{ spaceId }}
            to="/spaces/$spaceId/apps"
          >
            {children}
          </Link>
        )}
        size="nav"
        title="Apps"
        detail="Web apps this space's Bots built"
      />

      <section className="mt-5 space-y-4">
        {!detail.rooms.length ? (
          <p className="type-sub text-duet-ink-2">
            No rooms yet
            {mayRooms ? " — make one to start talking." : "."}
          </p>
        ) : (
          detail.rooms.map((room) => (
            <div className="space-y-2" key={room.id}>
              <div className="flex items-center justify-between gap-2 px-1">
                <SectionLabel>{room.name}</SectionLabel>
                <div className="flex items-center gap-2">
                  {mayChannels ? (
                    <button
                      className="type-caption font-medium text-duet-accent"
                      onClick={() => setChannelFor(room.id)}
                      type="button"
                    >
                      + Channel
                    </button>
                  ) : null}
                  <Link
                    className="type-caption font-medium text-duet-ink-2"
                    params={{ spaceId, roomId: room.id }}
                    to="/spaces/$spaceId/rooms/$roomId"
                  >
                    Desk
                  </Link>
                </div>
              </div>
              {room.topic ? (
                <p className="type-caption px-1 text-duet-ink-2">{room.topic}</p>
              ) : null}
              <DuetCard>
                {!room.channels.length ? (
                  <p className="type-sub px-4 py-3 text-duet-ink-2">
                    No conversations in this room yet.
                  </p>
                ) : (
                  room.channels.map((channel, index) => (
                    <div key={channel.id}>
                      {index > 0 ? <Rule inset /> : null}
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
                          channel.lastMessage ??
                          channel.purpose ??
                          "No messages yet"
                        }
                      />
                    </div>
                  ))
                )}
              </DuetCard>
            </div>
          ))
        )}
      </section>

      <Sheet onOpenChange={setRoomSheet} open={roomSheet}>
        <SheetContent
          className="duet-face max-h-[92svh] gap-0 overflow-y-auto rounded-t-[38px] border-0 bg-duet-surface text-duet-ink"
          showCloseButton={false}
          side="bottom"
        >
          <SheetHeader className="flex-row items-center justify-between px-4 pt-4 pb-0">
            <SheetTitle className="type-body font-semibold">New room</SheetTitle>
            <SheetClose
              render={
                <button
                  aria-label="Close"
                  className="duet-glass grid size-11 place-items-center rounded-full shadow-duet-glass"
                  type="button"
                />
              }
            >
              <DuetIcon name="x" size={18} />
            </SheetClose>
          </SheetHeader>
          <form
            className="flex flex-col gap-4 px-4 pt-5 pb-8"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = roomName.trim();
              if (!trimmed) return;
              createRoom.mutate(
                { spaceId, name: trimmed },
                {
                  onSuccess: () => {
                    setRoomSheet(false);
                    setRoomName("");
                  },
                },
              );
            }}
          >
            <input
              autoFocus
              className="type-body min-h-11 rounded-[16px] border border-duet-hair-2 bg-duet-card px-3 outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40"
              onChange={(event) => setRoomName(event.target.value)}
              placeholder="Room name"
              value={roomName}
            />
            {createRoom.error ? (
              <p className="type-sub text-duet-red" role="alert">
                {createRoom.error.message}
              </p>
            ) : null}
            <button
              className="type-body duet-touch rounded-full bg-duet-black font-medium text-duet-on-black disabled:opacity-50"
              disabled={!roomName.trim() || createRoom.isPending}
              type="submit"
            >
              Make room
            </button>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet
        onOpenChange={(open) => {
          if (!open) setChannelFor(null);
        }}
        open={channelFor !== null}
      >
        <SheetContent
          className="duet-face max-h-[92svh] gap-0 overflow-y-auto rounded-t-[38px] border-0 bg-duet-surface text-duet-ink"
          showCloseButton={false}
          side="bottom"
        >
          <SheetHeader className="flex-row items-center justify-between px-4 pt-4 pb-0">
            <SheetTitle className="type-body font-semibold">
              New conversation
            </SheetTitle>
            <SheetClose
              render={
                <button
                  aria-label="Close"
                  className="duet-glass grid size-11 place-items-center rounded-full shadow-duet-glass"
                  type="button"
                />
              }
            >
              <DuetIcon name="x" size={18} />
            </SheetClose>
          </SheetHeader>
          <form
            className="flex flex-col gap-4 px-4 pt-5 pb-8"
            onSubmit={(event) => {
              event.preventDefault();
              if (!channelFor) return;
              const trimmed = channelName.trim();
              if (!trimmed) return;
              createChannel.mutate(
                { roomId: channelFor, name: trimmed },
                {
                  onSuccess: () => {
                    setChannelFor(null);
                    setChannelName("");
                  },
                },
              );
            }}
          >
            <input
              autoFocus
              className="type-body min-h-11 rounded-[16px] border border-duet-hair-2 bg-duet-card px-3 outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40"
              onChange={(event) => setChannelName(event.target.value)}
              placeholder="Conversation name"
              value={channelName}
            />
            {createChannel.error ? (
              <p className="type-sub text-duet-red" role="alert">
                {createChannel.error.message}
              </p>
            ) : null}
            <button
              className="type-body duet-touch rounded-full bg-duet-black font-medium text-duet-on-black disabled:opacity-50"
              disabled={!channelName.trim() || createChannel.isPending}
              type="submit"
            >
              Make conversation
            </button>
          </form>
        </SheetContent>
      </Sheet>
    </PageShell>
  );
}
