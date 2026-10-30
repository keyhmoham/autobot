import { IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
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
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  type CreatedJoinCode,
  createJoinCodeMutationOptions,
  federationHeartbeatMutationOptions,
  joinFederationMutationOptions,
  removeFederationNodeMutationOptions,
  revokeJoinCodeMutationOptions,
} from "@/lib/federation/mutations";
import { federationAdminQueryOptions } from "@/lib/federation/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/federation")({
  component: FederationPage,
});

/**
 * This node in the federation, the others it knows, join codes when it is central, and a way to
 * join another federation with a code.
 */
function FederationPage() {
  const admin = useQuery(federationAdminQueryOptions());
  const createCode = useMutation(createJoinCodeMutationOptions(queryClient));
  const revokeCode = useMutation(revokeJoinCodeMutationOptions(queryClient));
  const join = useMutation(joinFederationMutationOptions(queryClient));
  const removeNode = useMutation(
    removeFederationNodeMutationOptions(queryClient),
  );
  const heartbeat = useMutation(
    federationHeartbeatMutationOptions(queryClient),
  );

  const [label, setLabel] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [created, setCreated] = useState<CreatedJoinCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <PageShell
      action={
        <Button
          disabled={heartbeat.isPending}
          onClick={() =>
            heartbeat.mutate(undefined, {
              onError: (thrown) => setError(thrown.message),
            })
          }
          size="sm"
          variant="ghost"
        >
          <IconRefresh />
          Ping
        </Button>
      }
      description="This deployment's place among other nodes, and the codes that let another join."
      title="Federation"
    >
      {error ? (
        <p className="mb-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
        open={created !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy the join code</DialogTitle>
            <DialogDescription>
              This is the only time the code is shown. Give it to the node that
              is joining.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {created ? (
              <code className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                {created.code}
              </code>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => {
                if (created?.code)
                  void navigator.clipboard.writeText(created.code);
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

      {admin.isPending ? null : admin.error ? (
        <p className="text-destructive text-sm" role="alert">
          {admin.error.message}
        </p>
      ) : admin.data ? (
        <>
          <PageSection title="This node">
            <PageRows>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{admin.data.self.name}</ItemTitle>
                  <ItemDescription>
                    {admin.data.self.id}
                    {admin.data.self.isCentral ? " · central" : ""}
                    {admin.data.self.url ? ` · ${admin.data.self.url}` : ""}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </PageRows>
          </PageSection>

          <PageSection title="Nodes">
            {admin.data.nodes.length === 0 ? (
              <PageEmpty>No other nodes yet.</PageEmpty>
            ) : (
              <PageRows>
                {admin.data.nodes.map((node, index) => (
                  <div key={node.id}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>{node.name}</ItemTitle>
                        <ItemDescription>
                          {node.status}
                          {node.url ? ` · ${node.url}` : ""}
                          {node.lastSeenAt
                            ? ` · last seen ${new Date(node.lastSeenAt).toLocaleString()}`
                            : ""}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {node.id === admin.data.self.id ? null : (
                          <Button
                            aria-label={`Remove ${node.name}`}
                            disabled={removeNode.isPending}
                            onClick={() =>
                              removeNode.mutate(node.id, {
                                onError: (thrown) => setError(thrown.message),
                              })
                            }
                            size="sm"
                            variant="ghost"
                          >
                            <IconTrash />
                          </Button>
                        )}
                      </ItemActions>
                    </Item>
                  </div>
                ))}
              </PageRows>
            )}
          </PageSection>

          {admin.data.self.isCentral ? (
            <PageSection title="Join codes">
              <form
                className="mt-3 mb-4 flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError(null);
                  createCode.mutate(
                    { label: label.trim() || undefined },
                    {
                      onError: (thrown) => setError(thrown.message),
                      onSuccess: (code) => {
                        setCreated(code);
                        setLabel("");
                      },
                    },
                  );
                }}
              >
                <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="join-label">Label (optional)</Label>
                  <Input
                    id="join-label"
                    onChange={(event) => setLabel(event.target.value)}
                    value={label}
                  />
                </div>
                <Button disabled={createCode.isPending} type="submit">
                  <IconPlus />
                  Make code
                </Button>
              </form>
              {admin.data.joinCodes.length === 0 ? (
                <PageEmpty>No join codes yet.</PageEmpty>
              ) : (
                <PageRows>
                  {admin.data.joinCodes.map((code, index) => (
                    <div key={code.id}>
                      {index > 0 ? <Separator /> : null}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{code.label || "Untitled code"}</ItemTitle>
                          <ItemDescription>
                            Made {new Date(code.createdAt).toLocaleDateString()}
                            {code.expiresAt
                              ? ` · expires ${new Date(code.expiresAt).toLocaleDateString()}`
                              : ""}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            aria-label={`Revoke ${code.code}`}
                            disabled={revokeCode.isPending}
                            onClick={() =>
                              revokeCode.mutate(code.id, {
                                onError: (thrown) => setError(thrown.message),
                              })
                            }
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
            </PageSection>
          ) : (
            <PageSection title="Join a federation">
              <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError(null);
                  if (!joinCode.trim()) return;
                  if (!joinUrl.trim()) {
                    setError("Say where the central node is.");
                    return;
                  }
                  join.mutate(
                    {
                      code: joinCode.trim(),
                      centralUrl: joinUrl.trim(),
                    },
                    {
                      onError: (thrown) => setError(thrown.message),
                      onSuccess: () => {
                        setJoinCode("");
                        setJoinUrl("");
                      },
                    },
                  );
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="federation-code">Join code</Label>
                  <Input
                    id="federation-code"
                    onChange={(event) => setJoinCode(event.target.value)}
                    value={joinCode}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="federation-url">Central URL</Label>
                  <Input
                    id="federation-url"
                    onChange={(event) => setJoinUrl(event.target.value)}
                    placeholder="https://central.example"
                    required
                    value={joinUrl}
                  />
                </div>
                <Button
                  disabled={
                    join.isPending || !joinCode.trim() || !joinUrl.trim()
                  }
                  type="submit"
                >
                  Join
                </Button>
              </form>
            </PageSection>
          )}
        </>
      ) : null}
    </PageShell>
  );
}
