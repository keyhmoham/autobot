import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  BillingSettingsWire,
  BudgetWire,
  WalletWire,
} from "@openbot/shared/wallet";
import { client } from "@/lib/client";
import { walletKeys } from "./queries";

function invalidateWallet(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: walletKeys.all });
}

export function transferMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      to: string;
      amount: number;
      note?: string;
      node?: string;
    }): Promise<WalletWire> =>
      client("/api/wallet/transfers", "wallet", {
        method: "POST",
        body: input,
        fallback: "Couldn't send those credits.",
      }),
    onSuccess: () => invalidateWallet(queryClient),
  });
}

export function setBudgetMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      spaceId: string;
      cap: number;
    }): Promise<BudgetWire> =>
      client(`/api/budgets/${encodeURIComponent(variables.spaceId)}`, "budget", {
        method: "PUT",
        body: { cap: variables.cap },
        fallback: "Couldn't set that budget.",
      }),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: walletKeys.budget(variables.spaceId),
      }),
  });
}

export function updateBillingSettingsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      input: Partial<BillingSettingsWire>,
    ): Promise<BillingSettingsWire> =>
      client("/api/admin/billing/settings", "settings", {
        method: "PUT",
        body: input,
        fallback: "Couldn't save billing settings.",
      }),
    onSuccess: () => invalidateWallet(queryClient),
  });
}

export function mintCreditsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      userId: string;
      amount: number;
      description?: string;
      expiresInDays?: number | null;
    }): Promise<WalletWire> =>
      client("/api/admin/billing/mint", "wallet", {
        method: "POST",
        body: input,
        fallback: "Couldn't add those credits.",
      }),
    onSuccess: () => invalidateWallet(queryClient),
  });
}
