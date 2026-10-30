import { describe, expect, test } from "bun:test";
import { AlreadyExistsError, NotFoundError } from "modal";

import { NameHeldError } from "../src/backend";
import { backendFromEnvironment } from "../src/backends";
import { createModalBackend } from "../src/backends/modal";
import { createNomadBackend } from "../src/backends/nomad";
import { namesFor } from "../src/names";

const names = (() => {
  const result = namesFor("space_1234");
  if (!result.ok) throw new Error(result.reason);
  return result.names;
})();

const ensureOptions = {
  image: "registry.example/openduet-agent-computer:1",
  environment: ["COMPUTER_BOT_ID=space_1234", "COMPUTER_TOKEN=secret"],
  readyTimeoutMs: 5_000,
};

/** A Nomad API that schedules every registered job straight away, and a computer that answers. */
function fakeNomad() {
  const jobs = new Map<string, Record<string, unknown>>();
  const registered: Record<string, unknown>[] = [];
  const deleted: { id: string; purge: boolean }[] = [];
  let index = 1;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.host === "10.0.0.5:31000") return new Response("ok");
    expect(new Headers(init?.headers).get("x-nomad-token")).toBe("nomad-token");
    const path = decodeURIComponent(url.pathname);
    if (path === "/v1/status/leader") return Response.json("10.0.0.1:4647");
    if (path === "/v1/jobs" && method === "POST") {
      const job = (
        JSON.parse(String(init?.body)) as { Job: Record<string, unknown> }
      ).Job;
      registered.push(job);
      jobs.set(job.ID as string, {
        ...job,
        Status: job.Type === "batch" ? "dead" : "running",
        Stop: false,
        SubmitTime: Date.now() * 1e6,
        allocations: [
          {
            ID: `alloc-${index}`,
            NodeID: "node-a",
            ClientStatus: "running",
            CreateIndex: index++,
            CreateTime: Date.now() * 1e6,
          },
        ],
      });
      return Response.json({ EvalID: "e" });
    }
    if (path === "/v1/jobs") {
      const prefix = url.searchParams.get("prefix") ?? "";
      return Response.json(
        [...jobs.values()].filter((job) => String(job.ID).startsWith(prefix)),
      );
    }
    const allocation = path.match(/^\/v1\/allocation\/(.+)$/);
    if (allocation)
      return Response.json({
        ID: allocation[1],
        ClientStatus: "running",
        CreateIndex: 1,
        AllocatedResources: {
          Shared: {
            Ports: [
              { Label: "computer", Value: 31000, To: 4100, HostIP: "10.0.0.5" },
            ],
          },
        },
      });
    const job = path.match(/^\/v1\/job\/([^/]+)(\/allocations)?$/);
    if (job) {
      const found = jobs.get(job[1] as string);
      if (!found) return new Response("job not found", { status: 404 });
      if (job[2]) return Response.json(found.allocations);
      if (method === "DELETE") {
        const purge = url.searchParams.get("purge") === "true";
        deleted.push({ id: job[1] as string, purge });
        if (purge) jobs.delete(job[1] as string);
        else
          jobs.set(job[1] as string, { ...found, Stop: true, Status: "dead" });
        return Response.json({ EvalID: "e" });
      }
      return Response.json(found);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { jobs, registered, deleted, fetchImpl };
}

describe("the Nomad backend", () => {
  test("registers a computer as a confined docker job and reports where it answers", async () => {
    const nomad = fakeNomad();
    const backend = createNomadBackend({
      address: "http://nomad.internal:4646",
      token: "nomad-token",
      datacenters: ["dc1"],
      fetchImpl: nomad.fetchImpl,
    });
    expect(await backend.reachable()).toBe(true);
    const state = await backend.ensure(names, ensureOptions);
    expect(state).toMatchObject({
      container: names.container,
      status: "running",
      url: "http://10.0.0.5:31000",
      port: 31000,
    });
    const job = nomad.registered[0] as {
      Meta: Record<string, string>;
      Datacenters: string[];
      TaskGroups: {
        Tasks: {
          Config: Record<string, unknown>;
          Env: Record<string, string>;
        }[];
      }[];
    };
    const task = job.TaskGroups[0]?.Tasks[0];
    expect(job.Meta["openbot.bot-id"]).toBe("space_1234");
    expect(job.Datacenters).toEqual(["dc1"]);
    expect(task?.Config).toMatchObject({
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
    });
    expect(task?.Env).toEqual({
      COMPUTER_BOT_ID: "space_1234",
      COMPUTER_TOKEN: "secret",
    });

    // Asked again for the same computer, nothing is registered again.
    await backend.ensure(names, ensureOptions);
    expect(nomad.registered).toHaveLength(1);
    // A new token is a new job version.
    await backend.ensure(names, {
      ...ensureOptions,
      environment: ["COMPUTER_TOKEN=rotated"],
    });
    expect(nomad.registered).toHaveLength(2);

    expect(await backend.listOwned()).toEqual([
      expect.objectContaining({
        botId: "space_1234",
        container: names.container,
        status: "running",
      }),
    ]);
    expect(await backend.stop(names)).toBe(true);
    expect((await backend.listOwned())[0]?.status).toBe("exited");
  });

  test("resets by emptying the profile on the node that ran it, and leaves other jobs alone", async () => {
    const nomad = fakeNomad();
    const backend = createNomadBackend({
      address: "http://nomad.internal:4646",
      token: "nomad-token",
      fetchImpl: nomad.fetchImpl,
    });
    await backend.ensure(names, ensureOptions);
    expect(await backend.reset(names)).toBe(true);
    const cleaner = nomad.registered[1] as {
      Type: string;
      Constraints: { RTarget: string }[];
      TaskGroups: { Tasks: { Config: { mount: { source: string }[] } }[] }[];
    };
    expect(cleaner.Type).toBe("batch");
    expect(cleaner.Constraints[0]?.RTarget).toBe("node-a");
    expect(cleaner.TaskGroups[0]?.Tasks[0]?.Config.mount).toEqual([
      { type: "volume", source: names.profileVolume, target: "/profiles" },
    ]);
    expect(nomad.jobs.size).toBe(0);
    expect(await backend.reset(names)).toBe(false);

    nomad.jobs.set(names.container, {
      ID: names.container,
      Meta: { owner: "someone-else" },
    });
    await expect(backend.ensure(names, ensureOptions)).rejects.toBeInstanceOf(
      NameHeldError,
    );
  });
});

/** Modal's client, as far as the backend uses it. */
function fakeModal() {
  type FakeSandbox = {
    sandboxId: string;
    tags: Record<string, string>;
    alive: boolean;
    params: Record<string, unknown>;
  };
  const sandboxes = new Map<string, FakeSandbox>();
  const deletedVolumes: string[] = [];
  let created = 0;
  const handle = (box: FakeSandbox) => ({
    sandboxId: box.sandboxId,
    getTags: async () => box.tags,
    terminate: async () => {
      box.alive = false;
    },
    poll: async () => (box.alive ? null : 0),
    tunnels: async () => ({
      4100: { url: `https://${box.sandboxId}.modal.run` },
    }),
  });
  const client = {
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    images: { fromRegistry: (tag: string) => ({ tag }) },
    secrets: { fromName: async (name: string) => ({ name }) },
    volumes: {
      fromName: async (name: string) => ({ name }),
      delete: async (name: string) => void deletedVolumes.push(name),
    },
    sandboxes: {
      fromName: async (_app: string, name: string) => {
        const box = sandboxes.get(name);
        if (!box?.alive) throw new NotFoundError("no sandbox");
        return handle(box);
      },
      create: async (
        _app: unknown,
        _image: unknown,
        params: Record<string, unknown>,
      ) => {
        const name = params.name as string;
        if (sandboxes.get(name)?.alive) throw new AlreadyExistsError("exists");
        const box = {
          sandboxId: `sb-${++created}`,
          tags: params.tags as Record<string, string>,
          alive: true,
          params,
        };
        sandboxes.set(name, box);
        return handle(box);
      },
      list: async function* () {
        for (const box of sandboxes.values()) yield handle(box);
      },
    },
  };
  return { client, sandboxes, deletedVolumes, created: () => created };
}

describe("the Modal backend", () => {
  const healthy = (async () => new Response("ok")) as unknown as typeof fetch;

  test("runs a computer as a named sandbox on its own volumes, reached through its tunnel", async () => {
    const modal = fakeModal();
    const backend = createModalBackend({
      appName: "openduet-computers",
      client: modal.client as never,
      fetchImpl: healthy,
    });
    const state = await backend.ensure(names, ensureOptions);
    expect(state).toMatchObject({
      status: "running",
      url: "https://sb-1.modal.run",
    });
    const params = modal.sandboxes.get(names.container)?.params as {
      volumes: Record<string, { name: string }>;
      encryptedPorts: number[];
      env: Record<string, string>;
    };
    expect(params.volumes["/workspace"]?.name).toBe(names.workspaceVolume);
    expect(params.encryptedPorts).toEqual([4100]);
    expect(params.env.COMPUTER_TOKEN).toBe("secret");

    await backend.ensure(names, ensureOptions);
    expect(modal.created()).toBe(1);
    await backend.ensure(names, {
      ...ensureOptions,
      image: "registry.example/openduet-agent-computer:2",
    });
    expect(modal.created()).toBe(2);

    expect(await backend.listOwned()).toEqual([
      expect.objectContaining({ botId: "space_1234", status: "running" }),
    ]);
    expect(await backend.reset(names)).toBe(true);
    expect(modal.deletedVolumes).toEqual([names.profileVolume]);
    expect(await backend.stop(names)).toBe(false);
  });
});

describe("choosing a backend", () => {
  test("is Docker unless told otherwise, and says what a backend is missing", () => {
    expect(backendFromEnvironment({})).toMatchObject({
      ok: true,
      backend: { name: "Docker" },
    });
    expect(backendFromEnvironment({ COMPUTER_BACKEND: "nomad" })).toMatchObject(
      { ok: false },
    );
    expect(
      backendFromEnvironment({
        COMPUTER_BACKEND: "nomad",
        NOMAD_ADDR: "http://nomad:4646",
      }),
    ).toMatchObject({ ok: true, backend: { name: "Nomad" } });
    expect(backendFromEnvironment({ COMPUTER_BACKEND: "modal" })).toMatchObject(
      { ok: false },
    );
    expect(
      backendFromEnvironment({ COMPUTER_BACKEND: "kubernetes" }),
    ).toMatchObject({ ok: false });
  });
});
