/**
 * Admin → Models: vendor accounts, catalogued models, role assignments and usage.
 */
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type LlmProvider = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  hasKey: boolean;
  createdAt: string;
};

export type LlmModel = {
  id: string;
  providerId: string;
  name: string;
  displayName: string;
  inputPrice: number;
  outputPrice: number;
  enabled: boolean;
};

/** Role → model name (or null), as `/api/admin/llm/roles` returns. */
export type LlmRoleAssignment = Record<string, string | null>;

export const modelKeys = {
  all: ["llm-admin"] as const,
  providers: () => ["llm-admin", "providers"] as const,
  models: () => ["llm-admin", "models"] as const,
  roles: () => ["llm-admin", "roles"] as const,
  usage: (days: number) => ["llm-admin", "usage", days] as const,
  presets: () => ["llm-admin", "presets"] as const,
};

export const llmProvidersQueryOptions = () =>
  queryOptions({
    queryKey: modelKeys.providers(),
    queryFn: (): Promise<LlmProvider[]> =>
      client("/api/admin/llm/providers", "providers", {
        fallback: "Couldn't load model providers.",
      }),
  });

export const llmModelsQueryOptions = () =>
  queryOptions({
    queryKey: modelKeys.models(),
    queryFn: (): Promise<LlmModel[]> =>
      client("/api/admin/llm/models", "models", {
        fallback: "Couldn't load models.",
      }),
  });

export const llmRolesQueryOptions = () =>
  queryOptions({
    queryKey: modelKeys.roles(),
    queryFn: (): Promise<LlmRoleAssignment> =>
      client("/api/admin/llm/roles", "roles", {
        fallback: "Couldn't load model roles.",
      }),
  });

export const llmUsageQueryOptions = (days = 30) =>
  queryOptions({
    queryKey: modelKeys.usage(days),
    queryFn: async (): Promise<unknown> => {
      const response = await client(`/api/admin/llm/usage?days=${days}`, {
        fallback: "Couldn't load model usage.",
      });
      return response.json();
    },
  });

export const llmPresetsQueryOptions = () =>
  queryOptions({
    queryKey: modelKeys.presets(),
    queryFn: (): Promise<unknown[]> =>
      client("/api/admin/llm/presets", "presets", {
        fallback: "Couldn't load provider presets.",
      }),
  });
