/**
 * Federation over HTTP.
 *
 * `/fed/*` is what other nodes call: `info` and `join` answer anybody (a join is only as good as its
 * code), and everything else answers a signed request from a registered node and nothing else.
 * `/api/federation/nodes` is the list a person picks a node from when sending credits.
 * `/api/admin/federation` is Admin → Federation, administrators only.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { RouteMount } from "../workspace/routes";
import { type Federation, FederationError } from "./service";

type Env = { Variables: AppVariables };
type SignedEnv = {
  Variables: {
    sender: Awaited<ReturnType<Federation["verify"]>>;
    payload: unknown;
  };
};

function sayingWhy<E extends object>(routes: Hono<E>) {
  routes.onError((error, context) => {
    if (error instanceof FederationError)
      return context.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return context.json(
        { error: error.issues[0]?.message ?? "That request is not valid." },
        400,
      );
    console.error(error);
    return context.json({ error: "Something went wrong." }, 500);
  });
  return routes;
}

/** What other nodes call. */
export function createPeerRoutes(federation: Federation): RouteMount {
  const routes = sayingWhy(new Hono<SignedEnv>());
  routes.get("/info", (c) => c.json({ node: federation.self() }));
  routes.post("/join", async (c) =>
    c.json(await federation.acceptJoin(await c.req.json().catch(() => ({})))),
  );

  // Every route below answers only a signed request from a registered node, read once.
  const signed: MiddlewareHandler<SignedEnv> = async (c, next) => {
    const body = await c.req.text();
    c.set(
      "sender",
      await federation.verify({
        headers: c.req.raw.headers,
        method: c.req.method,
        path: c.req.path,
        body,
      }),
    );
    try {
      c.set("payload", body ? JSON.parse(body) : {});
    } catch {
      throw new FederationError(400, "The request body is not JSON.");
    }
    await next();
  };
  routes.post("/nodes", signed, async (c) =>
    c.json(await federation.receiveNodes(c.var.sender, c.var.payload)),
  );
  routes.post("/ledger", signed, async (c) =>
    c.json(await federation.receiveLedger(c.var.sender, c.var.payload)),
  );
  routes.post("/dispatch", signed, async (c) =>
    c.json(await federation.dispatch(c.var.sender, c.var.payload)),
  );
  return { path: "/fed", routes: routes as unknown as RouteMount["routes"] };
}

const joinCode = z.object({
  label: z.string().max(80).optional(),
  days: z.number().int().min(1).max(90).optional(),
});
const join = z.object({
  centralUrl: z.string().min(1, "Say where the central node is."),
  code: z.string().min(1, "Paste the join code."),
});

export function createFederationRoutes(
  federation: Federation,
  requireUser: MiddlewareHandler<Env>,
): RouteMount[] {
  const people = sayingWhy(new Hono<Env>());
  people.use("*", requireUser);
  people.get("/nodes", async (c) =>
    c.json({
      self: federation.self().id,
      nodes: (await federation.nodes())
        .filter((node) => node.status !== "removed")
        .map(({ id, name, status }) => ({ id, name, status })),
    }),
  );

  const admin = sayingWhy(new Hono<Env>());
  admin.use("*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  const body = (c: { req: { json: () => Promise<unknown> } }) =>
    c.req.json().catch(() => ({}));
  admin.get("/", async (c) => {
    const self = federation.self();
    return c.json({
      self,
      nodes: await federation.nodes(),
      joinCodes: self.isCentral ? await federation.joinCodes() : [],
      ledgers: self.isCentral ? await federation.ledgers() : [],
    });
  });
  admin.post("/join-codes", async (c) =>
    c.json(
      await federation.createJoinCode(
        c.var.actor.id,
        joinCode.parse(await body(c)),
      ),
      201,
    ),
  );
  admin.delete("/join-codes/:id", async (c) => {
    await federation.revokeJoinCode(c.req.param("id"));
    return c.body(null, 204);
  });
  admin.post("/join", async (c) =>
    c.json({ self: await federation.join(join.parse(await body(c))) }),
  );
  admin.delete("/nodes/:id", async (c) => {
    await federation.removeNode(c.req.param("id"));
    return c.body(null, 204);
  });
  admin.post("/heartbeat", async (c) => {
    await federation.heartbeat();
    return c.json({ nodes: await federation.nodes() });
  });

  return [
    { path: "/api/federation", routes: people },
    { path: "/api/admin/federation", routes: admin },
  ];
}
