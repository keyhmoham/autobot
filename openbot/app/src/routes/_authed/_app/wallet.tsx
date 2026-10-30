import { formatCredits } from "@openbot/shared/wallet";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { transferMutationOptions } from "@/lib/wallet/mutations";
import { walletQueryOptions } from "@/lib/wallet/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/wallet")({
  component: WalletPage,
});

/**
 * Your balance, the grants that make it up, recent ledger lines, and a form to send credits to
 * somebody else.
 */
function WalletPage() {
  const wallet = useQuery(walletQueryOptions());
  const transfer = useMutation(transferMutationOptions(queryClient));
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  return (
    <PageShell
      description="Credits for model calls and computers on this deployment. Send some to somebody else when you need to."
      title="Wallet"
    >
      {wallet.isPending ? null : wallet.error ? (
        <p className="text-destructive text-sm" role="alert">
          {wallet.error.message}
        </p>
      ) : wallet.data ? (
        <>
          <PageSection title="Balance">
            <p className="mt-2 font-semibold text-3xl text-foreground tabular-nums tracking-tight">
              {formatCredits(wallet.data.wallet.balance)}
            </p>
            {!wallet.data.billing ? (
              <p className="mt-2 text-muted-foreground text-sm">
                Billing is off for this deployment. Balances still update when
                an administrator mints or someone sends you credits.
              </p>
            ) : null}
          </PageSection>

          <PageSection title="Send credits">
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const credits = Number(amount);
                if (!to.trim() || !Number.isFinite(credits) || credits <= 0)
                  return;
                transfer.mutate(
                  {
                    to: to.trim(),
                    amount: credits,
                    note: note.trim() || undefined,
                  },
                  {
                    onSuccess: () => {
                      setTo("");
                      setAmount("");
                      setNote("");
                    },
                  },
                );
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wallet-to">To (handle, email or user id)</Label>
                <Input
                  autoComplete="off"
                  id="wallet-to"
                  onChange={(event) => setTo(event.target.value)}
                  placeholder="alex"
                  value={to}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wallet-amount">Amount (credits)</Label>
                <Input
                  id="wallet-amount"
                  inputMode="numeric"
                  min={1}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="1000000"
                  type="number"
                  value={amount}
                />
                {amount && Number.isFinite(Number(amount)) ? (
                  <p className="text-muted-foreground text-xs">
                    About {formatCredits(Number(amount))}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wallet-note">Note (optional)</Label>
                <Input
                  id="wallet-note"
                  maxLength={200}
                  onChange={(event) => setNote(event.target.value)}
                  value={note}
                />
              </div>
              <Button
                disabled={transfer.isPending || !to.trim() || !amount}
                type="submit"
              >
                Send
              </Button>
              {transfer.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {transfer.error.message}
                </p>
              ) : null}
            </form>
          </PageSection>

          <PageSection title="Grants">
            {wallet.data.grants.length === 0 ? (
              <PageEmpty>No grants yet.</PageEmpty>
            ) : (
              <PageRows>
                {wallet.data.grants.map((grant, index) => (
                  <div key={grant.id}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>
                          {formatCredits(grant.remaining)} left of{" "}
                          {formatCredits(grant.amount)}
                        </ItemTitle>
                        <ItemDescription>
                          {grant.status === "expired"
                            ? "Expired"
                            : `Expires ${new Date(grant.expiresAt).toLocaleDateString()}`}
                        </ItemDescription>
                      </ItemContent>
                    </Item>
                  </div>
                ))}
              </PageRows>
            )}
          </PageSection>

          <PageSection title="Recent">
            {wallet.data.entries.length === 0 ? (
              <PageEmpty>Nothing on the ledger yet.</PageEmpty>
            ) : (
              <PageRows>
                {wallet.data.entries.map((entry, index) => (
                  <div key={entry.id}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>
                          <span
                            className={
                              entry.amount < 0
                                ? "text-destructive"
                                : undefined
                            }
                          >
                            {entry.amount > 0 ? "+" : ""}
                            {formatCredits(entry.amount)}
                          </span>
                          {" · "}
                          {entry.type}
                          {entry.category ? ` · ${entry.category}` : ""}
                        </ItemTitle>
                        <ItemDescription>
                          {entry.description}
                          {entry.counterparty
                            ? ` · ${entry.counterparty}`
                            : ""}
                          {" · "}
                          {new Date(entry.createdAt).toLocaleString()}
                        </ItemDescription>
                      </ItemContent>
                    </Item>
                  </div>
                ))}
              </PageRows>
            )}
          </PageSection>
        </>
      ) : null}
    </PageShell>
  );
}
