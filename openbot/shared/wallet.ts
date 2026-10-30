/**
 * Wallets, read from both sides: what a ledger entry can be, what a charge pays for, and the shapes
 * the wallet screens and Admin → Billing are drawn from.
 *
 * Amounts are whole credits, the same unit model prices are in (shared/llm.ts): a million credits are
 * a dollar. A wallet's balance is the sum of its ledger, kept on the wallet row so it is read without
 * adding anything up; the ledger is append-only and is the record of why the balance is what it is.
 */
import { CREDITS_PER_DOLLAR } from "./llm";

/**
 * What a ledger entry records.
 *
 * `mint`: credits an administrator added, from nowhere. `transfer`: one person to another. `spend`:
 * work charged to a wallet (its category says what for). `expire`: the unspent part of a grant taken
 * back on its expiry date.
 */
export const LEDGER_ENTRY_TYPES = [
  "mint",
  "transfer",
  "spend",
  "expire",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * What a charge paid for. `llm`: a model's tokens through the gateway. `compute`: minutes a computer
 * ran. `app`: an app's own running time in a space computer.
 */
export const CHARGE_CATEGORIES = ["llm", "compute", "app"] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export type BillingSettingsWire = {
  /**
   * Whether work is charged to wallets at all. Off, every call and every computer minute is still
   * metered and shown, but nothing is refused and no balance moves: the right setting for a
   * deployment run by one team on its own keys.
   */
  enabled: boolean;
  /** Credits every new wallet starts with, as a grant. 0 gives none. */
  signupGrant: number;
  /** How many days a grant lasts before what is left of it lapses. 0 means it never does. */
  grantDays: number;
  /** Credits a running computer costs per minute. */
  computerMinutePrice: number;
};

export const DEFAULT_BILLING_SETTINGS: BillingSettingsWire = {
  enabled: false,
  signupGrant: 0,
  grantDays: 30,
  computerMinutePrice: 0,
};

export type WalletWire = {
  userId: string;
  /** May go below zero by the last piece of work that was already done when it ran out. */
  balance: number;
  updatedAt: string;
};

export type LedgerEntryWire = {
  id: string;
  /** Global order; also the cursor a page of entries is read before. */
  seq: number;
  type: LedgerEntryType;
  category: ChargeCategory | null;
  /** Signed from the reader's side: what came in is positive, what went out negative. */
  amount: number;
  description: string;
  /** The other person in a transfer, by name. */
  counterparty: string | null;
  spaceId: string | null;
  createdAt: string;
};

export type GrantWire = {
  id: string;
  amount: number;
  remaining: number;
  expiresAt: string;
  status: "active" | "expired";
  createdAt: string;
};

export type BudgetWire = {
  spaceId: string;
  /** Credits the space may spend. 0 means no limit. */
  cap: number;
  spent: number;
};

/** How a credit amount reads to a person: dollars, to the cent, with a sign when it is negative. */
export function formatCredits(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR;
  const abs = Math.abs(dollars);
  const shown =
    abs !== 0 && abs < 0.01
      ? "<$0.01"
      : `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return dollars < 0 ? `-${shown}` : shown;
}
