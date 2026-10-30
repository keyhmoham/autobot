import { LLM_ROLES, type LlmRole } from "@openbot/shared/llm";
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
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  createProviderMutationOptions,
  deleteProviderMutationOptions,
  importModelsMutationOptions,
  setRoleModelMutationOptions,
  updateModelMutationOptions,
} from "@/lib/models/mutations";
import {
  llmModelsQueryOptions,
  llmProvidersQueryOptions,
  llmRolesQueryOptions,
  type LlmModel,
} from "@/lib/models/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/models")({
  component: ModelsPage,
});

/**
 * Vendor accounts, the model catalogue, and which model fills each gateway role.
 */
function ModelsPage() {
  const providers = useQuery(llmProvidersQueryOptions());
  const models = useQuery(llmModelsQueryOptions());
  const roles = useQuery(llmRolesQueryOptions());
  const createProvider = useMutation(createProviderMutationOptions(queryClient));
  const removeProvider = useMutation(deleteProviderMutationOptions(queryClient));
  const importModels = useMutation(importModelsMutationOptions(queryClient));
  const updateModel = useMutation(updateModelMutationOptions(queryClient));
  const setRole = useMutation(setRoleModelMutationOptions(queryClient));

  const [name, setName] = useState("");
  const [kind, setKind] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const roleMap = roles.data ?? {};
  const modelByName = new Map(
    (models.data ?? []).map((model) => [model.name, model]),
  );
  const modelById = new Map(
    (models.data ?? []).map((model) => [model.id, model]),
  );

  return (
    <PageShell
      description="Vendor accounts for the gateway, the models it can call, and which one fills each role."
      title="Models"
    >
      {error ? (
        <p className="mb-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection title="Providers">
        <form
          className="mt-3 mb-4 flex flex-col gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            createProvider.mutate(
              {
                name: name.trim(),
                kind,
                baseUrl: baseUrl.trim() || undefined,
                apiKey: apiKey.trim() || undefined,
              },
              {
                onError: (thrown) => setError(thrown.message),
                onSuccess: () => {
                  setName("");
                  setBaseUrl("");
                  setApiKey("");
                },
              },
            );
          }}
        >
          <p className="font-medium text-sm">Add a provider</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-name">Name</Label>
              <Input
                id="provider-name"
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-kind">Kind</Label>
              <Input
                id="provider-kind"
                onChange={(event) => setKind(event.target.value)}
                placeholder="openai"
                value={kind}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-url">Base URL</Label>
              <Input
                id="provider-url"
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-key">API key</Label>
              <Input
                autoComplete="off"
                id="provider-key"
                onChange={(event) => setApiKey(event.target.value)}
                type="password"
                value={apiKey}
              />
            </div>
          </div>
          <Button disabled={createProvider.isPending || !name.trim()} type="submit">
            <IconPlus />
            Add provider
          </Button>
        </form>

        {providers.isPending ? null : providers.error ? (
          <p className="text-destructive text-sm" role="alert">
            {providers.error.message}
          </p>
        ) : providers.data.length === 0 ? (
          <PageEmpty>No providers yet.</PageEmpty>
        ) : (
          <PageRows>
            {providers.data.map((provider, index) => (
              <div key={provider.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{provider.name}</ItemTitle>
                    <ItemDescription>
                      {provider.kind}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
                      {provider.hasKey ? " · key saved" : " · no key"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Import models from ${provider.name}`}
                      disabled={importModels.isPending}
                      onClick={() =>
                        importModels.mutate(provider.id, {
                          onError: (thrown) => setError(thrown.message),
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      <IconRefresh />
                      Import
                    </Button>
                    <Button
                      aria-label={`Remove ${provider.name}`}
                      disabled={removeProvider.isPending}
                      onClick={() =>
                        removeProvider.mutate(provider.id, {
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

      <PageSection title="Models">
        {models.isPending ? null : models.error ? (
          <p className="text-destructive text-sm" role="alert">
            {models.error.message}
          </p>
        ) : models.data.length === 0 ? (
          <PageEmpty>
            No models yet. Import from a provider, or wait until one is added.
          </PageEmpty>
        ) : (
          <PageRows>
            {models.data.map((model, index) => (
              <div key={model.id}>
                {index > 0 ? <Separator /> : null}
                <ModelRow
                  model={model}
                  onToggle={(enabled) =>
                    updateModel.mutate(
                      { id: model.id, input: { enabled } },
                      { onError: (thrown) => setError(thrown.message) },
                    )
                  }
                  providerName={
                    providers.data?.find((row) => row.id === model.providerId)
                      ?.name ?? model.providerId
                  }
                />
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection title="Roles">
        <p className="mb-3 text-muted-foreground text-sm">
          Which model the gateway uses for chat, decisions and embeddings.
        </p>
        {roles.isPending ? null : roles.error ? (
          <p className="text-destructive text-sm" role="alert">
            {roles.error.message}
          </p>
        ) : (
          <PageRows>
            {LLM_ROLES.map((role, index) => {
              const assignedName = roleMap[role] ?? null;
              const assigned =
                (assignedName && modelByName.get(assignedName)) ||
                (assignedName && modelById.get(assignedName)) ||
                null;
              return (
                <div key={role}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{role}</ItemTitle>
                      <ItemDescription>
                        {assigned
                          ? assigned.displayName || assigned.name
                          : "None assigned"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Select
                        onValueChange={(value) => {
                          if (value == null) return;
                          setRole.mutate(
                            {
                              role,
                              modelId: value === "__none__" ? null : value,
                            },
                            {
                              onError: (thrown) => setError(thrown.message),
                            },
                          );
                        }}
                        value={assigned?.id ?? "__none__"}
                      >
                        <SelectTrigger className="w-[220px]" size="sm">
                          <SelectValue placeholder="Choose a model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {(models.data ?? []).map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.displayName || model.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ItemActions>
                  </Item>
                </div>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

function ModelRow({
  model,
  providerName,
  onToggle,
}: {
  model: LlmModel;
  providerName: string;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{model.displayName || model.name}</ItemTitle>
        <ItemDescription>
          {providerName} · {model.name} · in {model.inputPrice}/M · out{" "}
          {model.outputPrice}/M
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch checked={model.enabled} onCheckedChange={onToggle} />
      </ItemActions>
    </Item>
  );
}

/** Keep the role union in the file so a rename fails the build. */
void (null as LlmRole | null);
