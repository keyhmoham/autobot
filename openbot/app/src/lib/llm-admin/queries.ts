/**
 * Admin → Models: providers, models, roles and usage through the managed gateway.
 */
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const llmAdminKeys = {
  all: ["llm-admin"] as const,
  providers: () => ["llm-admin", "providers"] as const,
  models: () => ["llm-admin", "models"] as const,
  roles: () => ["llm-admin", "roles"] as const,
  presets: () => ["llm-admin", "presets"] as const,
  usage: () => ["llm-admin", "usage"] as const,
};

export const llmProvidersQueryOptions = () =>
  queryOptions({
    queryKey: llmAdminKeys.providers(),
    queryFn: (): Promise<unknown[]> =>
      client("/api/admin/llm/providers", "providers", {
        fallback: "Couldn't load model providers.",
      }),
  });

export const llmModelsQueryOptions = () =>
  queryOptions({
    queryKey: llmAdminKeys.models(),
    queryFn: (): Promise<unknown[]> =>
      client("/api/admin/llm/models", "models", {
        fallback: "Couldn't load models.",
      }),
  });

export const llmRolesQueryOptions = () =>
  queryOptions({
    queryKey: llmAdminKeys.roles(),
    queryFn: (): Promise<unknown> =>
      client("/api/admin/llm/roles", "roles", {
        fallback: "Couldn't load model roles.",
      }),
  });

export const llmPresetsQueryOptions = () =>
  queryOptions({
    queryKey: llmAdminKeys.presets(),
    queryFn: (): Promise<unknown[]> =>
      client("/api/admin/llm/presets", "presets", {
        fallback: "Couldn't load provider presets.",
      }),
  });

export const llmUsageQueryOptions = () =>
  queryOptions({
    queryKey: llmAdminKeys.usage(),
    queryFn: async (): Promise<unknown> => {
      const response = await client("/api/admin/llm/usage", {
        fallback: "Couldn't load model usage.",
      });
      return response.json();
    },
  });
