/**
 * Web apps a space's Bots build and run in the space computer.
 */
import { queryOptions } from "@tanstack/react-query";
import type { AppWire } from "@openbot/shared/apps";
import { client } from "@/lib/client";

export const appKeys = {
  all: ["apps"] as const,
  list: (spaceId: string) => ["apps", "list", spaceId] as const,
  detail: (id: string) => ["apps", "detail", id] as const,
  logs: (id: string) => ["apps", "logs", id] as const,
};

export type AppLaunch = {
  url: string;
  link?: string;
};

export const appsListQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: appKeys.list(spaceId),
    queryFn: (): Promise<AppWire[]> =>
      client(
        `/api/apps?spaceId=${encodeURIComponent(spaceId)}`,
        "apps",
        { fallback: "Couldn't load apps." },
      ),
    enabled: Boolean(spaceId),
  });

export const appQueryOptions = (id: string) =>
  queryOptions({
    queryKey: appKeys.detail(id),
    queryFn: (): Promise<AppWire> =>
      client(`/api/apps/${encodeURIComponent(id)}`, "app", {
        fallback: "Couldn't open that app.",
      }),
  });

export const appLogsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: appKeys.logs(id),
    queryFn: async (): Promise<{ lines: string[] }> => {
      const response = await client(`/api/apps/${encodeURIComponent(id)}/logs`, {
        fallback: "Couldn't load logs.",
      });
      return (await response.json()) as { lines: string[] };
    },
  });
