/**
 * A space's timeline over HTTP, for its timeline screen: `/api/timeline/:spaceId` for what happened
 * (or what was true at `asOf`), and `/api/timeline/:spaceId/things` for what it is about.
 */
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { personRoutes, type RouteMount } from "../workspace/routes";
import type { Timeline } from "./service";

type Env = { Variables: AppVariables };

const when = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export function createTimelineRoutes(
  timeline: Timeline,
  requireUser: MiddlewareHandler<Env>,
): RouteMount {
  const routes = personRoutes(requireUser);
  routes.get("/:spaceId", async (c) => {
    const from = when(c.req.query("from"));
    const to = when(c.req.query("to"));
    const asOf = when(c.req.query("asOf"));
    const about = c.req.query("about");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({
      events: await timeline.read(c.var.actor.id, c.req.param("spaceId"), {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(asOf ? { asOf } : {}),
        ...(about ? { about } : {}),
        limit,
      }),
    });
  });
  routes.get("/:spaceId/things", async (c) =>
    c.json({
      things: await timeline.things(
        c.var.actor.id,
        c.req.param("spaceId"),
        c.req.query("search"),
      ),
    }),
  );
  return { path: "/api/timeline", routes };
}
