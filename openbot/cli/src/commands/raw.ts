/** Anything the API answers that no command covers yet. */
import type { Command } from "../command";

export const rawCommands: Command[] = [
  {
    name: "call",
    summary: "Call any API route as yourself",
    usage: "call <METHOD> </api/path> [json-body]",
    async run(context) {
      const [method, path, body] = context.args.positional;
      if (!method || !path?.startsWith("/"))
        throw new Error(`usage: openduet ${this.usage}`);
      const client = await context.client();
      const answer = await client.request(
        method.toUpperCase(),
        path,
        body === undefined ? undefined : JSON.parse(body),
      );
      context.printer.out(
        typeof answer === "string" ? answer : JSON.stringify(answer, null, 2),
      );
    },
  },
];
