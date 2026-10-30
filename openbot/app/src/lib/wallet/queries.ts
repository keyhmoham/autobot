/**
 * A person's wallet, a space's budget, and Admin → Billing.
 */
import { queryOptions } from "@tanstack/react-query";
import type {
  BillingSettingsWire,
  BudgetWire,
  GrantWire,
  LedgerEntryWire,
  WalletWire,
} from "@openbot/shared/wallet";
import { client } from "@/lib/client";

export const walletKeys = {
  all: ["wallet"] as const,
  mine: () => ["wallet", "mine"] as const,
  entries: () => ["wallet", "entries"] as const,
  budget: (spaceId: string) => ["wallet", "budget", spaceId] as const,
  adminSettings: () => ["wallet", "admin", "settings"] as const,
  adminOverview: (days: number) => ["wallet", "admin", "overview", days] as const,
  adminWallets: (q: string) => ["wallet", "admin", "wallets", q] as const,
};

export type WalletPage = {
  wallet: WalletWire;
  grants: GrantWire[];
  entries: LedgerEntryWire[];
  billing: boolean;
};

export type BillingOverview = {
  spent: number;
  minted: number;
  transferred: number;
  byCategory: { category: string; amount: number }[];
  days: number;
};

export const walletQueryOptions = () =>
  queryOptions({
    queryKey: walletKeys.mine(),
    queryFn: async (): Promise<WalletPage> => {
      const response = await client("/api/wallet", {
        fallback: "Couldn't load your wallet.",
      });
      return (await response.json()) as WalletPage;
    },
  });

export const walletEntriesQueryOptions = () =>
  queryOptions({
    queryKey: walletKeys.entries(),
    queryFn: (): Promise<LedgerEntryWire[]> =>
      client("/api/wallet/entries", "entries", {
        fallback: "Couldn't load your ledger.",
      }),
  });

export const budgetQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: walletKeys.budget(spaceId),
    queryFn: (): Promise<BudgetWire> =>
      client(`/api/budgets/${encodeURIComponent(spaceId)}`, "budget", {
        fallback: "Couldn't load this space's budget.",
      }),
  });

export const billingSettingsQueryOptions = () =>
  queryOptions({
    queryKey: walletKeys.adminSettings(),
    queryFn: (): Promise<BillingSettingsWire> =>
      client("/api/admin/billing/settings", "settings", {
        fallback: "Couldn't load billing settings.",
      }),
  });

export const billingOverviewQueryOptions = (days = 30) =>
  queryOptions({
    queryKey: walletKeys.adminOverview(days),
    queryFn: async (): Promise<BillingOverview> => {
      const response = await client(`/api/admin/billing/overview?days=${days}`, {
        fallback: "Couldn't load billing overview.",
      });
      return (await response.json()) as BillingOverview;
    },
  });

export const adminWalletsQueryOptions = (q = "") =>
  queryOptions({
    queryKey: walletKeys.adminWallets(q),
    queryFn: (): Promise<WalletWire[]> =>
      client(
        `/api/admin/billing/wallets${q ? `?q=${encodeURIComponent(q)}` : ""}`,
        "wallets",
        { fallback: "Couldn't load wallets." },
      ),
  });
