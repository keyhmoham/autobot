/**
 * Wallets: the one place credits move.
 *
 * Every change to a balance happens in the same transaction as the ledger entry that explains it,
 * with the wallet row locked by the UPDATE that changes it, so the balance always equals what the
 * ledger says and two charges at once never both spend the same credit.
 *
 * Work is charged after it is done, because only then is its cost known: a model's tokens are counted
 * from its answer, a computer's minute once it has run. So a charge is never refused; it can take a
 * balance below zero by the last piece of work that was already under way when it ran out. What stops
 * the next piece is `admit`, asked before any work starts (the gateway before calling a vendor, the
 * computer meter before another minute), which is where an empty wallet or a spent budget is said.
 *
 * Budgets are a space's own limit, set by whoever manages the space, and count every charge made for
 * it whether or not billing is on, so a budget set later sees the whole picture. With billing off no
 * balance moves at all, but budgets still count and still stop work.
 */
import {
  type BillingSettingsWire,
  type BudgetWire,
  type ChargeCategory,
  DEFAULT_BILLING_SETTINGS,
  formatCredits,
  type GrantWire,
  type LedgerEntryType,
  type LedgerEntryWire,
  type WalletWire,
} from "@openbot/shared/wallet";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import {
  billingSettings,
  ledgerEntries,
  spaceBudgets,
  walletGrants,
  wallets,
} from "../db/schema/wallet";
import { spaces } from "../db/schema/workspace";
import { requirePermission, type Transaction } from "../workspace/access";

type Reader = Database | Transaction;

export class WalletError extends Error {
  constructor(
    readonly status: 400 | 402 | 404,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export type Admission = { ok: true } | { ok: false; message: string };

export type Charge = {
  /** Null is the deployment paying for its own work: only the space's budget counts it. */
  payerUserId: string | null;
  amount: number;
  category: ChargeCategory;
  description: string;
  spaceId?: string | null;
  agentId?: string | null;
  reference?: string | null;
};

const amount = z
  .number()
  .int("An amount is a whole number of credits.")
  .positive("An amount must be more than nothing.")
  .max(Number.MAX_SAFE_INTEGER);

const settingsPatch = z
  .object({
    enabled: z.boolean(),
    signupGrant: z.number().int().min(0),
    grantDays: z.number().int().min(0).max(3650),
    computerMinutePrice: z.number().int().min(0),
  })
  .partial();

/** How long settings read on one replica stay trusted. A change made elsewhere lands within this. */
const SETTINGS_TTL_MS = 5_000;

export type Wallets = ReturnType<typeof createWallets>;

export function createWallets(deps: { database: Database; now?: () => Date }) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());
  let cached: { at: number; value: BillingSettingsWire } | undefined;

  async function settings(): Promise<BillingSettingsWire> {
    if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;
    const [row] = await database.select().from(billingSettings).limit(1);
    const value: BillingSettingsWire = row
      ? {
          enabled: row.enabled,
          signupGrant: row.signupGrant,
          grantDays: row.grantDays,
          computerMinutePrice: row.computerMinutePrice,
        }
      : DEFAULT_BILLING_SETTINGS;
    cached = { at: Date.now(), value };
    return value;
  }

  async function updateSettings(
    actorUserId: string,
    input: unknown,
  ): Promise<BillingSettingsWire> {
    const patch = settingsPatch.parse(input);
    const next = { ...(await settings()), ...patch };
    await database
      .insert(billingSettings)
      .values({ id: 1, ...next, updatedByUserId: actorUserId })
      .onConflictDoUpdate({
        target: billingSettings.id,
        set: { ...next, updatedByUserId: actorUserId, updatedAt: now() },
      });
    cached = { at: Date.now(), value: next };
    return next;
  }

  /**
   * Add a ledger entry and move the balances it names, inside `tx`. The only writer of both, so
   * nothing can change one without the other.
   */
  async function post(
    tx: Transaction,
    entry: {
      type: LedgerEntryType;
      amount: number;
      fromUserId?: string | null;
      toUserId?: string | null;
      category?: ChargeCategory | null;
      description: string;
      spaceId?: string | null;
      agentId?: string | null;
      reference?: string | null;
    },
  ) {
    const at = now();
    if (entry.fromUserId)
      await tx
        .update(wallets)
        .set({
          balance: sql`${wallets.balance} - ${entry.amount}`,
          updatedAt: at,
        })
        .where(eq(wallets.userId, entry.fromUserId));
    if (entry.toUserId)
      await tx
        .update(wallets)
        .set({
          balance: sql`${wallets.balance} + ${entry.amount}`,
          updatedAt: at,
        })
        .where(eq(wallets.userId, entry.toUserId));
    const [row] = await tx
      .insert(ledgerEntries)
      .values({
        id: `led_${crypto.randomUUID()}`,
        type: entry.type,
        amount: entry.amount,
        fromUserId: entry.fromUserId ?? null,
        toUserId: entry.toUserId ?? null,
        category: entry.category ?? null,
        description: entry.description,
        spaceId: entry.spaceId ?? null,
        agentId: entry.agentId ?? null,
        reference: entry.reference ?? null,
        createdAt: at,
      })
      .returning();
    return row;
  }

  /**
   * Credits leaving a wallet use up its grants first, soonest to lapse first, so a grant's credits
   * are spent before anything the person was sent or bought.
   */
  async function drawGrants(tx: Transaction, userId: string, total: number) {
    let left = total;
    const active = await tx
      .select({ id: walletGrants.id, remaining: walletGrants.remaining })
      .from(walletGrants)
      .where(
        and(
          eq(walletGrants.userId, userId),
          eq(walletGrants.status, "active"),
          sql`${walletGrants.remaining} > 0`,
        ),
      )
      .orderBy(asc(walletGrants.expiresAt))
      .for("update");
    for (const grant of active) {
      if (left <= 0) break;
      const take = Math.min(grant.remaining, left);
      await tx
        .update(walletGrants)
        .set({ remaining: grant.remaining - take })
        .where(eq(walletGrants.id, grant.id));
      left -= take;
    }
  }

  /** Credits from nowhere into a wallet, lapsing at `expiresAt` when one is given. */
  async function mintIn(
    tx: Transaction,
    input: {
      userId: string;
      amount: number;
      description: string;
      expiresAt?: Date | null;
    },
  ) {
    const entry = await post(tx, {
      type: "mint",
      amount: input.amount,
      toUserId: input.userId,
      description: input.description,
    });
    if (input.expiresAt)
      await tx.insert(walletGrants).values({
        id: `grant_${crypto.randomUUID()}`,
        userId: input.userId,
        amount: input.amount,
        remaining: input.amount,
        expiresAt: input.expiresAt,
        createdAt: now(),
      });
    return entry;
  }

  /**
   * The person's wallet, made on first use. A new wallet starts with the deployment's welcome grant
   * when billing is on, so the first person to use it is never refused for an empty wallet they never
   * had a chance to fill.
   */
  async function open(userId: string, reader: Reader = database) {
    const created = await reader
      .insert(wallets)
      .values({ userId })
      .onConflictDoNothing()
      .returning({ userId: wallets.userId });
    if (created.length > 0) {
      const current = await settings();
      if (current.enabled && current.signupGrant > 0) {
        const grant = (tx: Transaction) =>
          mintIn(tx, {
            userId,
            amount: current.signupGrant,
            description: "Welcome credits",
            expiresAt:
              current.grantDays > 0
                ? new Date(now().getTime() + current.grantDays * 86_400_000)
                : null,
          });
        if (reader === database) await database.transaction(grant);
        else await grant(reader as Transaction);
      }
    }
    const [row] = await reader
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId));
    if (!row) throw new WalletError(404, "That wallet was not found.");
    return row;
  }

  async function wallet(userId: string): Promise<WalletWire> {
    const row = await open(userId);
    return {
      userId: row.userId,
      balance: row.balance,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** A page of the person's ledger, newest first, each entry signed from their side. */
  async function entries(
    userId: string,
    page: { before?: number; limit?: number } = {},
  ): Promise<LedgerEntryWire[]> {
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
    const rows = await database
      .select()
      .from(ledgerEntries)
      .where(
        and(
          or(
            eq(ledgerEntries.fromUserId, userId),
            eq(ledgerEntries.toUserId, userId),
          ),
          page.before ? lt(ledgerEntries.seq, page.before) : undefined,
        ),
      )
      .orderBy(desc(ledgerEntries.seq))
      .limit(limit);
    const others = [
      ...new Set(
        rows.flatMap((row) =>
          row.type === "transfer"
            ? [row.fromUserId === userId ? row.toUserId : row.fromUserId]
            : [],
        ),
      ),
    ].filter((id): id is string => Boolean(id));
    const names = new Map(
      others.length
        ? (
            await database
              .select({ id: users.id, name: users.name, email: users.email })
              .from(users)
              .where(inArray(users.id, others))
          ).map((row) => [row.id, row.name ?? row.email])
        : [],
    );
    return rows.map((row) => {
      const outgoing = row.fromUserId === userId;
      const other = outgoing ? row.toUserId : row.fromUserId;
      return {
        id: row.id,
        seq: row.seq,
        type: row.type,
        category: row.category,
        amount: outgoing ? -row.amount : row.amount,
        description: row.description,
        counterparty:
          row.type === "transfer" && other ? (names.get(other) ?? null) : null,
        spaceId: row.spaceId,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async function grants(userId: string): Promise<GrantWire[]> {
    const rows = await database
      .select()
      .from(walletGrants)
      .where(eq(walletGrants.userId, userId))
      .orderBy(desc(walletGrants.createdAt))
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      remaining: row.remaining,
      expiresAt: row.expiresAt.toISOString(),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** An administrator adding credits to somebody's wallet. */
  async function mint(input: {
    userId: string;
    amount: number;
    description?: string;
    expiresInDays?: number | null;
  }) {
    const credits = amount.parse(input.amount);
    const [person] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId));
    if (!person) throw new WalletError(404, "That person was not found.");
    await open(person.id);
    const expiresAt =
      input.expiresInDays && input.expiresInDays > 0
        ? new Date(now().getTime() + input.expiresInDays * 86_400_000)
        : null;
    await database.transaction((tx) =>
      mintIn(tx, {
        userId: person.id,
        amount: credits,
        description: input.description?.trim() || "Added by an administrator",
        expiresAt,
      }),
    );
    return wallet(person.id);
  }

  /** One person sending credits to another, by email. Refused rather than overdrawn. */
  async function transfer(input: {
    fromUserId: string;
    to: string;
    amount: number;
    note?: string;
  }) {
    const credits = amount.parse(input.amount);
    const recipient = { id: await recipientByEmail(input.to) };
    if (recipient.id === input.fromUserId)
      throw new WalletError(400, "Credits cannot be sent to yourself.");
    await open(input.fromUserId);
    await open(recipient.id);
    await database.transaction(async (tx) => {
      // Locked until the transaction ends, so a charge landing meanwhile cannot spend the same credits.
      const [sender] = await tx
        .select({ balance: wallets.balance })
        .from(wallets)
        .where(eq(wallets.userId, input.fromUserId))
        .for("update");
      if (!sender || sender.balance < credits)
        throw new WalletError(402, "Your wallet does not hold that much.");
      await drawGrants(tx, input.fromUserId, credits);
      await post(tx, {
        type: "transfer",
        amount: credits,
        fromUserId: input.fromUserId,
        toUserId: recipient.id,
        description: input.note?.trim() || "Sent",
      });
    });
    return wallet(input.fromUserId);
  }

  /**
   * Credits leaving this node for somebody on another one: taken from the sender like a transfer,
   * with nobody here on the other side. `reference` names the delivery that carries them, and
   * `record` writes that delivery in the same transaction, so credits are never taken without one
   * nor sent without having been taken.
   */
  async function sendAway(input: {
    fromUserId: string;
    amount: number;
    description: string;
    reference: string;
    record: (tx: Transaction) => Promise<void>;
  }) {
    const credits = amount.parse(input.amount);
    await open(input.fromUserId);
    await database.transaction(async (tx) => {
      const [sender] = await tx
        .select({ balance: wallets.balance })
        .from(wallets)
        .where(eq(wallets.userId, input.fromUserId))
        .for("update");
      if (!sender || sender.balance < credits)
        throw new WalletError(402, "Your wallet does not hold that much.");
      await drawGrants(tx, input.fromUserId, credits);
      await post(tx, {
        type: "transfer",
        amount: credits,
        fromUserId: input.fromUserId,
        description: input.description,
        reference: input.reference,
      });
      await input.record(tx);
    });
  }

  /**
   * Credits arriving from outside this node's wallets: a delivery from another node, or a delivery
   * that was refused coming back. Settled once per `reference`, so delivering again pays nothing more.
   */
  async function creditIn(input: {
    userId: string;
    amount: number;
    description: string;
    reference: string;
  }) {
    const credits = amount.parse(input.amount);
    await open(input.userId);
    await database.transaction(async (tx) => {
      const [settled] = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.reference, input.reference));
      if (settled) return;
      await post(tx, {
        type: "transfer",
        amount: credits,
        toUserId: input.userId,
        description: input.description,
        reference: input.reference,
      });
    });
  }

  /** Whose wallet an email address names here, or a refusal saying nobody's. */
  async function recipientByEmail(email: string) {
    const [recipient] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()));
    if (!recipient)
      throw new WalletError(404, "Nobody here has that email address.");
    return recipient.id;
  }

  /**
   * Whether this payer may start more work for this space now. Asked before the work, never after:
   * see the file header.
   */
  async function admit(input: {
    payerUserId: string | null;
    spaceId?: string | null;
  }): Promise<Admission> {
    if (input.spaceId) {
      const [budget] = await database
        .select()
        .from(spaceBudgets)
        .where(eq(spaceBudgets.spaceId, input.spaceId));
      if (budget && budget.cap > 0 && budget.spent >= budget.cap)
        return {
          ok: false,
          message: `This space has spent its budget of ${formatCredits(budget.cap)}. Whoever manages the space can raise it.`,
        };
    }
    if (!input.payerUserId || !(await settings()).enabled) return { ok: true };
    const row = await open(input.payerUserId);
    if (row.balance <= 0)
      return {
        ok: false,
        message:
          "Your wallet is empty, so this cannot run. An administrator can add credits, or somebody can send you some.",
      };
    return { ok: true };
  }

  /** Charge finished work. Never refused; see the file header. */
  async function charge(input: Charge) {
    if (!(input.amount > 0)) return;
    const credits = Math.ceil(input.amount);
    const billing = (await settings()).enabled;
    if (billing && input.payerUserId) await open(input.payerUserId);
    await database.transaction(async (tx) => {
      if (input.spaceId)
        // Counted only for a space that still exists: a charge settling after its space was deleted
        // has nothing left to count against.
        await tx.execute(sql`
          INSERT INTO ${spaceBudgets} (space_id, spent)
          SELECT ${spaces.id}, ${credits} FROM ${spaces} WHERE ${spaces.id} = ${input.spaceId}
          ON CONFLICT (space_id) DO UPDATE
            SET spent = ${spaceBudgets.spent} + EXCLUDED.spent, updated_at = now()
        `);
      if (!billing || !input.payerUserId) return;
      await drawGrants(tx, input.payerUserId, credits);
      await post(tx, {
        type: "spend",
        amount: credits,
        fromUserId: input.payerUserId,
        category: input.category,
        description: input.description,
        spaceId: input.spaceId ?? null,
        agentId: input.agentId ?? null,
        reference: input.reference ?? null,
      });
    });
  }

  /**
   * Take back what is left of every grant due by `at`, never more than the wallet holds: credits a
   * grant gave that were already spent are not owed back.
   */
  async function expireGrants(at: Date = now()) {
    const due = await database
      .select({ id: walletGrants.id })
      .from(walletGrants)
      .where(
        and(eq(walletGrants.status, "active"), lte(walletGrants.expiresAt, at)),
      );
    let expired = 0;
    for (const { id } of due)
      await database.transaction(async (tx) => {
        const [grant] = await tx
          .select()
          .from(walletGrants)
          .where(
            and(eq(walletGrants.id, id), eq(walletGrants.status, "active")),
          )
          .for("update");
        if (!grant) return;
        const [holder] = await tx
          .select({ balance: wallets.balance })
          .from(wallets)
          .where(eq(wallets.userId, grant.userId))
          .for("update");
        const take = Math.max(
          0,
          Math.min(grant.remaining, holder?.balance ?? 0),
        );
        if (take > 0)
          await post(tx, {
            type: "expire",
            amount: take,
            fromUserId: grant.userId,
            description: "Unspent credits from a grant that lapsed",
          });
        await tx
          .update(walletGrants)
          .set({ status: "expired", remaining: 0 })
          .where(eq(walletGrants.id, grant.id));
        expired += 1;
      });
    return { expired };
  }

  async function budgetOf(spaceId: string): Promise<BudgetWire> {
    const [row] = await database
      .select()
      .from(spaceBudgets)
      .where(eq(spaceBudgets.spaceId, spaceId));
    return { spaceId, cap: row?.cap ?? 0, spent: row?.spent ?? 0 };
  }

  async function budget(actorUserId: string, spaceId: string) {
    await requirePermission(database, spaceId, actorUserId, "space.view");
    return budgetOf(spaceId);
  }

  async function setBudget(actorUserId: string, spaceId: string, cap: unknown) {
    const value = z.number().int().min(0).parse(cap);
    await requirePermission(
      database,
      spaceId,
      actorUserId,
      "space.manage_budget",
    );
    await database
      .insert(spaceBudgets)
      .values({ spaceId, cap: value })
      .onConflictDoUpdate({
        target: spaceBudgets.spaceId,
        set: { cap: value, updatedAt: now() },
      });
    return budgetOf(spaceId);
  }

  /** Admin → Billing: what moved over the last `days`, and what is held. */
  async function overview(days = 30) {
    const since = new Date(now().getTime() - days * 86_400_000);
    const inWindow = gte(ledgerEntries.createdAt, since);
    const totals = await database
      .select({
        type: ledgerEntries.type,
        category: ledgerEntries.category,
        amount:
          sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)::bigint`.mapWith(
            Number,
          ),
      })
      .from(ledgerEntries)
      .where(inWindow)
      .groupBy(ledgerEntries.type, ledgerEntries.category);
    const byDay = await database
      .select({
        day: sql<string>`to_char(date_trunc('day', ${ledgerEntries.createdAt}), 'YYYY-MM-DD')`,
        category: ledgerEntries.category,
        amount: sql<number>`sum(${ledgerEntries.amount})::bigint`.mapWith(
          Number,
        ),
      })
      .from(ledgerEntries)
      .where(and(inWindow, eq(ledgerEntries.type, "spend")))
      .groupBy(sql`1`, ledgerEntries.category)
      .orderBy(sql`1`);
    const [held] = await database
      .select({
        balance:
          sql<number>`coalesce(sum(${wallets.balance}), 0)::bigint`.mapWith(
            Number,
          ),
        wallets: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(wallets);
    const sum = (type: LedgerEntryType, category?: ChargeCategory) =>
      totals
        .filter(
          (row) =>
            row.type === type && (!category || row.category === category),
        )
        .reduce((total, row) => total + row.amount, 0);
    return {
      settings: await settings(),
      days,
      minted: sum("mint"),
      spent: {
        total: sum("spend"),
        llm: sum("spend", "llm"),
        compute: sum("spend", "compute"),
        app: sum("spend", "app"),
      },
      expired: sum("expire"),
      transferred: sum("transfer"),
      held: held?.balance ?? 0,
      wallets: held?.wallets ?? 0,
      byDay,
    };
  }

  /** Admin → Billing: people and their balances, lowest first, so who is about to run out shows. */
  async function balances(query?: string, limit = 50) {
    const term = query?.trim();
    return database
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        balance: sql<number>`coalesce(${wallets.balance}, 0)::bigint`.mapWith(
          Number,
        ),
      })
      .from(users)
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .where(
        term
          ? or(ilike(users.email, `%${term}%`), ilike(users.name, `%${term}%`))
          : undefined,
      )
      .orderBy(asc(sql`coalesce(${wallets.balance}, 0)`), asc(users.email))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  return {
    settings,
    updateSettings,
    open,
    wallet,
    entries,
    grants,
    mint,
    transfer,
    sendAway,
    creditIn,
    recipientByEmail,
    admit,
    charge,
    expireGrants,
    budget,
    budgetOf,
    setBudget,
    overview,
    balances,
  };
}
