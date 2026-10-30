import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { AppWire } from "@openbot/shared/apps";
import { client } from "@/lib/client";
import { type AppLaunch, appKeys } from "./queries";

function invalidateApps(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: appKeys.all });
}

export function launchAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<AppLaunch> => {
      const response = await client(`/api/apps/${encodeURIComponent(id)}/launch`, {
        method: "POST",
        fallback: "Couldn't open that app.",
      });
      return (await response.json()) as AppLaunch;
    },
    onSuccess: () => invalidateApps(queryClient),
  });
}

export function restartAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string): Promise<AppWire> =>
      client(`/api/apps/${encodeURIComponent(id)}/restart`, "app", {
        method: "POST",
        fallback: "Couldn't restart that app.",
      }),
    onSuccess: () => invalidateApps(queryClient),
  });
}

export function stopAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string): Promise<AppWire> =>
      client(`/api/apps/${encodeURIComponent(id)}/stop`, "app", {
        method: "POST",
        fallback: "Couldn't stop that app.",
      }),
    onSuccess: () => invalidateApps(queryClient),
  });
}

export function removeAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/apps/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't remove that app.",
      }),
    onSuccess: () => invalidateApps(queryClient),
  });
}
