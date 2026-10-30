/**
 * Personal access tokens for the CLI and other clients that cannot hold a browser session.
 */
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type AccessTokenWire = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export const accessTokenKeys = {
  all: ["access-tokens"] as const,
  list: () => ["access-tokens", "list"] as const,
};

export const accessTokensQueryOptions = () =>
  queryOptions({
    queryKey: accessTokenKeys.list(),
    queryFn: (): Promise<AccessTokenWire[]> =>
      client("/api/access-tokens", "tokens", {
        fallback: "Couldn't load your access tokens.",
      }),
  });
