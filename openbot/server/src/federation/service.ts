/**
 * Federation: this deployment as one node of a mesh of OpenDuet deployments.
 *
 * Every node has an Ed25519 key of its own, made the first time it starts. The central node (the
 * one started with FEDERATION_CENTRAL=true) gives itself an id; any other node gets one by joining:
 * an administrator of the central node makes a join code, an administrator of the joining node
 * enters it with the central node's address, and the central node registers the newcomer, tells it
 * about every other node, and tells every other node about it.
 *
 * From then on nodes talk only in signed requests (federation/signing.ts), checked against the key
 * the central node registered for the sender, each good once. What they say to each other is a
 * small, named set of actions (`register`/`call`), never a pass-through to this node's own API: a
 * node can ask for exactly what was built to be asked for, and nothing a person's session can do.
 *
 * Each node sends its ledger to the central node, which keeps every node's beside its own, so the
 * platform's money can be read in one place.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type JoinCodeWire,
  type NodeLedgerWire,
  type NodeWire,
  type SelfNodeWire,
  SIGNATURE_WINDOW_SECONDS,
} from "@openbot/shared/federation";
import { and, asc, desc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import {
  federationJoinCodes,
  federationLedger,
  federationLedgerCursors,
  federationNodes,
  federationNonces,
  federationSelf,
} from "../db/schema/federation";
import { ledgerEntries } from "../db/schema/wallet";
import {
  checkSignature,
  generateNodeKeys,
  type NodeKeyPair,
  newNodeId,
  signRequest,
} from "./signing";

export class FederationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

/** Who asked, on the node that asked: the node always, and the person when there is one. */
export type RemoteOrigin = {
  nodeId: string;
  nodeName: string;
  caller: { userId: string; name: string } | null;
};

export type FederatedAction = (
  body: unknown,
  origin: RemoteOrigin,
) => Promise<unknown>;

const JOIN_CODE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15_000;

const joinRequest = z.object({
  code: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  url: z.string().url(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "That is not a node key."),
});

const nodeRow = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string().url(),
  publicKey: z.string().min(1),
  isCentral: z.boolean(),
  status: z.enum(["online", "offline", "removed"]),
});

const ledgerBatch = z.object({
  entries: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        id: z.string(),
        type: z.enum(["mint", "transfer", "spend", "expire"]),
        category: z.enum(["llm", "compute", "app"]).nullable(),
        fromUserId: z.string().nullable(),
        toUserId: z.string().nullable(),
        amount: z.number().int().positive(),
        description: z.string(),
        createdAt: z.string(),
      }),
    )
    .max(1000),
});

const hashCode = (code: string) =>
  createHash("sha256").update(code).digest("hex");

const toWire = (row: typeof federationNodes.$inferSelect): NodeWire => ({
  id: row.id,
  name: row.name,
  url: row.url,
  publicKey: row.publicKey,
  isCentral: row.isCentral,
  status: row.status,
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
});

export type Federation = Awaited<ReturnType<typeof createFederation>>;

export async function createFederation(deps: {
  database: Database;
  encryptionKey: string;
  /** Where other nodes reach this one. Without it this node can be central to nobody and join nothing. */
  publicUrl: string | undefined;
  name: string;
  central: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const { database } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const actions = new Map<string, FederatedAction>();

  /** Who this node is, made the first time it starts and kept from then on. */
  async function loadSelf() {
    const [existing] = await database.select().from(federationSelf).limit(1);
    if (existing) {
      if (deps.central && !existing.nodeId) {
        const [promoted] = await database
          .update(federationSelf)
          .set({ nodeId: newNodeId(now().getTime()), isCentral: true })
          .returning();
        return promoted ?? existing;
      }
      return existing;
    }
    const keys = generateNodeKeys();
    const [created] = await database
      .insert(federationSelf)
      .values({
        nodeId: deps.central ? newNodeId(now().getTime()) : null,
        name: deps.name,
        publicKey: keys.publicKey,
        privateKey: await encryptSecret(deps.encryptionKey, keys.privateKey),
        isCentral: deps.central,
      })
      .onConflictDoNothing()
      .returning();
    // Another replica made it first: read what it made.
    return (
      created ?? (await database.select().from(federationSelf).limit(1))[0]
    );
  }

  let self = await loadSelf();
  if (!self) throw new Error("This node's identity could not be made.");
  const keys: NodeKeyPair = {
    publicKey: self.publicKey,
    privateKey: await decryptSecret(deps.encryptionKey, self.privateKey),
  };

  function selfWire(): SelfNodeWire {
    return {
      id: self?.nodeId ?? null,
      name: self?.name ?? deps.name,
      url: deps.publicUrl ?? null,
      publicKey: keys.publicKey,
      isCentral: self?.isCentral ?? false,
    };
  }

  const joinedId = () => {
    if (!self?.nodeId)
      throw new FederationError(409, "This node has not joined a federation.");
    return self.nodeId;
  };

  async function nodes(): Promise<NodeWire[]> {
    const rows = await database
      .select()
      .from(federationNodes)
      .orderBy(desc(federationNodes.isCentral), asc(federationNodes.createdAt));
    return rows.map(toWire);
  }

  async function node(nodeId: string) {
    const [row] = await database
      .select()
      .from(federationNodes)
      .where(eq(federationNodes.id, nodeId));
    if (!row || row.status === "removed")
      throw new FederationError(
        404,
        "That node is not part of this federation.",
      );
    return row;
  }

  /* -------------------------------------------------------- talking to nodes */

  /** A signed request to another node, answered with its JSON or a FederationError saying why not. */
  async function send(
    target: { id: string; url: string },
    path: string,
    payload: unknown,
  ): Promise<unknown> {
    const body = JSON.stringify(payload ?? {});
    const headers = signRequest({
      nodeId: joinedId(),
      keys,
      method: "POST",
      path,
      body,
      now: now().getTime(),
    });
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, target.url), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FederationError(
        502,
        `The node at ${target.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const answer = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    if (!response.ok) {
      const message =
        typeof answer?.error === "string"
          ? answer.error
          : `The node answered ${response.status}.`;
      throw new FederationError(
        response.status >= 500 ? 502 : response.status === 404 ? 404 : 400,
        message,
      );
    }
    return answer;
  }

  /**
   * Whether a request is signed by a node registered here and has not been seen before. The nonce is
   * recorded in the same breath, so of two replicas handed the same request only one accepts it.
   */
  async function verify(request: {
    headers: Headers;
    method: string;
    path: string;
    body: string;
  }) {
    const check = await checkSignature({
      ...request,
      now: now().getTime(),
      publicKeyOf: async (nodeId) => {
        const [row] = await database
          .select({
            key: federationNodes.publicKey,
            status: federationNodes.status,
          })
          .from(federationNodes)
          .where(eq(federationNodes.id, nodeId));
        return row && row.status !== "removed" ? row.key : null;
      },
    });
    if (!check.ok) throw new FederationError(401, check.reason);
    const fresh = await database
      .insert(federationNonces)
      .values({ nodeId: check.nodeId, nonce: check.nonce, seenAt: now() })
      .onConflictDoNothing()
      .returning({ nonce: federationNonces.nonce });
    if (fresh.length === 0)
      throw new FederationError(401, "That request was already received.");
    const sender = await node(check.nodeId);
    await database
      .update(federationNodes)
      .set({ lastSeenAt: now(), status: "online" })
      .where(eq(federationNodes.id, sender.id));
    return sender;
  }

  /* ------------------------------------------------------------- joining */

  async function createJoinCode(
    actorUserId: string,
    input: { label?: string; days?: number },
  ) {
    if (!self?.isCentral)
      throw new FederationError(
        409,
        "Only the federation's central node admits other nodes.",
      );
    const code = `odj_${randomBytes(24).toString("base64url")}`;
    const days = Math.min(Math.max(input.days ?? JOIN_CODE_DAYS, 1), 90);
    const [row] = await database
      .insert(federationJoinCodes)
      .values({
        id: `join_${crypto.randomUUID()}`,
        codeHash: hashCode(code),
        label: input.label?.trim() ?? "",
        createdByUserId: actorUserId,
        expiresAt: new Date(now().getTime() + days * 86_400_000),
      })
      .returning();
    if (!row) throw new Error("The join code was not saved.");
    return { code, joinCode: joinCodeWire(row) };
  }

  function joinCodeWire(
    row: typeof federationJoinCodes.$inferSelect,
  ): JoinCodeWire {
    return {
      id: row.id,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
      usedByNodeId: row.usedByNodeId,
      usedAt: row.usedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function joinCodes(): Promise<JoinCodeWire[]> {
    const rows = await database
      .select()
      .from(federationJoinCodes)
      .where(isNull(federationJoinCodes.revokedAt))
      .orderBy(desc(federationJoinCodes.createdAt))
      .limit(100);
    return rows.map(joinCodeWire);
  }

  async function revokeJoinCode(id: string) {
    await database
      .update(federationJoinCodes)
      .set({ revokedAt: now() })
      .where(
        and(eq(federationJoinCodes.id, id), isNull(federationJoinCodes.usedAt)),
      );
  }

  /** Tell every other node about `changed`, as the central node. Best effort: heartbeats catch up. */
  async function announce(changed: NodeWire[], except?: string) {
    const peers = await database
      .select()
      .from(federationNodes)
      .where(ne(federationNodes.status, "removed"));
    await Promise.allSettled(
      peers
        .filter((peer) => peer.id !== except)
        .map((peer) => send(peer, "/fed/nodes", { nodes: changed })),
    );
  }

  /** The central node admitting a node that brought a join code. */
  async function acceptJoin(input: unknown) {
    if (!self?.isCentral || !self.nodeId)
      throw new FederationError(
        409,
        "This node is not the central node of a federation.",
      );
    const request = joinRequest.parse(input);
    const [existing] = await database
      .select()
      .from(federationNodes)
      .where(eq(federationNodes.publicKey, request.publicKey));
    const admitted = await database.transaction(async (tx) => {
      const [code] = await tx
        .update(federationJoinCodes)
        .set({
          usedAt: now(),
          usedByNodeId: existing?.id ?? null,
        })
        .where(
          and(
            eq(federationJoinCodes.codeHash, hashCode(request.code)),
            isNull(federationJoinCodes.usedAt),
            isNull(federationJoinCodes.revokedAt),
            gt(federationJoinCodes.expiresAt, now()),
          ),
        )
        .returning({ id: federationJoinCodes.id });
      if (!code)
        throw new FederationError(
          403,
          "That join code is not valid. Ask the central node's administrator for a new one.",
        );
      // The same node joining again (its database restored, say) keeps the id it had.
      const id = existing?.id ?? newNodeId(now().getTime());
      const [row] = await tx
        .insert(federationNodes)
        .values({
          id,
          name: request.name,
          url: request.url,
          publicKey: request.publicKey,
          status: "online",
          lastSeenAt: now(),
        })
        .onConflictDoUpdate({
          target: federationNodes.id,
          set: {
            name: request.name,
            url: request.url,
            status: "online",
            lastSeenAt: now(),
          },
        })
        .returning();
      await tx
        .update(federationJoinCodes)
        .set({ usedByNodeId: id })
        .where(eq(federationJoinCodes.id, code.id));
      return row;
    });
    if (!admitted) throw new Error("The node was not registered.");
    const newcomer = toWire(admitted);
    await announce([newcomer], newcomer.id);
    return {
      nodeId: newcomer.id,
      central: {
        id: self.nodeId,
        name: self.name,
        url: deps.publicUrl,
        publicKey: keys.publicKey,
        isCentral: true,
        status: "online",
      },
      nodes: (await nodes()).filter((other) => other.id !== newcomer.id),
    };
  }

  /** This node joining the federation whose central node is at `centralUrl`. */
  async function join(input: { centralUrl: string; code: string }) {
    if (self?.nodeId)
      throw new FederationError(
        409,
        "This node is already part of a federation.",
      );
    if (!deps.publicUrl)
      throw new FederationError(
        409,
        "This node has no public address for other nodes to reach it at. Set OPENBOT_PUBLIC_URL first.",
      );
    const centralUrl = z
      .string()
      .url("That is not an address.")
      .parse(input.centralUrl);
    let response: Response;
    try {
      response = await fetchImpl(new URL("/fed/join", centralUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: input.code.trim(),
          name: self?.name ?? deps.name,
          url: deps.publicUrl,
          publicKey: keys.publicKey,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new FederationError(502, `Nothing answered at ${centralUrl}.`);
    }
    const answer = (await response.json().catch(() => null)) as {
      error?: string;
      nodeId?: string;
      central?: unknown;
      nodes?: unknown[];
    } | null;
    if (!response.ok || !answer?.nodeId)
      throw new FederationError(
        response.status === 403 ? 403 : 502,
        answer?.error ?? `The central node answered ${response.status}.`,
      );
    const central = nodeRow.parse(answer.central);
    await database.transaction(async (tx) => {
      await tx.update(federationSelf).set({ nodeId: answer.nodeId });
      for (const peer of [
        central,
        ...(answer.nodes ?? []).map((row) => nodeRow.parse(row)),
      ])
        await upsertNode(tx, peer);
    });
    [self] = await database.select().from(federationSelf).limit(1);
    return selfWire();
  }

  async function upsertNode(
    reader: Database | Parameters<Parameters<Database["transaction"]>[0]>[0],
    peer: z.infer<typeof nodeRow>,
  ) {
    if (peer.id === self?.nodeId) return;
    await reader
      .insert(federationNodes)
      .values({ ...peer, lastSeenAt: now() })
      .onConflictDoUpdate({
        target: federationNodes.id,
        set: {
          name: peer.name,
          url: peer.url,
          publicKey: peer.publicKey,
          isCentral: peer.isCentral,
          status: peer.status,
        },
      });
  }

  /** The central node telling this one about nodes that joined, moved or were removed. */
  async function receiveNodes(sender: { isCentral: boolean }, input: unknown) {
    if (!sender.isCentral)
      throw new FederationError(
        403,
        "Only the central node says who is in the federation.",
      );
    const { nodes: changed } = z
      .object({ nodes: z.array(nodeRow) })
      .parse(input);
    for (const peer of changed) await upsertNode(database, peer);
    return { ok: true };
  }

  /** The central node removing a node: it is refused everywhere from then on. */
  async function removeNode(nodeId: string) {
    if (!self?.isCentral)
      throw new FederationError(409, "Only the central node removes nodes.");
    const [row] = await database
      .update(federationNodes)
      .set({ status: "removed" })
      .where(eq(federationNodes.id, nodeId))
      .returning();
    if (!row)
      throw new FederationError(
        404,
        "That node is not part of this federation.",
      );
    await announce([toWire(row)], nodeId);
  }

  /* ------------------------------------------------------------- actions */

  /** Make `name` something other nodes may ask this one for. */
  function register(name: string, action: FederatedAction) {
    if (actions.has(name)) throw new Error(`${name} is already registered.`);
    actions.set(name, action);
  }

  /** Run an action another node asked for. */
  async function dispatch(
    sender: { id: string; name: string },
    input: unknown,
  ) {
    const request = z
      .object({
        action: z.string(),
        caller: z.object({ userId: z.string(), name: z.string() }).nullable(),
        body: z.unknown(),
      })
      .parse(input);
    const action = actions.get(request.action);
    if (!action)
      throw new FederationError(
        404,
        `This node does not answer ${request.action}.`,
      );
    return {
      result: await action(request.body, {
        nodeId: sender.id,
        nodeName: sender.name,
        caller: request.caller,
      }),
    };
  }

  /** Ask another node for one of its actions. */
  async function call(
    nodeId: string,
    action: string,
    body: unknown,
    caller: RemoteOrigin["caller"] = null,
  ) {
    const target = await node(nodeId);
    const answer = (await send(target, "/fed/dispatch", {
      action,
      caller,
      body,
    })) as { result?: unknown };
    return answer.result;
  }

  /* -------------------------------------------------------------- ledgers */

  /** Send this node's new ledger entries to the central node. Returns how many went. */
  async function pushLedger() {
    if (!self?.nodeId || self.isCentral) return 0;
    const [central] = await database
      .select()
      .from(federationNodes)
      .where(
        and(
          eq(federationNodes.isCentral, true),
          ne(federationNodes.status, "removed"),
        ),
      );
    if (!central) return 0;
    const [cursor] = await database
      .select({ seq: federationLedgerCursors.seq })
      .from(federationLedgerCursors)
      .where(eq(federationLedgerCursors.nodeId, central.id));
    const rows = await database
      .select()
      .from(ledgerEntries)
      .where(gt(ledgerEntries.seq, cursor?.seq ?? 0))
      .orderBy(asc(ledgerEntries.seq))
      .limit(500);
    if (rows.length === 0) return 0;
    await send(central, "/fed/ledger", {
      entries: rows.map((row) => ({
        seq: row.seq,
        id: row.id,
        type: row.type,
        category: row.category,
        fromUserId: row.fromUserId,
        toUserId: row.toUserId,
        amount: row.amount,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
      })),
    });
    const last = rows.at(-1)?.seq ?? 0;
    await database
      .insert(federationLedgerCursors)
      .values({ nodeId: central.id, seq: last })
      .onConflictDoUpdate({
        target: federationLedgerCursors.nodeId,
        set: { seq: last, updatedAt: now() },
      });
    return rows.length;
  }

  /** The central node keeping a node's ledger entries. Sent again, they are kept once. */
  async function receiveLedger(sender: { id: string }, input: unknown) {
    if (!self?.isCentral)
      throw new FederationError(
        409,
        "Only the central node keeps other nodes' ledgers.",
      );
    const { entries } = ledgerBatch.parse(input);
    if (entries.length)
      await database
        .insert(federationLedger)
        .values(
          entries.map((entry) => ({
            originNodeId: sender.id,
            originSeq: entry.seq,
            entryId: entry.id,
            type: entry.type,
            category: entry.category,
            fromUserId: entry.fromUserId,
            toUserId: entry.toUserId,
            amount: entry.amount,
            description: entry.description,
            createdAt: new Date(entry.createdAt),
          })),
        )
        .onConflictDoNothing();
    return { stored: entries.at(-1)?.seq ?? 0 };
  }

  /** What every node's ledger holds, as the central node has it. */
  async function ledgers(): Promise<NodeLedgerWire[]> {
    const rows = await database
      .select({
        nodeId: federationNodes.id,
        name: federationNodes.name,
        entries: sql<number>`count(${federationLedger.originSeq})::int`.mapWith(
          Number,
        ),
        minted:
          sql<number>`coalesce(sum(${federationLedger.amount}) filter (where ${federationLedger.type} = 'mint'), 0)::bigint`.mapWith(
            Number,
          ),
        spent:
          sql<number>`coalesce(sum(${federationLedger.amount}) filter (where ${federationLedger.type} = 'spend'), 0)::bigint`.mapWith(
            Number,
          ),
        lastEntryAt: sql<string | null>`max(${federationLedger.createdAt})`,
      })
      .from(federationNodes)
      .leftJoin(
        federationLedger,
        eq(federationLedger.originNodeId, federationNodes.id),
      )
      .groupBy(federationNodes.id, federationNodes.name)
      .orderBy(asc(federationNodes.name));
    return rows.map((row) => ({
      ...row,
      lastEntryAt: row.lastEntryAt
        ? new Date(row.lastEntryAt).toISOString()
        : null,
    }));
  }

  /* --------------------------------------------------------- housekeeping */

  /** Ask every node whether it is there, and forget nonces too old to be replayed anyway. */
  async function heartbeat() {
    await database
      .delete(federationNonces)
      .where(
        lt(
          federationNonces.seenAt,
          new Date(now().getTime() - 2 * SIGNATURE_WINDOW_SECONDS * 1000),
        ),
      );
    const peers = await database
      .select()
      .from(federationNodes)
      .where(ne(federationNodes.status, "removed"));
    await Promise.allSettled(
      peers.map(async (peer) => {
        const answered = await fetchImpl(new URL("/fed/info", peer.url), {
          signal: AbortSignal.timeout(5_000),
        })
          .then((response) => response.ok)
          .catch(() => false);
        await database
          .update(federationNodes)
          .set(
            answered
              ? { status: "online", lastSeenAt: now() }
              : { status: "offline" },
          )
          .where(eq(federationNodes.id, peer.id));
      }),
    );
  }

  return {
    self: selfWire,
    nodes,
    node,
    verify,
    createJoinCode,
    joinCodes,
    revokeJoinCode,
    acceptJoin,
    join,
    receiveNodes,
    removeNode,
    register,
    dispatch,
    call,
    pushLedger,
    receiveLedger,
    ledgers,
    heartbeat,
  };
}
