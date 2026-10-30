/** Signing in and out, who you are, and your access tokens. */

import { flag } from "../args";
import { createClient } from "../client";
import { type Command, encode, need } from "../command";
import { forgetConfig, saveConfig } from "../config";
import { show, table } from "../output";

type Me = {
  user: { id: string; email: string; name?: string | null; role: string };
};

export const accountCommands: Command[] = [
  {
    name: "login",
    summary: "Sign in to a deployment with an access token",
    usage: "login <server-url> [--token <token>]",
    async run(context) {
      const server = need(
        context,
        0,
        "the server's address",
        this.usage,
      ).replace(/\/+$/, "");
      const token =
        flag(context.args, "token") ??
        context.env.OPENDUET_TOKEN?.trim() ??
        (await context.readLine(
          `Make an access token in OpenDuet (Settings → Access tokens) and paste it here: `,
        ));
      if (!token) throw new Error("No token was given.");
      const client = createClient({ server, token }, context.fetchImpl);
      const { user } = await client.request<Me>("GET", "/api/me");
      await saveConfig({ server, token }, context.env);
      show(context.printer, user, [
        `Signed in to ${server} as ${user.name ?? user.email} (${user.role}).`,
      ]);
    },
  },
  {
    name: "logout",
    summary: "Forget the deployment and token this computer holds",
    usage: "logout",
    async run(context) {
      await forgetConfig(context.env);
      context.printer.out(
        "Signed out. The token itself still works until you revoke it in OpenDuet.",
      );
    },
  },
  {
    name: "whoami",
    summary: "Who the CLI is signed in as, and where",
    usage: "whoami",
    async run(context) {
      const client = await context.client();
      const { user } = await client.request<Me>("GET", "/api/me");
      show(context.printer, user, [
        `${user.name ?? user.email} <${user.email}> (${user.role}) on ${client.server}`,
      ]);
    },
  },
  {
    name: "tokens",
    summary: "List or revoke your access tokens",
    usage: "tokens [list | revoke <id>]",
    async run(context) {
      const client = await context.client();
      const [sub, id] = context.args.positional;
      if (sub === "revoke") {
        if (!id) throw new Error(`usage: openduet ${this.usage}`);
        await client.request("DELETE", `/api/access-tokens/${encode(id)}`);
        return context.printer.out(`Revoked ${id}.`);
      }
      const { tokens } = await client.request<{
        tokens: Record<string, unknown>[];
      }>("GET", "/api/access-tokens");
      table(
        context.printer,
        tokens,
        ["id", "name", "lastUsedAt", "expiresAt", "createdAt"],
        tokens,
      );
    },
  },
];
