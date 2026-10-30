/** The apps a space's Bots built: list, open, read their logs, restart, stop or remove one. */
import { type Command, encode, need } from "../command";
import { show, table } from "../output";

type App = {
  id: string;
  slug: string;
  name: string;
  status: string;
  error: string | null;
  version: number;
};

export const appCommands: Command[] = [
  {
    name: "apps",
    summary: "A space's apps; open, logs, restart, stop or remove one",
    usage: "apps <space> | apps open|logs|restart|stop|remove <app>",
    async run(context) {
      const client = await context.client();
      const [first] = context.args.positional;
      if (!first) throw new Error(`usage: openduet ${this.usage}`);
      switch (first) {
        case "open": {
          const id = need(context, 1, "an app", this.usage);
          const { path } = await client.request<{ path: string }>(
            "POST",
            `/api/apps/${encode(id)}/launch`,
          );
          return show(context.printer, { url: `${client.server}${path}` }, [
            `${client.server}${path}`,
          ]);
        }
        case "logs": {
          const id = need(context, 1, "an app", this.usage);
          const { lines } = await client.request<{ lines: string[] }>(
            "GET",
            `/api/apps/${encode(id)}/logs?lines=200`,
          );
          return show(context.printer, lines, lines);
        }
        case "restart":
        case "stop": {
          const id = need(context, 1, "an app", this.usage);
          const { app: changed } = await client.request<{ app: App }>(
            "POST",
            `/api/apps/${encode(id)}/${first}`,
          );
          return show(context.printer, changed, [
            `${changed.name}: ${changed.status}${changed.error ? ` — ${changed.error}` : ""}`,
          ]);
        }
        case "remove": {
          const id = need(context, 1, "an app", this.usage);
          await client.request("DELETE", `/api/apps/${encode(id)}`);
          return context.printer.out(
            "Removed. Its files stay in the space's computer.",
          );
        }
        default: {
          const { apps } = await client.request<{ apps: App[] }>(
            "GET",
            `/api/apps?spaceId=${encode(first)}`,
          );
          return table(
            context.printer,
            apps,
            ["id", "name", "status", "version", "error"],
            apps,
          );
        }
      }
    },
  },
];
