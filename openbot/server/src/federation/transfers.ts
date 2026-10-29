/**
 * Credits sent to somebody on another node.
 *
 * The sender's wallet pays first, in one transaction with the transfer's row, so credits on their
 * way are never also still spendable. Delivery then happens as often as it takes: now, and again
 * from the federation's background loop until the other node either takes the credits or refuses
 * them. A refusal (nobody there with that address, say) returns them. The receiving node settles each
 * transfer id once (`creditIn`), so a delivery that arrived but whose answer was lost is harmless to
 * repeat, and never pays twice.
 */
import { and, asc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import { federationTransfers } from "../db/schema/federation";
import { WalletError, type Wallets } from "../wallet/service";
import { type Federation, FederationError } from "./service";

const RECEIVE = "wallet.receive";
/** After this many failed deliveries the credits go back, rather than waiting on a node forever. */
const MAX_ATTEMPTS = 50;

const delivery = z.object({
  transferId: z.string().min(1),
  to: z.string().email(),
  amount: z.number().int().positive(),
  note: z.string().max(200),
  from: z.string().max(120),
});

export function createFederatedTransfers(deps: {
  database: Database;
  federation: Pick<Federation, "register" | "call" | "node">;
  wallets: Pick<Wallets, "sendAway" | "creditIn" | "recipientByEmail">;
}) {
  const { database, federation, wallets } = deps;

  // The receiving side: credit whoever the address names here, once per transfer.
  federation.register(RECEIVE, async (body, origin) => {
    const input = delivery.parse(body);
    try {
      const userId = await wallets.recipientByEmail(input.to);
      await wallets.creditIn({
        userId,
        amount: input.amount,
        description: `From ${input.from} on ${origin.nodeName}${input.note ? `: ${input.note}` : ""}`,
        reference: `fed:${origin.nodeId}:${input.transferId}`,
      });
    } catch (error) {
      // Said to the sending node as a refusal, which returns the credits, not as this node failing.
      if (error instanceof WalletError)
        throw new FederationError(
          error.status === 402 ? 400 : error.status,
          error.message,
        );
      throw error;
    }
    return { delivered: true };
  });

  async function deliver(transfer: typeof federationTransfers.$inferSelect) {
    const [sender] = await database
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, transfer.fromUserId));
    try {
      await federation.call(
        transfer.nodeId,
        RECEIVE,
        {
          transferId: transfer.id,
          to: transfer.recipient,
          amount: transfer.amount,
          note: transfer.note,
          from: sender?.name ?? sender?.email ?? "Somebody",
        },
        sender
          ? { userId: transfer.fromUserId, name: sender.name ?? sender.email }
          : null,
      );
      await database
        .update(federationTransfers)
        .set({ status: "delivered", settledAt: new Date(), lastError: null })
        .where(eq(federationTransfers.id, transfer.id));
      return "delivered" as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A node that answered no will answer no again; one that did not answer may yet.
      const refused = error instanceof FederationError && error.status !== 502;
      if (refused || transfer.attempts + 1 >= MAX_ATTEMPTS) {
        await wallets.creditIn({
          userId: transfer.fromUserId,
          amount: transfer.amount,
          description: `Returned: ${message}`,
          reference: `${transfer.id}:returned`,
        });
        await database
          .update(federationTransfers)
          .set({
            status: "returned",
            settledAt: new Date(),
            attempts: transfer.attempts + 1,
            lastError: message,
          })
          .where(eq(federationTransfers.id, transfer.id));
        return "returned" as const;
      }
      await database
        .update(federationTransfers)
        .set({ attempts: transfer.attempts + 1, lastError: message })
        .where(eq(federationTransfers.id, transfer.id));
      return "pending" as const;
    }
  }

  /** Send credits to `to` on `nodeId`. Says whether they arrived, came back, or are still on their way. */
  async function send(input: {
    fromUserId: string;
    nodeId: string;
    to: string;
    amount: number;
    note?: string;
  }) {
    const target = await federation.node(input.nodeId);
    const id = `fedtx_${crypto.randomUUID()}`;
    const note = input.note?.trim() ?? "";
    let transfer: typeof federationTransfers.$inferSelect | undefined;
    await wallets.sendAway({
      fromUserId: input.fromUserId,
      amount: input.amount,
      description: `To ${input.to} on ${target.name}${note ? `: ${note}` : ""}`,
      reference: id,
      record: async (tx) => {
        [transfer] = await tx
          .insert(federationTransfers)
          .values({
            id,
            fromUserId: input.fromUserId,
            nodeId: target.id,
            recipient: input.to.trim().toLowerCase(),
            amount: input.amount,
            note,
          })
          .returning();
      },
    });
    if (!transfer) throw new Error("The transfer was not recorded.");
    return { id, status: await deliver(transfer) };
  }

  /** Try every transfer still on its way again. Called from the federation's background loop. */
  async function retry() {
    const pending = await database
      .select()
      .from(federationTransfers)
      .where(
        and(
          eq(federationTransfers.status, "pending"),
          lt(federationTransfers.attempts, MAX_ATTEMPTS),
        ),
      )
      .orderBy(asc(federationTransfers.createdAt))
      .limit(100);
    for (const transfer of pending) await deliver(transfer);
    return pending.length;
  }

  return { send, retry };
}

export type FederatedTransfers = ReturnType<typeof createFederatedTransfers>;
