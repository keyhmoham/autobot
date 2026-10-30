/**
 * Personal access tokens: a person's standing to act from a terminal, a script or the `openduet` CLI,
 * where there is no browser to hold a session.
 *
 * A token is `odt_<id>_<secret>`. Only a hash of the secret is kept, so the database cannot give one
 * back; it is shown once, when it is made. It acts as the person who made it, with their role as it
 * is at the time of each request, so taking somebody's admin role away takes it from their tokens
 * too. It is made only from a signed-in session, never with another token, so a token that leaks can
 * be revoked without having been able to make itself a successor first.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Database } from "../db/client";
import { userRoles, users } from "../db/schema";
import { accessTokens } from "../db/schema/access-tokens";
import type { AppVariables, AuthenticatedActor } from "./guards";

const PREFIX = "odt_";
/** How often a token's last use is written: often enough to read, rarely enough to cost nothing. */
const TOUCH_EVERY_MS = 60_000;

export type AccessTokenWire = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

const createInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Name the token, so you know it later.")
    .max(80),
  expiresInDays: z.number().int().min(1).max(3_650).nullable().optional(),
});

const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

const toWire = (row: typeof accessTokens.$inferSelect): AccessTokenWire => ({
  id: row.id,
  name: row.name,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export type AccessTokens = ReturnType<typeof createAccessTokens>;

export function createAccessTokens(deps: {
  database: Database;
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());

  async function create(userId: string, input: unknown) {
    const { name, expiresInDays } = createInput.parse(input);
    const id = randomBytes(6).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    const [row] = await database
      .insert(accessTokens)
      .values({
        id,
        userId,
        name,
        secretHash: hash(secret),
        expiresAt: expiresInDays
          ? new Date(now().getTime() + expiresInDays * 86_400_000)
          : null,
      })
      .returning();
    if (!row) throw new Error("The token was not saved.");
    return { token: `${PREFIX}${id}_${secret}`, accessToken: toWire(row) };
  }

  async function list(userId: string) {
    const rows = await database
      .select()
      .from(accessTokens)
      .where(
        and(eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)),
      )
      .orderBy(desc(accessTokens.createdAt));
    return rows.map(toWire);
  }

  async function revoke(userId: string, id: string) {
    await database
      .update(accessTokens)
      .set({ revokedAt: now() })
      .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId)));
  }

  /** The person a presented token acts as, or null for one that is unknown, revoked or expired. */
  async function verify(presented: string): Promise<AuthenticatedActor | null> {
    if (!presented.startsWith(PREFIX)) return null;
    const [id, ...rest] = presented.slice(PREFIX.length).split("_");
    const secret = rest.join("_");
    if (!id || !secret) return null;
    const [row] = await database
      .select({
        token: accessTokens,
        email: users.email,
        name: users.name,
        image: users.image,
      })
      .from(accessTokens)
      .innerJoin(users, eq(users.id, accessTokens.userId))
      .where(eq(accessTokens.id, id));
    if (!row) return null;
    const expected = Buffer.from(row.token.secretHash);
    const given = Buffer.from(hash(secret));
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return null;
    if (
      row.token.revokedAt ||
      (row.token.expiresAt && row.token.expiresAt <= now())
    )
      return null;
    const roles = (
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, row.token.userId))
    ).map((each) => each.role);
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;
    if (!role) return null;
    if (
      !row.token.lastUsedAt ||
      now().getTime() - row.token.lastUsedAt.getTime() > TOUCH_EVERY_MS
    )
      await database
        .update(accessTokens)
        .set({ lastUsedAt: now() })
        .where(eq(accessTokens.id, id));
    return {
      id: row.token.userId,
      email: row.email,
      name: row.name,
      image: row.image,
      role,
      credential: "token",
    };
  }

  return { create, list, revoke, verify };
}

/**
 * `requireUser`, also taking a bearer token. A request carrying a token is decided by the token alone
 * and refused when it is not good, rather than falling back to whatever cookie came with it.
 */
export function withAccessTokens(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  tokens: Pick<AccessTokens, "verify">,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const header = context.req.header("authorization") ?? "";
    const bearer = header.match(/^Bearer\s+(odt_\S+)$/i)?.[1];
    if (!bearer) return requireUser(context, next);
    const actor = await tokens.verify(bearer);
    if (!actor)
      return context.json({ error: "That access token is not valid." }, 401);
    context.set("actor", actor);
    await next();
  };
}

/** `/api/access-tokens`: a person's own tokens. Made only from a signed-in session; see the header. */
export function createAccessTokenRoutes(
  tokens: AccessTokens,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof z.ZodError)
      return context.json(
        { error: error.issues[0]?.message ?? "That request is not valid." },
        400,
      );
    console.error(error);
    return context.json({ error: "Something went wrong." }, 500);
  });
  routes.get("/", async (c) =>
    c.json({ tokens: await tokens.list(c.var.actor.id) }),
  );
  routes.post("/", async (c) => {
    if (c.var.actor.credential === "token")
      return c.json(
        {
          error:
            "Make access tokens from the app, signed in, not with another token.",
        },
        403,
      );
    return c.json(
      await tokens.create(c.var.actor.id, await c.req.json().catch(() => ({}))),
      201,
    );
  });
  routes.delete("/:id", async (c) => {
    await tokens.revoke(c.var.actor.id, c.req.param("id"));
    return c.body(null, 204);
  });
  return { path: "/api/access-tokens", routes };
}
