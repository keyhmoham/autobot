import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  type CreatedAccessToken,
  createAccessTokenMutationOptions,
  revokeAccessTokenMutationOptions,
} from "@/lib/access-tokens/mutations";
import { accessTokensQueryOptions } from "@/lib/access-tokens/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/access-tokens")({
  component: AccessTokensPage,
});

/**
 * Personal access tokens for the CLI and other clients that cannot hold a browser session. The
 * secret is shown once when the token is made, then never again.
 */
function AccessTokensPage() {
  const formId = useId();
  const tokens = useQuery(accessTokensQueryOptions());
  const create = useMutation(createAccessTokenMutationOptions(queryClient));
  const revoke = useMutation(revokeAccessTokenMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState("");
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);

  return (
    <PageShell
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          New token
        </Button>
      }
      description="Tokens for the CLI and other tools that cannot sign in through the browser. Copy a new one when it is made — you will not see it again."
      title="Access tokens"
    >
      <Dialog
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) {
            setName("");
            setDays("");
            create.reset();
          }
        }}
        open={adding}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New access token</DialogTitle>
            <DialogDescription>
              Name it after the tool that will use it. You can set an expiry or
              leave it open-ended.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <form
              className="flex flex-col gap-3"
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                const expiresInDays = days.trim()
                  ? Number(days)
                  : null;
                create.mutate(
                  {
                    name: name.trim(),
                    expiresInDays:
                      expiresInDays !== null && Number.isFinite(expiresInDays)
                        ? expiresInDays
                        : null,
                  },
                  {
                    onSuccess: (token) => {
                      setCreated(token);
                      setAdding(false);
                      setName("");
                      setDays("");
                    },
                  },
                );
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-name">Name</Label>
                <Input
                  autoComplete="off"
                  id="token-name"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Laptop CLI"
                  required
                  value={name}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-days">Expires in days (optional)</Label>
                <Input
                  id="token-days"
                  inputMode="numeric"
                  min={1}
                  onChange={(event) => setDays(event.target.value)}
                  placeholder="Leave blank to never expire"
                  type="number"
                  value={days}
                />
              </div>
              {create.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {create.error.message}
                </p>
              ) : null}
            </form>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={create.isPending || !name.trim()}
              form={formId}
              type="submit"
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
        open={created !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your token</DialogTitle>
            <DialogDescription>
              This is the only time the secret is shown. Store it somewhere
              safe.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {created ? (
              <code className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                {created.token}
              </code>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => {
                if (created?.token)
                  void navigator.clipboard.writeText(created.token);
              }}
              type="button"
              variant="secondary"
            >
              Copy
            </Button>
            <Button onClick={() => setCreated(null)} type="button">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PageSection title="Your tokens">
        {tokens.isPending ? null : tokens.error ? (
          <p className="text-destructive text-sm" role="alert">
            {tokens.error.message}
          </p>
        ) : tokens.data.length === 0 ? (
          <PageEmpty>
            No tokens yet. Make one when a tool needs to call the API as you.
          </PageEmpty>
        ) : (
          <PageRows>
            {tokens.data.map((token, index) => (
              <div key={token.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{token.name}</ItemTitle>
                    <ItemDescription>
                      {token.prefix}…
                      {token.expiresAt
                        ? ` · expires ${new Date(token.expiresAt).toLocaleDateString()}`
                        : " · never expires"}
                      {token.lastUsedAt
                        ? ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Revoke ${token.name}`}
                      disabled={
                        revoke.isPending && revoke.variables === token.id
                      }
                      onClick={() => revoke.mutate(token.id)}
                      size="sm"
                      variant="ghost"
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {revoke.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {revoke.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
