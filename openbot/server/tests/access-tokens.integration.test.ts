import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  createAccessTokenRoutes,
  createAccessTokens,
  withAccessTokens,
} from "../src/auth/access-tokens";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { userRoles, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

type Env = { Variables: AppVariables };

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
let clock = new Date();
const tokens = createAccessTokens({ database, now: () => clock });
const people: string[] = [];

afterEach(async () => {
  clock = new Date();
  await database.delete(users).where(inArray(users.id, people.splice(0)));
});
afterAll(async () => {
  await database.$client.close();
});

async function person(role: "admin" | "user" | null = "user") {
  const id = `tokens-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Ana" });
  if (role) await database.insert(userRoles).values({ userId: id, role });
  people.push(id);
  return id;
}

/** A session that signs in whoever the `x-session` header names, standing in for the real one. */
const session: MiddlewareHandler<Env> = async (context, next) => {
  const id = context.req.header("x-session");
  if (!id) return context.json({ error: "Authentication required." }, 401);
  context.set("actor", { id, email: "", role: "user" });
  await next();
};

function app() {
  const requireUser = withAccessTokens(session, tokens);
  const routes = new Hono<Env>();
  const mounted = createAccessTokenRoutes(tokens, requireUser);
  routes.route(mounted.path, mounted.routes);
  routes.get("/api/me", requireUser, (c) => c.json(c.var.actor));
  return routes;
}

describe("an access token", () => {
  test("acts as the person who made it, with their role as it is now", async () => {
    const ana = await person("admin");
    const made = await app().request("/api/access-tokens", {
      method: "POST",
      headers: { "x-session": ana, "content-type": "application/json" },
      body: JSON.stringify({ name: "Laptop CLI" }),
    });
    expect(made.status).toBe(201);
    const { token } = (await made.json()) as { token: string };
    expect(token).toMatch(/^odt_[0-9a-f]{12}_/);

    const me = await app().request("/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await me.json()).toMatchObject({
      id: ana,
      role: "admin",
      credential: "token",
    });

    await database
      .update(userRoles)
      .set({ role: "user" })
      .where(eq(userRoles.userId, ana));
    const after = await app().request("/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await after.json()) as { role: string }).role).toBe("user");
    expect((await tokens.list(ana))[0]?.lastUsedAt).not.toBeNull();
  });

  test("cannot make another token, and stops working when revoked or expired", async () => {
    const ana = await person();
    const { token, accessToken } = await tokens.create(ana, {
      name: "Script",
      expiresInDays: 1,
    });
    const bearer = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const minted = await app().request("/api/access-tokens", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Another" }),
    });
    expect(minted.status).toBe(403);

    clock = new Date(Date.now() + 2 * 86_400_000);
    expect((await app().request("/api/me", { headers: bearer })).status).toBe(
      401,
    );
    clock = new Date();

    await tokens.revoke(ana, accessToken.id);
    const refused = await app().request("/api/me", {
      headers: { ...bearer, "x-session": ana },
    });
    // A bad token is refused outright, not passed over for the cookie that came with it.
    expect(refused.status).toBe(401);
    expect(await tokens.list(ana)).toEqual([]);
  });

  test("is refused for somebody with no role, and when it is guessed", async () => {
    const nobody = await person(null);
    const { token } = await tokens.create(nobody, { name: "x" });
    expect(await tokens.verify(token)).toBeNull();
    expect(await tokens.verify(`${token.slice(0, -2)}xx`)).toBeNull();
    expect(await tokens.verify("odt_nothing")).toBeNull();
  });
});
