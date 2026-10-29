#!/usr/bin/env bun
/**
 * `openduet`: OpenDuet from a terminal. Everything it does is the deployment's own API, called as the
 * person signed in with an access token (`openduet login`), so it can do exactly what that person can
 * in the app and nothing more.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "./args";
import { CliError, createClient } from "./client";
import { type Command, type Context, UsageError } from "./command";
import { accountCommands } from "./commands/account";
import { adminCommands } from "./commands/admin";
import { appCommands } from "./commands/apps";
import { chatCommands } from "./commands/chat";
import { rawCommands } from "./commands/raw";
import { socialCommands } from "./commands/social";
import { spaceCommands } from "./commands/spaces";
import { walletCommands } from "./commands/wallet";
import { loadConfig } from "./config";

export const COMMANDS: Command[] = [
  ...accountCommands,
  ...spaceCommands,
  ...chatCommands,
  ...appCommands,
  ...walletCommands,
  ...socialCommands,
  ...adminCommands,
  ...rawCommands,
];

export function help(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    "openduet: OpenDuet from a terminal.",
    "",
    "usage: openduet <command> [arguments] [--json]",
    "",
    ...COMMANDS.map(
      (command) => `  ${command.name.padEnd(width)}  ${command.summary}`,
    ),
    "",
    "openduet help <command> says how to use one. OPENDUET_URL and OPENDUET_TOKEN override the signed-in deployment.",
  ].join("\n");
}

/** Run one command line. Returns the exit code, so tests can run it without exiting. */
export async function main(
  argv: string[],
  io: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    out?: (line: string) => void;
    err?: (line: string) => void;
    readLine?: (prompt: string) => Promise<string>;
  } = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const asked = COMMANDS.find((command) => command.name === rest[0]);
    out(asked ? `${asked.summary}\n\nusage: openduet ${asked.usage}` : help());
    return 0;
  }
  const command = COMMANDS.find((each) => each.name === name);
  if (!command) {
    err(`Unknown command: ${name}\n\n${help()}`);
    return 2;
  }
  const args = parseArgs(rest);
  const fetchImpl = io.fetchImpl ?? fetch;
  const context: Context = {
    args,
    env,
    fetchImpl,
    printer: { json: args.flags.json === true, out },
    client: async () => createClient(await loadConfig(env), fetchImpl),
    readLine:
      io.readLine ??
      (async (prompt) => {
        const terminal = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          return (await terminal.question(prompt)).trim();
        } finally {
          terminal.close();
        }
      }),
  };
  try {
    await command.run(context);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      err(error.message);
      return error.exitCode;
    }
    if (error instanceof UsageError) {
      err(error.message);
      return 2;
    }
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
