/**
 * This deployment's place in a federation of nodes, and Admin → Federation.
 */
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type FederationNode = {
  id: string;
  name: string;
  status: string;
  url?: string;
  lastSeenAt?: string | null;
};

export type FederationSelf = {
  id: string;
  name: string;
  isCentral: boolean;
  url?: string;
};

export type JoinCode = {
  id: string;
  /** Present only when the code was just made; the list never returns the secret. */
  code?: string;
  label?: string;
  expiresAt: string | null;
  createdAt: string;
};

export type FederationAdmin = {
  self: FederationSelf;
  nodes: FederationNode[];
  joinCodes: JoinCode[];
  ledgers: unknown[];
};

export const federationKeys = {
  all: ["federation"] as const,
  nodes: () => ["federation", "nodes"] as const,
  admin: () => ["federation", "admin"] as const,
};

export const federationNodesQueryOptions = () =>
  queryOptions({
    queryKey: federationKeys.nodes(),
    queryFn: async (): Promise<{
      self: string;
      nodes: FederationNode[];
    }> => {
      const response = await client("/api/federation/nodes", {
        fallback: "Couldn't load federation nodes.",
      });
      return (await response.json()) as {
        self: string;
        nodes: FederationNode[];
      };
    },
  });

export const federationAdminQueryOptions = () =>
  queryOptions({
    queryKey: federationKeys.admin(),
    queryFn: async (): Promise<FederationAdmin> => {
      const response = await client("/api/admin/federation", {
        fallback: "Couldn't load federation settings.",
      });
      return (await response.json()) as FederationAdmin;
    },
  });
