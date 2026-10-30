import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSpec, createServices, type Services } from "../src/services";

const running: Services[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const services of running.splice(0)) await services.shutdown();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "services-"));
  dirs.push(dir);
  return dir;
}

function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port as number;
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting.");
}

const SERVER = `Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: (r) => new URL(r.url).pathname === "/crash" ? process.exit(3) : Response.json({ path: new URL(r.url).pathname + new URL(r.url).search, cookie: r.headers.get("cookie"), secret: process.env.COMPUTER_TOKEN ?? null }) }); console.log("ready on", process.env.PORT);`;

describe("checking a service", () => {
  test("keeps it inside the workspace, on a usable port, with a usable name", async () => {
    const dir = await workspace();
    expect(
      checkSpec(
        { name: "notes", command: "x", cwd: "apps/notes", port: 3000 },
        dir,
      ).cwd,
    ).toBe("apps/notes");
    expect(() =>
      checkSpec({ name: "Notes!", command: "x", port: 3000 }, dir),
    ).toThrow("lower-case");
    expect(() =>
      checkSpec({ name: "n", command: "x", cwd: "../etc", port: 3000 }, dir),
    ).toThrow("inside the workspace");
    expect(() => checkSpec({ name: "n", command: "x", port: 80 }, dir)).toThrow(
      "port",
    );
    expect(() =>
      checkSpec(
        { name: "n", command: "x", port: 3000, env: { LD_PRELOAD: "/x.so" } },
        dir,
      ),
    ).toThrow("cannot be set");
  });
});

describe("a running service", () => {
  test("serves through the computer, keeps its output, and is restarted when it dies", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "server.ts"), SERVER);
    const services = createServices(dir, {
      ...process.env,
      COMPUTER_TOKEN: "do-not-leak",
    });
    running.push(services);
    const port = freePort();
    await services.start({
      name: "notes",
      command: "exec bun server.ts",
      port,
    });
    await until(async () => (await services.list())[0]?.listening === true);

    const answer = await services.forward(
      "notes",
      "/items?x=1",
      new Request("http://computer/services/notes/http/items?x=1", {
        headers: { cookie: "session=secret", "x-openbot-computer-token": "t" },
      }),
    );
    // The app sees its own path, never the viewer's cookie, and never the computer's secrets.
    expect(await answer.json()).toEqual({
      path: "/items?x=1",
      cookie: null,
      secret: null,
    });
    expect(services.logs("notes")?.join("\n")).toContain(`ready on ${port}`);

    await services
      .forward("notes", "/crash", new Request("http://computer/crash"))
      .catch(() => undefined);
    await until(async () => (await services.list())[0]?.restarts === 1);
    await until(async () => (await services.list())[0]?.listening === true);
    expect((await services.list())[0]?.lastExit?.code).toBe(3);

    expect(await services.stop("notes")).toBe(true);
    expect(await services.list()).toEqual([]);
    expect(
      (await services.forward("notes", "/", new Request("http://computer/")))
        .status,
    ).toBe(404);
  });

  test("comes back after a restart, and is refused a port another service holds", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "server.ts"), SERVER);
    const port = freePort();
    const first = createServices(dir);
    await first.start({ name: "board", command: "exec bun server.ts", port });
    await expect(
      first.start({ name: "other", command: "true", port }),
    ).rejects.toThrow("already board's");
    await first.shutdown();

    const second = createServices(dir);
    running.push(second);
    await second.restore();
    await until(async () => (await second.list())[0]?.listening === true);
    expect((await second.list()).map((service) => service.name)).toEqual([
      "board",
    ]);
  });

  test("is given up on when it keeps crashing", async () => {
    const dir = await workspace();
    let clock = Date.now();
    const services = createServices(dir, process.env, () => clock);
    running.push(services);
    await services.start({
      name: "broken",
      command: "exit 1",
      port: freePort(),
    });
    await until(async () => {
      clock += 1;
      return (await services.list())[0]?.status === "crashed";
    }, 40_000);
    expect(services.logs("broken")?.join("\n")).toContain(
      "[service exited: code 1]",
    );
  }, 45_000);
});
