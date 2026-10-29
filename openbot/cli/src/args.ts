/** `openduet <command> <sub> positional... --flag value --switch`, read without a library. */
export type Args = {
  positional: string[];
  flags: Record<string, string | true>;
};

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [
        string,
        string | undefined,
      ];
      const next = argv[index + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        index++;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

export function flag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}
