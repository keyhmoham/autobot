/**
 * The deployment's API, as the CLI calls it: JSON in and out, the token as a bearer, and a refusal
 * turned into the sentence the server said rather than a status code.
 */
import type { CliConfig } from "./config";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type Client = {
  server: string;
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T>;
};

export function createClient(
  config: Partial<CliConfig>,
  fetchImpl: typeof fetch = fetch,
): Client {
  const { server, token } = config;
  if (!server || !token)
    throw new CliError(
      "Not signed in. Run `openduet login <server-url>` first.",
      2,
    );
  const base = server.replace(/\/+$/, "");
  return {
    server: base,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new CliError(
          `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        const said = (parsed as { error?: unknown } | null)?.error;
        throw new CliError(
          typeof said === "string"
            ? said
            : `The server answered ${response.status}.`,
        );
      }
      return parsed as T;
    },
  };
}
