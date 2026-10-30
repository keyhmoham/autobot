/** What a command is handed, and what it is. */
import type { Args } from "./args";
import type { Client } from "./client";
import type { Printer } from "./output";

export type Context = {
  args: Args;
  printer: Printer;
  /** The signed-in client. Throws a "not signed in" error for commands that need one. */
  client: () => Promise<Client>;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  /** One line from the terminal, for a token pasted rather than passed on the command line. */
  readLine: (prompt: string) => Promise<string>;
};

export type Command = {
  name: string;
  summary: string;
  usage: string;
  run: (context: Context) => Promise<void>;
};

/** The positional argument at `index`, or a usage error naming what is missing. */
export function need(
  context: Context,
  index: number,
  what: string,
  usage: string,
): string {
  const value = context.args.positional[index];
  if (!value)
    throw new UsageError(`Missing ${what}.\nusage: openduet ${usage}`);
  return value;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const encode = encodeURIComponent;
