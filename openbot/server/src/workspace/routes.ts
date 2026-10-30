/**
 * The workspace over HTTP: `/api/spaces`, `/api/rooms`, `/api/room-channels`, `/api/directs` and
 * `/api/invitations`. Every route is a person's, and every decision is the service's.
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { Desks } from "./desk";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "./errors";
import type { Invitations } from "./invitations";
import type { Workspace } from "./service";

type Env = { Variables: AppVariables };
export type RouteMount = { path: string; routes: Hono<Env> };

/** The status each workspace failure answers with; anything else is the server's own fault. */
export function workspaceErrorStatus(error: unknown): 400 | 403 | 404 | 500 {
  if (error instanceof WorkspaceNotFoundError) return 404;
  if (error instanceof WorkspaceForbiddenError) return 403;
  if (error instanceof WorkspaceRefusedError || error instanceof z.ZodError)
    return 400;
  return 500;
}

/** A sub-app that answers only for a signed-in person and says what went wrong in its own words. */
export function personRoutes(requireUser: MiddlewareHandler<Env>) {
  const routes = new Hono<Env>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    const status = workspaceErrorStatus(error);
    if (status === 500) console.error(error);
    return context.json(
      {
        error:
          status === 500
            ? "Something went wrong."
            : error instanceof z.ZodError
              ? (error.issues[0]?.message ?? "That request is not valid.")
              : error.message,
      },
      status,
    );
  });
  return routes;
}

const me = (context: Context<Env>) => context.var.actor.id;
const body = (context: Context<Env>) =>
  context.req.json().catch(() => ({})) as Promise<unknown>;

export function createWorkspaceRoutes(
  services: {
    workspace: Workspace;
    invitations: Invitations;
    desks: Desks;
    /** A page shown on a room's desk, for the people who read the room. */
    deskPage: (pageId: string) => Promise<unknown | null>;
  },
  requireUser: MiddlewareHandler<Env>,
): RouteMount[] {
  const { workspace, invitations, desks } = services;
  const spaces = personRoutes(requireUser);
  spaces.get("/", async (c) => c.json({ spaces: await workspace.list(me(c)) }));
  spaces.get("/discover", async (c) =>
    c.json({ spaces: await workspace.discover(me(c), c.req.query("q") ?? "") }),
  );
  spaces.post("/", async (c) =>
    c.json({ space: await workspace.create(me(c), await body(c)) }, 201),
  );
  spaces.get("/:spaceId", async (c) =>
    c.json({ space: await workspace.get(me(c), c.req.param("spaceId")) }),
  );
  spaces.patch("/:spaceId", async (c) =>
    c.json({
      space: await workspace.update(
        me(c),
        c.req.param("spaceId"),
        await body(c),
      ),
    }),
  );
  spaces.delete("/:spaceId", async (c) => {
    await workspace.remove(me(c), c.req.param("spaceId"));
    return c.body(null, 204);
  });
  spaces.post("/:spaceId/join", async (c) =>
    c.json({ space: await workspace.join(me(c), c.req.param("spaceId")) }),
  );
  spaces.get("/:spaceId/members", async (c) =>
    c.json({ members: await workspace.members(me(c), c.req.param("spaceId")) }),
  );
  spaces.patch("/:spaceId/members/:userId", async (c) => {
    await workspace.setRole(
      me(c),
      c.req.param("spaceId"),
      c.req.param("userId"),
      await body(c),
    );
    return c.body(null, 204);
  });
  spaces.delete("/:spaceId/members/:userId", async (c) => {
    await workspace.removeMember(
      me(c),
      c.req.param("spaceId"),
      c.req.param("userId"),
    );
    return c.body(null, 204);
  });
  spaces.get("/:spaceId/agents", async (c) =>
    c.json({ agents: await workspace.agents(me(c), c.req.param("spaceId")) }),
  );
  spaces.put("/:spaceId/agents/:agentId", async (c) => {
    await workspace.addAgent(
      me(c),
      c.req.param("spaceId"),
      c.req.param("agentId"),
    );
    return c.body(null, 204);
  });
  spaces.delete("/:spaceId/agents/:agentId", async (c) => {
    await workspace.removeAgent(
      me(c),
      c.req.param("spaceId"),
      c.req.param("agentId"),
    );
    return c.body(null, 204);
  });
  spaces.post("/:spaceId/rooms", async (c) =>
    c.json(
      {
        roomId: await workspace.createRoom(
          me(c),
          c.req.param("spaceId"),
          await body(c),
        ),
      },
      201,
    ),
  );
  spaces.put("/:spaceId/rooms/order", async (c) => {
    await workspace.reorderRooms(me(c), c.req.param("spaceId"), await body(c));
    return c.body(null, 204);
  });
  spaces.get("/:spaceId/invitations", async (c) =>
    c.json({
      invitations: await invitations.forSpace(me(c), c.req.param("spaceId")),
    }),
  );
  spaces.post("/:spaceId/invitations", async (c) =>
    c.json(
      await invitations.invite(me(c), c.req.param("spaceId"), await body(c)),
      201,
    ),
  );

  const rooms = personRoutes(requireUser);
  rooms.patch("/:roomId", async (c) => {
    await workspace.updateRoom(me(c), c.req.param("roomId"), await body(c));
    return c.body(null, 204);
  });
  rooms.delete("/:roomId", async (c) => {
    await workspace.deleteRoom(me(c), c.req.param("roomId"));
    return c.body(null, 204);
  });
  rooms.get("/:roomId/people", async (c) =>
    c.json({
      people: await workspace.roomPeople(me(c), c.req.param("roomId")),
    }),
  );
  rooms.put("/:roomId/members/:userId", async (c) => {
    await workspace.setRoomMember(
      me(c),
      c.req.param("roomId"),
      c.req.param("userId"),
      true,
    );
    return c.body(null, 204);
  });
  rooms.delete("/:roomId/members/:userId", async (c) => {
    await workspace.setRoomMember(
      me(c),
      c.req.param("roomId"),
      c.req.param("userId"),
      false,
    );
    return c.body(null, 204);
  });
  rooms.get("/:roomId/desk", async (c) =>
    c.json({ desk: await desks.get(me(c), c.req.param("roomId")) }),
  );
  rooms.post("/:roomId/desk", async (c) =>
    c.json(
      await desks.apply(
        c.req.param("roomId"),
        { kind: "person", userId: me(c) },
        await body(c),
      ),
    ),
  );
  rooms.get("/:roomId/desk/pages/:pageId", async (c) => {
    const roomId = c.req.param("roomId");
    const pageId = c.req.param("pageId");
    await desks.get(me(c), roomId);
    const shown = await desks.shows(
      roomId,
      (target) => target.kind === "page" && target.pageId === pageId,
    );
    const page = shown ? await services.deskPage(pageId) : null;
    if (!page) throw new WorkspaceNotFoundError("That page");
    return c.json({ page });
  });
  rooms.post("/:roomId/channels", async (c) =>
    c.json(
      {
        channel: await workspace.createChannel(
          me(c),
          c.req.param("roomId"),
          await body(c),
        ),
      },
      201,
    ),
  );

  const roomChannels = personRoutes(requireUser);
  roomChannels.get("/:channelId", async (c) =>
    c.json({
      channel: await workspace.channel(me(c), c.req.param("channelId")),
    }),
  );
  roomChannels.patch("/:channelId", async (c) =>
    c.json({
      channel: await workspace.updateChannel(
        me(c),
        c.req.param("channelId"),
        await body(c),
      ),
    }),
  );
  roomChannels.delete("/:channelId", async (c) => {
    await workspace.deleteChannel(me(c), c.req.param("channelId"));
    return c.body(null, 204);
  });
  roomChannels.post("/:channelId/read", async (c) => {
    await workspace.markRead(me(c), c.req.param("channelId"));
    return c.body(null, 204);
  });

  const directs = personRoutes(requireUser);
  directs.get("/", async (c) =>
    c.json({ directs: await workspace.directs(me(c)) }),
  );
  directs.post("/", async (c) =>
    c.json({ channel: await workspace.openDirect(me(c), await body(c)) }),
  );

  const invites = personRoutes(requireUser);
  invites.get("/", async (c) =>
    c.json({ invitations: await invitations.mine(me(c)) }),
  );
  invites.get("/preview", async (c) =>
    c.json({
      invitation: await invitations.preview(c.req.query("token") ?? ""),
    }),
  );
  invites.post("/accept", async (c) =>
    c.json(await invitations.accept(me(c), await body(c))),
  );
  invites.post("/:invitationId/decline", async (c) => {
    await invitations.decline(me(c), c.req.param("invitationId"));
    return c.body(null, 204);
  });
  invites.delete("/:invitationId", async (c) => {
    await invitations.revoke(me(c), c.req.param("invitationId"));
    return c.body(null, 204);
  });

  return [
    { path: "/api/spaces", routes: spaces },
    { path: "/api/rooms", routes: rooms },
    { path: "/api/room-channels", routes: roomChannels },
    { path: "/api/directs", routes: directs },
    { path: "/api/invitations", routes: invites },
  ];
}
