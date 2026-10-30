/**
 * The social side over HTTP: `/api/social/*` for profiles, follows, posts, feeds, explore and
 * notifications, and `/api/admin/reports` for the posts people reported, administrators only.
 */
import { FEED_KINDS } from "@openbot/shared/social";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { personRoutes, type RouteMount } from "../workspace/routes";
import type { Social } from "./service";

type Env = { Variables: AppVariables };

const body = (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().catch(() => ({}));

export function createSocialRoutes(
  social: Social,
  requireUser: MiddlewareHandler<Env>,
): RouteMount[] {
  const routes = personRoutes(requireUser);
  const me = (c: { var: AppVariables }) => c.var.actor.id;

  routes.get("/me", async (c) =>
    c.json({ profile: await social.profile(me(c), me(c)) }),
  );
  routes.patch("/me", async (c) =>
    c.json({ profile: await social.updateProfile(me(c), await body(c)) }),
  );

  routes.get("/people/:handle", async (c) =>
    c.json({ profile: await social.profile(me(c), c.req.param("handle")) }),
  );
  routes.get("/people/:handle/posts", async (c) =>
    c.json({
      posts: await social.postsBy(
        me(c),
        c.req.param("handle"),
        c.req.query("before"),
      ),
    }),
  );
  for (const direction of ["followers", "following"] as const)
    routes.get(`/people/:handle/${direction}`, async (c) =>
      c.json({
        people: await social.connections(c.req.param("handle"), direction, {
          ...(c.req.query("before") ? { before: c.req.query("before") } : {}),
        }),
      }),
    );
  routes.post("/people/:handle/follow", async (c) =>
    c.json({ profile: await social.follow(me(c), c.req.param("handle")) }),
  );
  routes.delete("/people/:handle/follow", async (c) =>
    c.json({ profile: await social.unfollow(me(c), c.req.param("handle")) }),
  );

  routes.get("/feed", async (c) => {
    const kind = z
      .enum(FEED_KINDS)
      .catch("following")
      .parse(c.req.query("kind"));
    return c.json({
      posts: await social.feed(me(c), kind, {
        ...(c.req.query("before") ? { before: c.req.query("before") } : {}),
        ...(c.req.query("spaceId") ? { spaceId: c.req.query("spaceId") } : {}),
      }),
    });
  });
  routes.get("/explore", async (c) =>
    c.json(await social.search(me(c), c.req.query("q") ?? "")),
  );

  routes.post("/posts", async (c) =>
    c.json({ post: await social.create(me(c), await body(c)) }, 201),
  );
  routes.get("/posts/:id", async (c) =>
    c.json({ post: await social.get(me(c), c.req.param("id")) }),
  );
  routes.patch("/posts/:id", async (c) =>
    c.json({
      post: await social.update(me(c), c.req.param("id"), await body(c)),
    }),
  );
  routes.delete("/posts/:id", async (c) => {
    await social.remove(me(c), c.req.param("id"));
    return c.body(null, 204);
  });
  routes.post("/posts/:id/like", async (c) =>
    c.json({ post: await social.like(me(c), c.req.param("id")) }),
  );
  routes.delete("/posts/:id/like", async (c) =>
    c.json({ post: await social.unlike(me(c), c.req.param("id")) }),
  );
  routes.get("/posts/:id/comments", async (c) =>
    c.json({
      comments: await social.comments(me(c), c.req.param("id"), {
        ...(c.req.query("before") ? { before: c.req.query("before") } : {}),
      }),
    }),
  );
  routes.post("/posts/:id/comments", async (c) =>
    c.json(
      {
        comment: await social.comment(me(c), c.req.param("id"), await body(c)),
      },
      201,
    ),
  );
  routes.post("/posts/:id/share", async (c) =>
    c.json(
      { post: await social.share(me(c), c.req.param("id"), await body(c)) },
      201,
    ),
  );
  routes.post("/posts/:id/report", async (c) => {
    await social.report(me(c), c.req.param("id"), await body(c));
    return c.body(null, 204);
  });

  routes.get("/notifications", async (c) =>
    c.json(await social.inbox(me(c), c.req.query("before"))),
  );
  routes.post("/notifications/read", async (c) => {
    await social.markRead(me(c));
    return c.body(null, 204);
  });

  const admin = personRoutes(requireUser);
  admin.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  admin.get("/", async (c) => {
    const status = z
      .enum(["open", "resolved", "dismissed"])
      .optional()
      .catch(undefined)
      .parse(c.req.query("status"));
    return c.json({ reports: await social.reports(status) });
  });
  admin.post("/:id", async (c) => {
    const { action } = z
      .object({ action: z.enum(["resolve", "dismiss", "remove", "reopen"]) })
      .parse(await body(c));
    await social.resolveReport(c.var.actor.id, c.req.param("id"), action);
    return c.body(null, 204);
  });

  return [
    { path: "/api/social", routes },
    { path: "/api/admin/reports", routes: admin },
  ];
}
