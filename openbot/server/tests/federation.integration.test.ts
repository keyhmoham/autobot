import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_BILLING_SETTINGS } from "@openbot/shared/wallet";
import { eq, inArray, like, or } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import {
  billingSettings,
  federationJoinCodes,
  federationLedger,
  federationLedgerCursors,
  federationNodes,
  federationNonces,
  federationSelf,
  federationTransfers,
  ledgerEntries,
  users,
} from "../src/db/schema";
import { createPeerRoutes } from "../src/federation/routes";
import { createFederation, type Federation } from "../src/federation/service";
import { generateNodeKeys, signRequest } from "../src/federation/signing";
import { createFederatedTransfers } from "../src/federation/transfers";
import { createWallets } from "../src/wallet/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const prefix = `fed-${randomUUID().slice(0, 8)}`;
const CENTRAL_URL = "https://central.example.test";
const PEER_URL = "https://peer.example.test";
const wallets = createWallets({ database });
const people: string[] = [];

/** What the peer answers when the central node calls it; replaced per test. */
let peerAnswers: (path: string, body: unknown) => Response | Promise<Response>;

async function wipe() {
  await database.delete(federationSelf);
  await database.delete(federationNodes);
  await database.delete(federationNonces);
  await database.delete(federationLedger);
  await database.delete(federationLedgerCursors);
  await database.delete(federationTransfers);
  await database
    .delete(federationJoinCodes)
    .where(like(federationJoinCodes.label, `${prefix}%`));
}

let central: Federation;
let app: Hono;

beforeEach(async () => {
  await wipe();
  peerAnswers = () => Response.json({ result: { delivered: true } });
  central = await createFederation({
    database,
    encryptionKey,
    publicUrl: CENTRAL_URL,
    name: "Central",
    central: true,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== PEER_URL) throw new Error("connection refused");
      return peerAnswers(url.pathname, JSON.parse(String(init?.body ?? "{}")));
    }) as typeof fetch,
  });
  const peer = createPeerRoutes(central);
  app = new Hono();
  app.route(peer.path, peer.routes);
});
afterEach(async () => {
  const ids = people.splice(0);
  if (ids.length) {
    await database
      .delete(ledgerEntries)
      .where(
        or(
          inArray(ledgerEntries.fromUserId, ids),
          inArray(ledgerEntries.toUserId, ids),
        ),
      );
    await database.delete(users).where(inArray(users.id, ids));
  }
  await wallets
    .updateSettings(prefix, DEFAULT_BILLING_SETTINGS)
    .catch(() => {});
  await database.delete(billingSettings);
  await wipe();
});
afterAll(async () => {
  await database.$client.close();
});

async function person() {
  const id = `${prefix}-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name: "Ana" });
  people.push(id);
  return { id, email };
}

/** A node joining the central one, played by its key alone. */
async function joinedPeer() {
  const keys = generateNodeKeys();
  const { code } = await central.createJoinCode(await adminId(), {
    label: `${prefix} peer`,
  });
  const response = await app.request("/fed/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      name: "Peer",
      url: PEER_URL,
      publicKey: keys.publicKey,
    }),
  });
  expect(response.status).toBe(200);
  const answer = (await response.json()) as {
    nodeId: string;
    central: { id: string };
  };
  const signed = (path: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return {
      method: "POST",
      headers: {
        ...signRequest({
          nodeId: answer.nodeId,
          keys,
          method: "POST",
          path,
          body,
        }),
        "content-type": "application/json",
      },
      body,
    };
  };
  return { ...answer, keys, signed, code };
}

let admin: string | undefined;
async function adminId() {
  admin ??= (await person()).id;
  return admin;
}
afterEach(() => {
  admin = undefined;
});

describe("joining", () => {
  test("a join code admits one node once, and the node is told who the centre is", async () => {
    const peer = await joinedPeer();
    expect(peer.nodeId).toMatch(/^nd_[0-9a-f]{20}$/);
    expect(peer.central.id).toBe(central.self().id as string);
    expect((await central.nodes()).map((node) => node.id)).toEqual([
      peer.nodeId,
    ]);
    const again = await app.request("/fed/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: peer.code,
        name: "Other",
        url: PEER_URL,
        publicKey: generateNodeKeys().publicKey,
      }),
    });
    expect(again.status).toBe(403);
    // This node is already central, so it joins nothing else.
    await expect(
      central.join({ centralUrl: CENTRAL_URL, code: "x" }),
    ).rejects.toThrow("already part");
  });
});

describe("signed requests", () => {
  test("are good once, from a registered node, with the body they were signed over", async () => {
    const peer = await joinedPeer();
    const request = peer.signed("/fed/ledger", { entries: [] });
    expect((await app.request("/fed/ledger", request)).status).toBe(200);
    // The same request again is a replay.
    expect((await app.request("/fed/ledger", request)).status).toBe(401);
    // A body changed after signing does not match.
    const tampered = peer.signed("/fed/ledger", { entries: [] });
    expect(
      (
        await app.request("/fed/ledger", {
          ...tampered,
          body: '{"entries":[1]}',
        })
      ).status,
    ).toBe(401);
    // Unsigned.
    expect(
      (await app.request("/fed/ledger", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    // A removed node is refused everywhere.
    await central.removeNode(peer.nodeId);
    expect(
      (
        await app.request(
          "/fed/ledger",
          peer.signed("/fed/ledger", { entries: [] }),
        )
      ).status,
    ).toBe(401);
  });

  test("only the central node says who is in the federation", async () => {
    const peer = await joinedPeer();
    const response = await app.request(
      "/fed/nodes",
      peer.signed("/fed/nodes", { nodes: [] }),
    );
    expect(response.status).toBe(403);
  });
});

describe("ledgers", () => {
  test("the central node keeps each node's entries once", async () => {
    const peer = await joinedPeer();
    const entries = [1, 2].map((seq) => ({
      seq,
      id: `led_${seq}`,
      type: "mint",
      category: null,
      fromUserId: null,
      toUserId: "someone",
      amount: 1_000 * seq,
      description: "Added",
      createdAt: new Date().toISOString(),
    }));
    for (let round = 0; round < 2; round++)
      expect(
        (
          await app.request(
            "/fed/ledger",
            peer.signed("/fed/ledger", { entries }),
          )
        ).status,
      ).toBe(200);
    const [ledger] = await central.ledgers();
    expect(ledger).toMatchObject({
      nodeId: peer.nodeId,
      entries: 2,
      minted: 3_000,
      spent: 0,
    });
  });
});

describe("credits across nodes", () => {
  test("a delivery from another node is credited once, to whoever the address names", async () => {
    createFederatedTransfers({ database, federation: central, wallets });
    const peer = await joinedPeer();
    const ana = await person();
    const delivery = {
      action: "wallet.receive",
      caller: { userId: "bo", name: "Bo" },
      body: {
        transferId: "fedtx_1",
        to: ana.email,
        amount: 300,
        note: "Thanks",
        from: "Bo",
      },
    };
    for (let round = 0; round < 2; round++)
      expect(
        (
          await app.request(
            "/fed/dispatch",
            peer.signed("/fed/dispatch", delivery),
          )
        ).status,
      ).toBe(200);
    expect((await wallets.wallet(ana.id)).balance).toBe(300);
    expect((await wallets.entries(ana.id))[0]?.description).toBe(
      "From Bo on Peer: Thanks",
    );
    const nobody = await app.request(
      "/fed/dispatch",
      peer.signed("/fed/dispatch", {
        ...delivery,
        body: {
          ...delivery.body,
          transferId: "fedtx_2",
          to: "nobody@example.test",
        },
      }),
    );
    expect(nobody.status).toBe(404);
    const unknown = await app.request(
      "/fed/dispatch",
      peer.signed("/fed/dispatch", { ...delivery, action: "admin.everything" }),
    );
    expect(unknown.status).toBe(404);
  });

  test("credits sent away are returned when refused, and kept trying while the node is away", async () => {
    const transfers = createFederatedTransfers({
      database,
      federation: central,
      wallets,
    });
    const peer = await joinedPeer();
    const ana = await person();
    await wallets.mint({ userId: ana.id, amount: 1_000 });

    peerAnswers = () =>
      Response.json(
        { error: "Nobody here has that email address." },
        { status: 404 },
      );
    expect(
      (
        await transfers.send({
          fromUserId: ana.id,
          nodeId: peer.nodeId,
          to: "x@peer.test",
          amount: 400,
        })
      ).status,
    ).toBe("returned");
    expect((await wallets.wallet(ana.id)).balance).toBe(1_000);

    let up = false;
    peerAnswers = () =>
      up
        ? Response.json({ result: { delivered: true } })
        : new Response("down", { status: 503 });
    const sent = await transfers.send({
      fromUserId: ana.id,
      nodeId: peer.nodeId,
      to: "y@peer.test",
      amount: 250,
    });
    expect(sent.status).toBe("pending");
    expect((await wallets.wallet(ana.id)).balance).toBe(750);
    up = true;
    expect(await transfers.retry()).toBe(1);
    const [row] = await database
      .select({ status: federationTransfers.status })
      .from(federationTransfers)
      .where(eq(federationTransfers.id, sent.id));
    expect(row?.status).toBe("delivered");
    expect((await wallets.wallet(ana.id)).balance).toBe(750);
    await expect(
      transfers.send({
        fromUserId: ana.id,
        nodeId: peer.nodeId,
        to: "z@peer.test",
        amount: 5_000,
      }),
    ).rejects.toMatchObject({ status: 402 });
  });
});
