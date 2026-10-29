/**
 * Apps over HTTP: `/api/apps` for the space's people (list, open, logs, restart, stop, remove), and
 * `/apps-view/<link>/*`, which serves an app to whoever holds a link to it and answers nothing else.
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { personRoutes, type RouteMount } from "../workspace/routes";
import type { AppHand, Apps } from "./service";

type Env = { Variables: AppVariables };

export function createAppRoutes(
  apps: Apps,
  requireUser: MiddlewareHandler<Env>,
): RouteMount {
  const routes = personRoutes(requireUser);
  const hand = (c: { var: AppVariables }): AppHand => ({
    kind: "person",
    userId: c.var.actor.id,
  });
  routes.get("/", async (c) =>
    c.json({
      apps: await apps.list(c.var.actor.id, c.req.query("spaceId") ?? ""),
    }),
  );
  routes.get("/:id", async (c) =>
    c.json({ app: await apps.get(c.var.actor.id, c.req.param("id")) }),
  );
  routes.post("/:id/launch", async (c) =>
    c.json(await apps.launch(c.var.actor.id, c.req.param("id"))),
  );
  routes.get("/:id/logs", async (c) =>
    c.json(
      await apps.logs(
        c.var.actor.id,
        c.req.param("id"),
        Number(c.req.query("lines") ?? 200),
      ),
    ),
  );
  routes.post("/:id/restart", async (c) =>
    c.json({ app: await apps.restart(hand(c), c.req.param("id")) }),
  );
  routes.post("/:id/stop", async (c) =>
    c.json({ app: await apps.stop(hand(c), c.req.param("id")) }),
  );
  routes.delete("/:id", async (c) => {
    await apps.remove(hand(c), c.req.param("id"));
    return c.body(null, 204);
  });
  return { path: "/api/apps", routes };
}

/** The apps themselves, behind their links. No session is read here: the link is the whole say. */
export function createAppViewRoutes(apps: Apps): RouteMount {
  const routes = new Hono<Env>();
  const serve = (c: Context<Env>) => {
    const link = c.req.param("link") ?? "";
    const url = new URL(c.req.url);
    const prefix = `/apps-view/${link}`;
    // The bare link, without its slash, would resolve the app's relative paths one level too high.
    if (url.pathname === prefix)
      return c.redirect(`${prefix}/${url.search}`, 308);
    return apps.open(
      link,
      `${url.pathname.slice(prefix.length)}${url.search}`,
      c.req.raw,
    );
  };
  routes.all("/:link", serve);
  routes.all("/:link/*", serve);
  return { path: "/apps-view", routes };
}
