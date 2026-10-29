import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createComputerRoutes,
  spaceComputerNeed,
} from "../src/computer/routes";

/**
 * A space's computer is reached through the same person-facing routes as a Bot's, and decided by the
 * person's role in the space: watching, driving by hand, and managing are three different asks.
 */
const SPACE = "space_8f2e6f3a-0d5c-4a8f-9a3e-0f6b6a1d2c3b";

function app(role: "member" | "guest" | "owner" | null) {
  const reached: string[] = [];
  const record =
    (name: string) =>
    async ({ computerId }: { computerId: string }, ..._rest: unknown[]) => {
      reached.push(`${name}:${computerId}`);
      return { ok: true };
    };
  const gateway = {
    status: record("status"),
    screenshot: record("screenshot"),
    takeControl: record("take"),
    resetComputer: record("reset"),
    navigate: record("navigate"),
  } as never;
  const routes = createComputerRoutes(
    gateway,
    { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
    async (context, next) => {
      context.set("actor", {
        id: "ana",
        email: "ana@openbot.test",
        role: "user",
      });
      await next();
    },
    async () => false,
    undefined,
    undefined,
    async (_userId, spaceId, need) =>
      spaceId === SPACE &&
      (need === "view"
        ? role !== null
        : need === "drive"
          ? role === "member" || role === "owner"
          : role === "owner"),
  );
  return {
    reached,
    hono: new Hono<{ Variables: AppVariables }>().route(
      "/api/computers",
      routes,
    ),
  };
}

const post = (
  hono: Hono<{ Variables: AppVariables }>,
  path: string,
  body = {},
) =>
  hono.request(`http://t/api/computers/${SPACE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("a space's computer", () => {
  test("each route asks for what it does", () => {
    expect(spaceComputerNeed("/status")).toBe("view");
    expect(spaceComputerNeed("/files/download")).toBe("view");
    expect(spaceComputerNeed("/control/take")).toBe("drive");
    expect(spaceComputerNeed("/human/type")).toBe("drive");
    expect(spaceComputerNeed("/computers/reset")).toBe("manage");
    // The Bot-acting routes are a person's own chat's; a space's Bots act through their turns.
    expect(spaceComputerNeed("/navigate")).toBeNull();
    expect(spaceComputerNeed("/exec")).toBeNull();
  });

  test("a guest watches but cannot drive or manage it", async () => {
    const { hono, reached } = app("guest");
    expect(
      (await hono.request(`http://t/api/computers/${SPACE}/status`)).status,
    ).toBe(200);
    expect((await post(hono, "/control/take", { requestId: "r" })).status).toBe(
      404,
    );
    expect((await post(hono, "/computers/reset")).status).toBe(404);
    expect(reached).toEqual([`status:${SPACE}`]);
  });

  test("a member drives it, only an owner resets it, and nobody acts as a Bot on it", async () => {
    const member = app("member");
    expect(
      (await post(member.hono, "/control/take", { requestId: "r" })).status,
    ).toBe(200);
    expect((await post(member.hono, "/computers/reset")).status).toBe(404);
    expect(
      (await post(member.hono, "/navigate", { url: "https://example.com" }))
        .status,
    ).toBe(404);
    expect(member.reached).toEqual([`take:${SPACE}`]);
    const owner = app("owner");
    expect((await post(owner.hono, "/computers/reset")).status).toBe(200);
    expect(owner.reached).toEqual([`reset:${SPACE}`]);
  });

  test("somebody outside the space finds nothing", async () => {
    const { hono, reached } = app(null);
    expect(
      (await hono.request(`http://t/api/computers/${SPACE}/screenshot`)).status,
    ).toBe(404);
    expect(reached).toEqual([]);
  });
});
