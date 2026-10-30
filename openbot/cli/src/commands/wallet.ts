/** Your wallet: balance, what moved, and sending credits, here or to somebody on another node. */
import { flag } from "../args";
import { type Command, need } from "../command";
import { credits, show, table } from "../output";

type Entry = {
  seq: number;
  type: string;
  category: string | null;
  amount: number;
  description: string;
  counterparty: string | null;
  createdAt: string;
};

export const walletCommands: Command[] = [
  {
    name: "wallet",
    summary: "Your balance and what moved; send credits",
    usage:
      "wallet [show | send <email> <credits> [--note <text>] [--node <node-id>]]",
    async run(context) {
      const client = await context.client();
      const [sub = "show"] = context.args.positional;
      if (sub === "send") {
        const to = need(context, 1, "who to send to", this.usage);
        const amount = Number(need(context, 2, "how many credits", this.usage));
        const answer = await client.request<{
          wallet: { balance: number };
          transfer?: { status: string };
        }>("POST", "/api/wallet/transfers", {
          to,
          amount,
          ...(flag(context.args, "note")
            ? { note: flag(context.args, "note") }
            : {}),
          ...(flag(context.args, "node")
            ? { node: flag(context.args, "node") }
            : {}),
        });
        return show(context.printer, answer, [
          answer.transfer
            ? `Sent to ${to} on another node: ${answer.transfer.status}. You have ${credits(answer.wallet.balance)}.`
            : `Sent ${credits(amount)} to ${to}. You have ${credits(answer.wallet.balance)}.`,
        ]);
      }
      const { wallet, entries, billing } = await client.request<{
        wallet: { balance: number };
        entries: Entry[];
        billing: boolean;
      }>("GET", "/api/wallet");
      if (!context.printer.json)
        context.printer.out(
          `Balance: ${credits(wallet.balance)}${billing ? "" : " (billing is off on this deployment)"}`,
        );
      table(
        context.printer,
        entries.map((entry) => ({
          when: entry.createdAt.slice(0, 16).replace("T", " "),
          amount: credits(entry.amount),
          what: entry.counterparty
            ? `${entry.description} (${entry.counterparty})`
            : entry.description,
        })),
        ["when", "amount", "what"],
        { wallet, entries, billing },
      );
    },
  },
];
