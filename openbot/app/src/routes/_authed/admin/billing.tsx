import { formatCredits } from "@openbot/shared/wallet";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
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
import { Switch } from "@/components/ui/switch";
import {
  mintCreditsMutationOptions,
  updateBillingSettingsMutationOptions,
} from "@/lib/wallet/mutations";
import {
  billingOverviewQueryOptions,
  billingSettingsQueryOptions,
} from "@/lib/wallet/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/billing")({
  component: BillingPage,
});

/**
 * Whether wallets are charged, the signup grant, a spend overview, and a form to mint credits.
 */
function BillingPage() {
  const settings = useQuery(billingSettingsQueryOptions());
  const overview = useQuery(billingOverviewQueryOptions(30));
  const save = useMutation(updateBillingSettingsMutationOptions(queryClient));
  const mint = useMutation(mintCreditsMutationOptions(queryClient));

  const [enabled, setEnabled] = useState(false);
  const [signupGrant, setSignupGrant] = useState("0");
  const [grantDays, setGrantDays] = useState("30");
  const [computerMinutePrice, setComputerMinutePrice] = useState("0");
  const [mintUserId, setMintUserId] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [mintDescription, setMintDescription] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled);
    setSignupGrant(String(settings.data.signupGrant));
    setGrantDays(String(settings.data.grantDays));
    setComputerMinutePrice(String(settings.data.computerMinutePrice));
  }, [settings.data]);

  return (
    <PageShell
      description="Whether work is charged to wallets, what new people start with, and minting credits by hand."
      title="Billing"
    >
      {error ? (
        <p className="mb-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection title="Settings">
        {settings.isPending ? null : settings.error ? (
          <p className="text-destructive text-sm" role="alert">
            {settings.error.message}
          </p>
        ) : (
          <form
            className="mt-3 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setSaved(false);
              save.mutate(
                {
                  enabled,
                  signupGrant: Number(signupGrant) || 0,
                  grantDays: Number(grantDays) || 0,
                  computerMinutePrice: Number(computerMinutePrice) || 0,
                },
                {
                  onError: (thrown) => setError(thrown.message),
                  onSuccess: () => setSaved(true),
                },
              );
            }}
          >
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span>
                <span className="block font-medium text-sm">
                  Charge wallets
                </span>
                <span className="block text-muted-foreground text-xs">
                  Off, work is still metered but nothing is refused and balances
                  do not move for spend.
                </span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signup-grant">Signup grant (credits)</Label>
                <Input
                  id="signup-grant"
                  inputMode="numeric"
                  onChange={(event) => setSignupGrant(event.target.value)}
                  type="number"
                  value={signupGrant}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="grant-days">Grant days</Label>
                <Input
                  id="grant-days"
                  inputMode="numeric"
                  onChange={(event) => setGrantDays(event.target.value)}
                  type="number"
                  value={grantDays}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="computer-price">Computer / minute</Label>
                <Input
                  id="computer-price"
                  inputMode="numeric"
                  onChange={(event) =>
                    setComputerMinutePrice(event.target.value)
                  }
                  type="number"
                  value={computerMinutePrice}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button disabled={save.isPending} type="submit">
                Save settings
              </Button>
              {saved && !save.isPending ? (
                <p className="text-muted-foreground text-sm">Saved.</p>
              ) : null}
            </div>
          </form>
        )}
      </PageSection>

      <PageSection title="Last 30 days">
        {overview.isPending ? null : overview.error ? (
          <p className="text-destructive text-sm" role="alert">
            {overview.error.message}
          </p>
        ) : overview.data ? (
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Spent {formatCredits(overview.data.spent)}</ItemTitle>
                <ItemDescription>
                  Minted {formatCredits(overview.data.minted)} · transferred{" "}
                  {formatCredits(overview.data.transferred)}
                </ItemDescription>
              </ItemContent>
            </Item>
            {overview.data.byCategory.map((row) => (
              <div key={row.category}>
                <Separator />
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{row.category}</ItemTitle>
                    <ItemDescription>
                      {formatCredits(row.amount)}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </div>
            ))}
          </PageRows>
        ) : null}
      </PageSection>

      <PageSection title="Mint credits">
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const amount = Number(mintAmount);
            if (!mintUserId.trim() || !Number.isFinite(amount) || amount <= 0)
              return;
            mint.mutate(
              {
                userId: mintUserId.trim(),
                amount,
                description: mintDescription.trim() || undefined,
              },
              {
                onError: (thrown) => setError(thrown.message),
                onSuccess: () => {
                  setMintUserId("");
                  setMintAmount("");
                  setMintDescription("");
                },
              },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mint-user">User id</Label>
            <Input
              id="mint-user"
              onChange={(event) => setMintUserId(event.target.value)}
              value={mintUserId}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mint-amount">Amount (credits)</Label>
            <Input
              id="mint-amount"
              inputMode="numeric"
              onChange={(event) => setMintAmount(event.target.value)}
              type="number"
              value={mintAmount}
            />
            {mintAmount && Number.isFinite(Number(mintAmount)) ? (
              <p className="text-muted-foreground text-xs">
                About {formatCredits(Number(mintAmount))}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mint-note">Description (optional)</Label>
            <Input
              id="mint-note"
              onChange={(event) => setMintDescription(event.target.value)}
              value={mintDescription}
            />
          </div>
          <Button
            disabled={mint.isPending || !mintUserId.trim() || !mintAmount}
            type="submit"
          >
            Mint
          </Button>
        </form>
      </PageSection>
    </PageShell>
  );
}
