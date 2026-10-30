/** Talking in channels: send, read, and direct conversations (which are channels too). */
import { flag } from "../args";
import { type Command, encode, need } from "../command";
import { show, table } from "../output";

type Transcript = {
  bots: { id: string; name: string }[];
  people: { userId?: string; id?: string; name: string | null }[];
  messages: {
    id: string;
    actorUserId: string;
    agentId: string | null;
    text: string;
    status: string;
    createdAt: string;
  }[];
};

export const chatCommands: Command[] = [
  {
    name: "send",
    summary: "Say something in a room's channel or a direct conversation",
    usage: "send <channel> <text...> [--bot <bot-id>] [--people-only]",
    async run(context) {
      const client = await context.client();
      const channel = need(context, 0, "a channel", this.usage);
      const text = context.args.positional.slice(1).join(" ");
      if (!text) throw new Error(`usage: openduet ${this.usage}`);
      const answer = await client.request(
        "POST",
        `/api/conversations/${encode(channel)}`,
        {
          id: `cli-${crypto.randomUUID()}`,
          text,
          ...(flag(context.args, "bot")
            ? { agentId: flag(context.args, "bot") }
            : {}),
          ...(context.args.flags["people-only"] ? { peopleOnly: true } : {}),
        },
      );
      show(context.printer, answer, [
        "Sent. Bots answer in the channel; read it with `openduet messages`.",
      ]);
    },
  },
  {
    name: "messages",
    summary: "Read a channel's conversation",
    usage: "messages <channel> [--last <n>]",
    async run(context) {
      const client = await context.client();
      const channel = need(context, 0, "a channel", this.usage);
      const transcript = await client.request<Transcript>(
        "GET",
        `/api/conversations/${encode(channel)}`,
      );
      const names = new Map<string, string>([
        ...transcript.bots.map((bot) => [bot.id, bot.name] as const),
        ...transcript.people.map(
          (person) =>
            [
              person.userId ?? person.id ?? "",
              person.name ?? "Somebody",
            ] as const,
        ),
      ]);
      const last = Number(flag(context.args, "last") ?? 30);
      const messages = transcript.messages.slice(-last);
      show(
        context.printer,
        transcript,
        messages.map((message) => {
          const who =
            names.get(message.agentId ?? message.actorUserId) ?? "Somebody";
          const state =
            message.status === "completed" ? "" : ` [${message.status}]`;
          return `${message.createdAt.slice(11, 16)}  ${who}${state}: ${message.text}`;
        }),
      );
    },
  },
  {
    name: "directs",
    summary: "Your direct conversations; open one with somebody",
    usage: "directs [list | open <user-id>]",
    async run(context) {
      const client = await context.client();
      const [sub = "list"] = context.args.positional;
      if (sub === "open") {
        const userId = need(context, 1, "a person's id", this.usage);
        const { channel } = await client.request<{ channel: { id: string } }>(
          "POST",
          "/api/directs",
          { userId },
        );
        return show(context.printer, channel, [
          `Opened ${channel.id}. Send with \`openduet send ${channel.id} ...\`.`,
        ]);
      }
      const { directs } = await client.request<{
        directs: {
          channelId: string;
          with: { name: string | null; email: string };
          lastMessage: string | null;
          unread: boolean;
        }[];
      }>("GET", "/api/directs");
      table(
        context.printer,
        directs.map((direct) => ({
          channel: direct.channelId,
          with: direct.with.name ?? direct.with.email,
          lastMessage: direct.lastMessage,
          unread: direct.unread,
        })),
        ["channel", "with", "lastMessage", "unread"],
        directs,
      );
    },
  },
];
