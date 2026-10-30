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
import { eq, inArray, or } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import {
  billingSettings,
  ledgerEntries,
  spaceMembers,
  spaces,
  users,
} from "../src/db/schema";
import { createComputerMeter } from "../src/wallet/meter";
import { createWallets, WalletError } from "../src/wallet/service";
import { WorkspaceForbiddenError } from "../src/workspace/errors";
import { createWorkspace } from "../src/workspace/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
let clock = new Date("2026-10-01T12:00:00Z");
const wallets = createWallets({ database, now: () => clock });
const workspace = createWorkspace({
  database,
  actorFor: async (id) => ({ id, role: "user" }),
  profiles: createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  ),
});
const prefix = `wallet-${randomUUID()}`;
const created: string[] = [];
const admin = `${prefix}-admin`;

beforeEach(async () => {
  clock = new Date("2026-10-01T12:00:00Z");
  await database
    .insert(users)
    .values({ id: admin, email: `${admin}@example.test` })
    .onConflictDoNothing();
});
afterEach(async () => {
  const ids = [...created.splice(0), admin];
  await database.delete(spaces).where(inArray(spaces.createdByUserId, ids));
  await database
    .delete(ledgerEntries)
    .where(
      or(
        inArray(ledgerEntries.fromUserId, ids),
        inArray(ledgerEntries.toUserId, ids),
      ),
    );
  // Through the service, so its cached copy is reset too, then gone, as on a fresh deployment.
  await wallets.updateSettings(admin, DEFAULT_BILLING_SETTINGS);
  await database.delete(billingSettings);
  await database.delete(users).where(inArray(users.id, ids));
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name = "Ana") {
  const id = `${prefix}-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name });
  created.push(id);
  return { id, email };
}

const billingOn = (settings: Partial<typeof DEFAULT_BILLING_SETTINGS> = {}) =>
  wallets.updateSettings(admin, { enabled: true, ...settings });

describe("with billing off", () => {
  test("nothing is refused and no balance moves, but a space's budget still counts", async () => {
    const ana = await person();
    const space = await workspace.create(ana.id, { name: "Launch" });
    expect(await wallets.admit({ payerUserId: ana.id })).toEqual({ ok: true });
    await wallets.charge({
      payerUserId: ana.id,
      amount: 500,
      category: "llm",
      description: "tokens",
      spaceId: space.id,
    });
    expect((await wallets.wallet(ana.id)).balance).toBe(0);
    expect(await wallets.entries(ana.id)).toEqual([]);
    expect((await wallets.budget(ana.id, space.id)).spent).toBe(500);
  });
});

describe("with billing on", () => {
  test("a new wallet opens with the welcome grant, and spending draws on it first", async () => {
    await billingOn({ signupGrant: 1_000, grantDays: 7 });
    const ana = await person();
    expect((await wallets.wallet(ana.id)).balance).toBe(1_000);
    await wallets.charge({
      payerUserId: ana.id,
      amount: 300,
      category: "llm",
      description: "chat: 10 tokens in, 5 out",
      reference: "usage-1",
    });
    expect((await wallets.wallet(ana.id)).balance).toBe(700);
    const [grant] = await wallets.grants(ana.id);
    expect(grant).toMatchObject({
      amount: 1_000,
      remaining: 700,
      status: "active",
    });
    const [spend, mint] = await wallets.entries(ana.id);
    expect(spend).toMatchObject({
      type: "spend",
      category: "llm",
      amount: -300,
    });
    expect(mint).toMatchObject({
      type: "mint",
      amount: 1_000,
      description: "Welcome credits",
    });
  });

  test("an empty wallet is refused new work, though finished work is still charged", async () => {
    await billingOn();
    const ana = await person();
    const refused = await wallets.admit({ payerUserId: ana.id });
    expect(refused.ok).toBe(false);
    await wallets.charge({
      payerUserId: ana.id,
      amount: 40,
      category: "compute",
      description: "a minute",
    });
    expect((await wallets.wallet(ana.id)).balance).toBe(-40);
    // The deployment paying for itself is never asked for a wallet.
    expect(await wallets.admit({ payerUserId: null })).toEqual({ ok: true });
  });

  test("a transfer moves credits between two people and reads from each side", async () => {
    await billingOn();
    const ana = await person("Ana");
    const bo = await person("Bo");
    await wallets.mint({ userId: ana.id, amount: 1_000 });
    await expect(
      wallets.transfer({ fromUserId: ana.id, to: bo.email, amount: 5_000 }),
    ).rejects.toMatchObject({ status: 402 });
    await expect(
      wallets.transfer({ fromUserId: ana.id, to: ana.email, amount: 1 }),
    ).rejects.toBeInstanceOf(WalletError);
    await expect(
      wallets.transfer({
        fromUserId: ana.id,
        to: "nobody@example.test",
        amount: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await wallets.transfer({
      fromUserId: ana.id,
      to: bo.email.toUpperCase(),
      amount: 250,
      note: "For lunch",
    });
    expect((await wallets.wallet(ana.id)).balance).toBe(750);
    expect((await wallets.wallet(bo.id)).balance).toBe(250);
    expect((await wallets.entries(ana.id))[0]).toMatchObject({
      type: "transfer",
      amount: -250,
      counterparty: "Bo",
      description: "For lunch",
    });
    expect((await wallets.entries(bo.id))[0]).toMatchObject({
      amount: 250,
      counterparty: "Ana",
    });
  });

  test("a lapsed grant takes back only what is left of it", async () => {
    await billingOn();
    const ana = await person();
    await wallets.mint({ userId: ana.id, amount: 500 });
    await wallets.mint({ userId: ana.id, amount: 1_000, expiresInDays: 1 });
    await wallets.charge({
      payerUserId: ana.id,
      amount: 400,
      category: "llm",
      description: "x",
    });
    // Not due yet.
    expect((await wallets.expireGrants(clock)).expired).toBe(0);
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    await wallets.expireGrants(clock);
    // 1,500 in, 400 spent from the grant, its other 600 lapsed: the 500 that never lapses is left.
    expect((await wallets.wallet(ana.id)).balance).toBe(500);
    expect((await wallets.grants(ana.id))[0]).toMatchObject({
      status: "expired",
      remaining: 0,
    });
    expect((await wallets.entries(ana.id))[0]).toMatchObject({
      type: "expire",
      amount: -600,
    });
  });
});

describe("a space's budget", () => {
  test("is set by whoever manages the space, and stops work once it is spent", async () => {
    const owner = await person();
    const guest = await person();
    const space = await workspace.create(owner.id, { name: "Launch" });
    await database
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: guest.id, role: "member" });
    await expect(
      wallets.setBudget(guest.id, space.id, 100),
    ).rejects.toBeInstanceOf(WorkspaceForbiddenError);
    expect(await wallets.setBudget(owner.id, space.id, 100)).toEqual({
      spaceId: space.id,
      cap: 100,
      spent: 0,
    });
    await wallets.charge({
      payerUserId: null,
      amount: 100,
      category: "llm",
      description: "x",
      spaceId: space.id,
    });
    const refused = await wallets.admit({
      payerUserId: null,
      spaceId: space.id,
    });
    expect(refused.ok === false && refused.message).toContain(
      "spent its budget",
    );
    // Elsewhere the same person is not stopped.
    expect(await wallets.admit({ payerUserId: owner.id })).toEqual({
      ok: true,
    });
  });
});

describe("the computer meter", () => {
  test("charges a running computer's owner a minute, and stops one nobody can pay for", async () => {
    await billingOn({ computerMinutePrice: 25 });
    const ana = await person();
    const broke = await person();
    const space = await workspace.create(ana.id, { name: "Launch" });
    await wallets.mint({ userId: ana.id, amount: 100 });
    const stopped: string[] = [];
    const meter = createComputerMeter({
      wallets,
      computers: async () => [
        { botId: space.id, running: true },
        { botId: "bot-of-broke", running: true },
        { botId: "idle-bot", running: false },
      ],
      ownerOf: async (id) => (id === space.id ? ana.id : broke.id),
      stop: async (id) => void stopped.push(id),
      now: () => clock,
      log: () => {},
    });
    expect(await meter.tick()).toEqual({
      charged: [space.id],
      stopped: ["bot-of-broke"],
    });
    expect(stopped).toEqual(["bot-of-broke"]);
    expect((await wallets.wallet(ana.id)).balance).toBe(75);
    expect((await wallets.entries(ana.id))[0]).toMatchObject({
      category: "compute",
      spaceId: space.id,
      amount: -25,
    });
    expect((await wallets.budgetOf(space.id)).spent).toBe(25);
    const [row] = await database
      .select({ reference: ledgerEntries.reference })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.fromUserId, ana.id))
      .limit(1);
    expect(row?.reference).toBe(`computer:${space.id}:2026-10-01T12:00`);
  });
});
