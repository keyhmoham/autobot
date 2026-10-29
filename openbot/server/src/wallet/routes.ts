/**
 * Wallets over HTTP: a person's own wallet and transfers (`/api/wallet`), a space's budget
 * (`/api/budgets/:spaceId`), and Admin → Billing (`/api/admin/billing`), administrators only.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { RouteMount } from "../workspace/routes";
import { workspaceErrorStatus } from "../workspace/routes";
import { WalletError, type Wallets } from "./service";

type Env = { Variables: AppVariables };

/** A sub-app that says what went wrong in its own words, wallet or workspace. */
function walletRoutes(requireUser: MiddlewareHandler<Env>) {
  const routes = new Hono<Env>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof WalletError)
      return context.json({ error: error.message }, error.status);
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

const body = (context: { req: { json: () => Promise<unknown> } }) =>
  context.req.json().catch(() => ({})) as Promise<Record<string, unknown>>;

const page = (before?: string, limit?: string) => ({
  ...(before && Number(before) > 0 ? { before: Number(before) } : {}),
  ...(limit ? { limit: Number(limit) } : {}),
});

const transfer = z.object({
  to: z.string().min(1, "Say who the credits are for."),
  amount: z.number(),
  note: z.string().max(200).optional(),
});

const mint = z.object({
  userId: z.string().min(1),
  amount: z.number(),
  description: z.string().max(200).optional(),
  expiresInDays: z.number().int().min(0).max(3650).nullable().optional(),
});

export function createWalletRoutes(
  wallets: Wallets,
  requireUser: MiddlewareHandler<Env>,
): RouteMount[] {
  const mine = walletRoutes(requireUser);
  mine.get("/", async (c) => {
    const userId = c.var.actor.id;
    const [wallet, grants, entries, settings] = await Promise.all([
      wallets.wallet(userId),
      wallets.grants(userId),
      wallets.entries(userId, { limit: 50 }),
      wallets.settings(),
    ]);
    return c.json({ wallet, grants, entries, billing: settings.enabled });
  });
  mine.get("/entries", async (c) =>
    c.json({
      entries: await wallets.entries(
        c.var.actor.id,
        page(c.req.query("before"), c.req.query("limit")),
      ),
    }),
  );
  mine.post("/transfers", async (c) => {
    const input = transfer.parse(await body(c));
    return c.json({
      wallet: await wallets.transfer({ fromUserId: c.var.actor.id, ...input }),
    });
  });

  const budgets = walletRoutes(requireUser);
  budgets.get("/:spaceId", async (c) =>
    c.json({
      budget: await wallets.budget(c.var.actor.id, c.req.param("spaceId")),
    }),
  );
  budgets.put("/:spaceId", async (c) =>
    c.json({
      budget: await wallets.setBudget(
        c.var.actor.id,
        c.req.param("spaceId"),
        (await body(c)).cap,
      ),
    }),
  );

  const admin = walletRoutes(requireUser);
  admin.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  admin.get("/settings", async (c) =>
    c.json({ settings: await wallets.settings() }),
  );
  admin.put("/settings", async (c) =>
    c.json({
      settings: await wallets.updateSettings(c.var.actor.id, await body(c)),
    }),
  );
  admin.get("/overview", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    return c.json(await wallets.overview(days));
  });
  admin.get("/wallets", async (c) =>
    c.json({ wallets: await wallets.balances(c.req.query("q")) }),
  );
  admin.get("/wallets/:userId/entries", async (c) =>
    c.json({
      entries: await wallets.entries(
        c.req.param("userId"),
        page(c.req.query("before"), c.req.query("limit")),
      ),
    }),
  );
  admin.post("/mint", async (c) =>
    c.json({ wallet: await wallets.mint(mint.parse(await body(c))) }, 201),
  );

  return [
    { path: "/api/wallet", routes: mine },
    { path: "/api/budgets", routes: budgets },
    { path: "/api/admin/billing", routes: admin },
  ];
}
