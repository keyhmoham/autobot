import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type LlmModel, type LlmProvider, modelKeys } from "./queries";

function invalidateModels(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: modelKeys.all });
}

export function createProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: Record<string, unknown>): Promise<LlmProvider> =>
      client("/api/admin/llm/providers", "provider", {
        method: "POST",
        body: input,
        fallback: "Couldn't add that provider.",
      }),
    onSuccess: () => invalidateModels(queryClient),
  });
}

export function updateProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      input: Record<string, unknown>;
    }): Promise<LlmProvider> =>
      client(
        `/api/admin/llm/providers/${encodeURIComponent(variables.id)}`,
        "provider",
        {
          method: "PATCH",
          body: variables.input,
          fallback: "Couldn't save that provider.",
        },
      ),
    onSuccess: () => invalidateModels(queryClient),
  });
}

export function deleteProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/admin/llm/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't remove that provider.",
      }),
    onSuccess: () => invalidateModels(queryClient),
  });
}

export function importModelsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (providerId: string) =>
      client(
        `/api/admin/llm/providers/${encodeURIComponent(providerId)}/import`,
        {
          method: "POST",
          fallback: "Couldn't import models.",
        },
      ),
    onSuccess: () => invalidateModels(queryClient),
  });
}

export function updateModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      input: Partial<LlmModel>;
    }): Promise<LlmModel> =>
      client(
        `/api/admin/llm/models/${encodeURIComponent(variables.id)}`,
        "model",
        {
          method: "PATCH",
          body: variables.input,
          fallback: "Couldn't save that model.",
        },
      ),
    onSuccess: () => invalidateModels(queryClient),
  });
}

export function setRoleModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { role: string; modelId: string | null }) =>
      client(`/api/admin/llm/roles/${encodeURIComponent(variables.role)}`, {
        method: "PUT",
        body: { modelId: variables.modelId },
        fallback: "Couldn't assign that model.",
      }),
    onSuccess: () => invalidateModels(queryClient),
  });
}
