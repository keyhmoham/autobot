import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { DuetCard, Row, Rule, SectionLabel, Tile } from "@/components/duet/kit";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  acceptInvitationMutationOptions,
  createSpaceMutationOptions,
  joinSpaceMutationOptions,
} from "@/lib/spaces/mutations";
import {
  myInvitationsQueryOptions,
  spacesDiscoverQueryOptions,
  spacesListQueryOptions,
} from "@/lib/spaces/queries";
import { cn } from "@/lib/utils";
import { ScreenScroll, ScreenTitle } from "./screen";

/**
 * The Spaces tab: the person's spaces, invitations waiting on them, direct messages, and a search
 * for public spaces they can join.
 */
export function SpacesScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const spaces = useQuery(spacesListQueryOptions());
  const invites = useQuery(myInvitationsQueryOptions());
  const accept = useMutation(acceptInvitationMutationOptions(queryClient));
  const create = useMutation(createSpaceMutationOptions(queryClient));
  const join = useMutation(joinSpaceMutationOptions(queryClient));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [discover, setDiscover] = useState("");
  const found = useQuery({
    ...spacesDiscoverQueryOptions(discover.trim()),
    enabled: discover.trim().length > 0,
  });

  return (
    <ScreenScroll
      overlay={
        <button
          aria-label="Make a space"
          className="absolute right-[16px] bottom-[calc(var(--duet-tab-space,0px)+14px)] z-20 grid size-[56px] place-items-center rounded-full bg-duet-black text-duet-on-black shadow-duet-raised transition-[filter,transform] hover:brightness-125 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 active:scale-95"
          onClick={() => setCreating(true)}
          type="button"
        >
          <DuetIcon name="plus" size={26} stroke={2.4} />
        </button>
      }
    >
      <ScreenTitle title="Spaces">
        Rooms and conversations you share with people and Bots.
      </ScreenTitle>

      <Row
        chevron
        leading={<Tile icon="chat" tone="blue" />}
        link={({ className, children }) => (
          <Link className={className} to="/directs">
            {children}
          </Link>
        )}
        size="nav"
        title="Directs"
        detail="Private conversations with one person"
      />

      {invites.data && invites.data.length > 0 ? (
        <section className="mt-5 space-y-2">
          <SectionLabel>Invitations</SectionLabel>
          <DuetCard>
            {invites.data.map((invite, index) => (
              <div key={invite.id}>
                {index > 0 ? <Rule /> : null}
                <div className="flex min-h-[66px] items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="type-body font-medium text-duet-ink">
                      {invite.spaceName}
                    </p>
                    <p className="type-sub text-duet-ink-2">
                      As {invite.role}
                      {invite.invitedBy.name
                        ? ` · from ${invite.invitedBy.name}`
                        : ""}
                    </p>
                  </div>
                  <button
                    className="type-sub duet-touch shrink-0 rounded-full bg-duet-black px-4 font-medium text-duet-on-black disabled:opacity-50"
                    disabled={accept.isPending}
                    onClick={() => accept.mutate({ id: invite.id })}
                    type="button"
                  >
                    Accept
                  </button>
                </div>
              </div>
            ))}
          </DuetCard>
          {accept.error ? (
            <p className="type-sub px-1 text-duet-red" role="alert">
              {accept.error.message}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-5 space-y-2">
        <SectionLabel>Your spaces</SectionLabel>
        {spaces.isPending ? null : spaces.error ? (
          <p className="type-sub px-1 text-duet-red" role="alert">
            {spaces.error.message}
          </p>
        ) : !spaces.data?.length ? (
          <p className="type-sub px-1 text-duet-ink-2">
            No spaces yet. Make one, or accept an invitation.
          </p>
        ) : (
          <ul className="space-y-1">
            {spaces.data.map((space) => (
              <li key={space.id}>
                <Row
                  chevron
                  leading={<Tile icon="globe" tone="violet" />}
                  link={({ className, children }) => (
                    <Link
                      className={className}
                      params={{ spaceId: space.id }}
                      to="/spaces/$spaceId"
                    >
                      {children}
                    </Link>
                  )}
                  size="nav"
                  title={space.name}
                  detail={
                    space.description ||
                    `${space.memberCount} ${space.memberCount === 1 ? "person" : "people"} · ${space.visibility}`
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 space-y-3">
        <SectionLabel>Discover</SectionLabel>
        <label className="duet-face flex min-h-11 items-center gap-2 rounded-[22px] bg-duet-tile px-3">
          <DuetIcon className="text-duet-ink-3" name="search" size={18} />
          <input
            className="type-body min-w-0 flex-1 bg-transparent text-duet-ink outline-none placeholder:text-duet-ink-3"
            onChange={(event) => setDiscover(event.target.value)}
            placeholder="Search public spaces"
            type="search"
            value={discover}
          />
        </label>
        {discover.trim() ? (
          found.isPending ? null : found.error ? (
            <p className="type-sub px-1 text-duet-red" role="alert">
              {found.error.message}
            </p>
          ) : !found.data?.length ? (
            <p className="type-sub px-1 text-duet-ink-2">
              No public spaces matched that.
            </p>
          ) : (
            <ul className="space-y-1">
              {found.data.map((space) => (
                <li key={space.id}>
                  <Row
                    leading={<Tile icon="globe" />}
                    title={space.name}
                    detail={space.description || space.visibility}
                    trailing={
                      space.role ? (
                        <Link
                          className="type-sub font-medium text-duet-accent"
                          params={{ spaceId: space.id }}
                          to="/spaces/$spaceId"
                        >
                          Open
                        </Link>
                      ) : (
                        <button
                          className="type-sub font-medium text-duet-accent disabled:opacity-50"
                          disabled={join.isPending}
                          onClick={() =>
                            join.mutate(space.id, {
                              onSuccess: (joined) =>
                                void navigate({
                                  to: "/spaces/$spaceId",
                                  params: { spaceId: joined.id },
                                }),
                            })
                          }
                          type="button"
                        >
                          Join
                        </button>
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )
        ) : null}
        {join.error ? (
          <p className="type-sub px-1 text-duet-red" role="alert">
            {join.error.message}
          </p>
        ) : null}
      </section>

      {/* Room for the floating + so the last row can scroll clear of it. */}
      <div aria-hidden className="h-20" />

      <Sheet onOpenChange={setCreating} open={creating}>
        <SheetContent
          className="duet-face max-h-[92svh] gap-0 overflow-y-auto rounded-t-[38px] border-0 bg-duet-surface text-duet-ink"
          showCloseButton={false}
          side="bottom"
        >
          <SheetHeader className="flex-row items-center justify-between px-4 pt-4 pb-0">
            <SheetTitle className="type-body font-semibold text-duet-ink">
              Make a space
            </SheetTitle>
            <SheetClose
              render={
                <button
                  aria-label="Close"
                  className="duet-glass grid size-11 place-items-center rounded-full text-duet-ink shadow-duet-glass"
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
              const trimmed = name.trim();
              if (!trimmed) return;
              create.mutate(
                { name: trimmed },
                {
                  onSuccess: (space) => {
                    setCreating(false);
                    setName("");
                    void navigate({
                      to: "/spaces/$spaceId",
                      params: { spaceId: space.id },
                    });
                  },
                },
              );
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="type-sub text-duet-ink-2">Name</span>
              <input
                autoFocus
                className={cn(
                  "type-body min-h-11 rounded-[16px] border border-duet-hair-2 bg-duet-card px-3 text-duet-ink outline-none",
                  "focus-visible:ring-3 focus-visible:ring-duet-accent/40",
                )}
                onChange={(event) => setName(event.target.value)}
                placeholder="Team, project, club…"
                value={name}
              />
            </label>
            {create.error ? (
              <p className="type-sub text-duet-red" role="alert">
                {create.error.message}
              </p>
            ) : null}
            <button
              className="type-body duet-touch rounded-full bg-duet-black font-medium text-duet-on-black disabled:opacity-50"
              disabled={!name.trim() || create.isPending}
              type="submit"
            >
              Make space
            </button>
          </form>
        </SheetContent>
      </Sheet>
    </ScreenScroll>
  );
}
