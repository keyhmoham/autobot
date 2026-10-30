import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../src/args";
import { main } from "../src/index";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A deployment answering a few routes, recording what it was asked. */
function server(
  routes: Record<string, (request: Request) => Response | Promise<Response>>,
) {
  const asked: {
    method: string;
    path: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const request = new Request(url, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      auth: request.headers.get("authorization"),
      body,
    });
    const route = routes[`${request.method} ${url.pathname}`];
    return route
      ? route(request)
      : Response.json({ error: "Not found." }, { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

async function run(
  argv: string[],
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env,
    fetchImpl,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readLine: async () => "odt_pasted_secret",
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "openduet-cli-"));
  dirs.push(dir);
  return { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
}

const me = () =>
  Response.json({
    user: { id: "u1", email: "ana@example.test", name: "Ana", role: "admin" },
  });

describe("reading a command line", () => {
  test("takes flags in either spelling and keeps the rest in order", () => {
    expect(
      parseArgs([
        "send",
        "c1",
        "hello",
        "--bot",
        "scout",
        "--json",
        "--note=a b",
        "--",
        "--literal",
      ]),
    ).toEqual({
      positional: ["send", "c1", "hello", "--literal"],
      flags: { bot: "scout", json: true, note: "a b" },
    });
  });
});

describe("the CLI", () => {
  test("signs in with a pasted token, keeps it privately, and calls as that person", async () => {
    const env = await home();
    const api = server({
      "GET /api/me": me,
      "GET /api/spaces": () =>
        Response.json({
          spaces: [
            {
              id: "space_1",
              name: "Launch",
              kind: "team",
              role: "owner",
              memberCount: 3,
            },
          ],
        }),
    });
    const login = await run(
      ["login", "https://duet.example.test/"],
      api.fetchImpl,
      env,
    );
    expect(login).toMatchObject({
      code: 0,
      out: "Signed in to https://duet.example.test as Ana (admin).",
    });
    const config = join(
      env.XDG_CONFIG_HOME as string,
      "openduet",
      "config.json",
    );
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      server: "https://duet.example.test",
      token: "odt_pasted_secret",
    });
    expect((await stat(config)).mode & 0o777).toBe(0o600);

    const listed = await run(["spaces"], api.fetchImpl, env);
    expect(listed.out.split("\n")[1]).toMatch(
      /^space_1\s+Launch\s+team\s+owner\s+3$/,
    );
    expect(api.asked.at(-1)).toMatchObject({
      path: "/api/spaces",
      auth: "Bearer odt_pasted_secret",
    });
    const json = await run(["spaces", "--json"], api.fetchImpl, env);
    expect(JSON.parse(json.out)[0].id).toBe("space_1");
  });

  test("says what the server said when it refuses, and what is missing when used wrongly", async () => {
    const env = {
      ...(await home()),
      OPENDUET_URL: "https://duet.example.test",
      OPENDUET_TOKEN: "odt_env",
    };
    const api = server({
      "POST /api/wallet/transfers": () =>
        Response.json(
          { error: "Your wallet does not hold that much." },
          { status: 402 },
        ),
    });
    const refused = await run(
      ["wallet", "send", "bo@example.test", "5000000"],
      api.fetchImpl,
      env,
    );
    expect(refused).toMatchObject({
      code: 1,
      err: "Your wallet does not hold that much.",
    });
    expect(api.asked[0]?.body).toEqual({
      to: "bo@example.test",
      amount: 5_000_000,
    });

    expect((await run(["messages"], api.fetchImpl, env)).err).toContain(
      "Missing a channel.",
    );
    expect((await run(["teleport"], api.fetchImpl, env)).code).toBe(2);
    expect((await run(["whoami"], api.fetchImpl, await home())).err).toContain(
      "Not signed in",
    );
  });

  test("sends a message with an id of its own, and reads the channel back by name", async () => {
    const env = {
      OPENDUET_URL: "https://duet.example.test",
      OPENDUET_TOKEN: "odt_env",
    };
    const api = server({
      "POST /api/conversations/ch_1": () =>
        Response.json({ queued: true }, { status: 202 }),
      "GET /api/conversations/ch_1": () =>
        Response.json({
          bots: [{ id: "scout", name: "Scout" }],
          people: [{ userId: "u1", name: "Ana" }],
          messages: [
            {
              id: "m1",
              actorUserId: "u1",
              agentId: null,
              text: "What next?",
              status: "completed",
              createdAt: "2026-10-29T09:15:00Z",
            },
            {
              id: "m2",
              actorUserId: "u1",
              agentId: "scout",
              text: "Ship Friday.",
              status: "completed",
              createdAt: "2026-10-29T09:15:05Z",
            },
          ],
        }),
    });
    await run(
      ["send", "ch_1", "What", "next?", "--bot", "scout"],
      api.fetchImpl,
      env,
    );
    expect(api.asked[0]?.body).toMatchObject({
      text: "What next?",
      agentId: "scout",
    });
    expect(api.asked[0]?.body).toMatchObject({ id: expect.stringMatching(/^cli-/) });
    const read = await run(["messages", "ch_1"], api.fetchImpl, env);
    expect(read.out).toBe("09:15  Ana: What next?\n09:15  Scout: Ship Friday.");
  });

  test("opens an app by a link on the signed-in server, and calls any route raw", async () => {
    const env = {
      OPENDUET_URL: "https://duet.example.test",
      OPENDUET_TOKEN: "odt_env",
    };
    const api = server({
      "POST /api/apps/app_1/launch": () =>
        Response.json({ path: "/apps-view/abc.def/", version: 2 }),
      "GET /api/timeline/space_1": () => Response.json({ events: [] }),
    });
    expect((await run(["apps", "open", "app_1"], api.fetchImpl, env)).out).toBe(
      "https://duet.example.test/apps-view/abc.def/",
    );
    const raw = await run(
      ["call", "get", "/api/timeline/space_1"],
      api.fetchImpl,
      env,
    );
    expect(JSON.parse(raw.out)).toEqual({ events: [] });
  });
});
