import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { accessTokenKeys, type AccessTokenWire } from "./queries";

export type CreatedAccessToken = AccessTokenWire & {
  /** Shown once, when the token is made. */
  token: string;
};

export function createAccessTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      expiresInDays?: number | null;
    }): Promise<CreatedAccessToken> => {
      // Create answers as `{ token, accessToken }`: the secret once, and the row as the list shows it.
      const response = await client("/api/access-tokens", {
        method: "POST",
        body: input,
        fallback: "Couldn't make that token.",
      });
      const body = (await response.json()) as {
        token: string;
        accessToken: AccessTokenWire;
      };
      return { ...body.accessToken, token: body.token };
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: accessTokenKeys.all }),
  });
}

export function revokeAccessTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/access-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't revoke that token.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: accessTokenKeys.all }),
  });
}
