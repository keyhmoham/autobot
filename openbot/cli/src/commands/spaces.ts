/** Spaces, their rooms and channels, members, invitations and budgets. */
import { flag } from "../args";
import { type Command, encode, need } from "../command";
import { credits, show, table } from "../output";

type Channel = {
  id: string;
  name: string;
  kind: string;
  unread: boolean;
  lastMessageAt: string | null;
};
type Room = { id: string; name: string; topic: string; channels: Channel[] };
type Space = {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  memberCount: number;
  visibility: string;
};

export const spaceCommands: Command[] = [
  {
    name: "spaces",
    summary: "Your spaces; create, show, discover or join one",
    usage:
      "spaces [list | create <name> | show <space> | discover [query] | join <space>]",
    async run(context) {
      const client = await context.client();
      const [sub = "list", arg] = context.args.positional;
      switch (sub) {
        case "create": {
          const name = context.args.positional.slice(1).join(" ");
          if (!name) throw new Error(`usage: openduet ${this.usage}`);
          const { space } = await client.request<{ space: Space }>(
            "POST",
            "/api/spaces",
            { name },
          );
          return show(context.printer, space, [
            `Made ${space.name} (${space.id}).`,
          ]);
        }
        case "show": {
          const id = need(context, 1, "a space", this.usage);
          const { space } = await client.request<{
            space: Space & { rooms: Room[] };
          }>("GET", `/api/spaces/${encode(id)}`);
          return show(context.printer, space, [
            `${space.name}  (${space.kind}, ${space.visibility}, ${space.memberCount} member(s), you: ${space.role ?? "not a member"})`,
            ...space.rooms.flatMap((room) => [
              `  ${room.name}  ${room.id}${room.topic ? `  — ${room.topic}` : ""}`,
              ...room.channels.map(
                (channel) =>
                  `    #${channel.name}  ${channel.id}${channel.unread ? "  (unread)" : ""}`,
              ),
            ]),
          ]);
        }
        case "discover": {
          const { spaces } = await client.request<{ spaces: Space[] }>(
            "GET",
            `/api/spaces/discover?q=${encode(context.args.positional.slice(1).join(" "))}`,
          );
          return table(
            context.printer,
            spaces,
            ["id", "name", "memberCount"],
            spaces,
          );
        }
        case "join": {
          const id = need(context, 1, "a space", this.usage);
          const { space } = await client.request<{ space: Space }>(
            "POST",
            `/api/spaces/${encode(id)}/join`,
          );
          return show(context.printer, space, [`Joined ${space.name}.`]);
        }
        case "list": {
          const { spaces } = await client.request<{ spaces: Space[] }>(
            "GET",
            "/api/spaces",
          );
          return table(
            context.printer,
            spaces,
            ["id", "name", "kind", "role", "memberCount"],
            spaces,
          );
        }
        default:
          throw new Error(
            `Unknown: spaces ${sub}${arg ? ` ${arg}` : ""}.\nusage: openduet ${this.usage}`,
          );
      }
    },
  },
  {
    name: "rooms",
    summary: "Make a room in a space, or a channel in a room",
    usage:
      "rooms create <space> <name> | rooms channel <room> <name> [--bots id,id]",
    async run(context) {
      const client = await context.client();
      const [sub] = context.args.positional;
      const target = need(
        context,
        1,
        sub === "channel" ? "a room" : "a space",
        this.usage,
      );
      const name = context.args.positional.slice(2).join(" ");
      if (!name) throw new Error(`usage: openduet ${this.usage}`);
      if (sub === "create") {
        const answer = await client.request<{ roomId: string }>(
          "POST",
          `/api/spaces/${encode(target)}/rooms`,
          { name },
        );
        return show(context.printer, answer, [
          `Made room ${name} (${answer.roomId}).`,
        ]);
      }
      if (sub === "channel") {
        const agentIds =
          flag(context.args, "bots")?.split(",").filter(Boolean) ?? [];
        const answer = await client.request<{ channel: Channel }>(
          "POST",
          `/api/rooms/${encode(target)}/channels`,
          {
            name,
            agentIds,
          },
        );
        return show(context.printer, answer, [
          `Opened #${answer.channel.name} (${answer.channel.id}).`,
        ]);
      }
      throw new Error(`usage: openduet ${this.usage}`);
    },
  },
  {
    name: "members",
    summary: "Who is in a space",
    usage: "members <space>",
    async run(context) {
      const client = await context.client();
      const id = need(context, 0, "a space", this.usage);
      const { members } = await client.request<{
        members: Record<string, unknown>[];
      }>("GET", `/api/spaces/${encode(id)}/members`);
      table(
        context.printer,
        members,
        ["userId", "name", "email", "role"],
        members,
      );
    },
  },
  {
    name: "invite",
    summary: "Invite somebody to a space by email",
    usage: "invite <space> <email> [--role member|admin|guest]",
    async run(context) {
      const client = await context.client();
      const space = need(context, 0, "a space", this.usage);
      const email = need(context, 1, "an email address", this.usage);
      const answer = await client.request<{ token?: string }>(
        "POST",
        `/api/spaces/${encode(space)}/invitations`,
        {
          email,
          role: flag(context.args, "role") ?? "member",
        },
      );
      show(context.printer, answer, [`Invited ${email}.`]);
    },
  },
  {
    name: "invitations",
    summary: "Invitations waiting for you; accept or decline one",
    usage: "invitations [list | accept <id> | decline <id>]",
    async run(context) {
      const client = await context.client();
      const [sub = "list", id] = context.args.positional;
      if (sub === "accept" && id) {
        const answer = await client.request("POST", "/api/invitations/accept", {
          id,
        });
        return show(context.printer, answer, ["Accepted."]);
      }
      if (sub === "decline" && id) {
        await client.request("POST", `/api/invitations/${encode(id)}/decline`);
        return context.printer.out("Declined.");
      }
      const { invitations } = await client.request<{
        invitations: Record<string, unknown>[];
      }>("GET", "/api/invitations");
      table(
        context.printer,
        invitations,
        ["id", "spaceName", "role", "invitedBy", "expiresAt"],
        invitations,
      );
    },
  },
  {
    name: "budget",
    summary: "A space's budget: what it may spend and has",
    usage: "budget <space> [cap-in-credits]",
    async run(context) {
      const client = await context.client();
      const space = need(context, 0, "a space", this.usage);
      const cap = context.args.positional[1];
      const { budget } = cap
        ? await client.request<{ budget: { cap: number; spent: number } }>(
            "PUT",
            `/api/budgets/${encode(space)}`,
            {
              cap: Number(cap),
            },
          )
        : await client.request<{ budget: { cap: number; spent: number } }>(
            "GET",
            `/api/budgets/${encode(space)}`,
          );
      show(context.printer, budget, [
        `Spent ${credits(budget.spent)}${budget.cap ? ` of ${credits(budget.cap)}` : " (no limit)"}.`,
      ]);
    },
  },
  {
    name: "timeline",
    summary: "What happened in a space, newest first",
    usage:
      "timeline <space> [--about <name>] [--from <date>] [--to <date>] [--as-of <date>]",
    async run(context) {
      const client = await context.client();
      const space = need(context, 0, "a space", this.usage);
      const query = new URLSearchParams();
      for (const [option, key] of [
        ["about", "about"],
        ["from", "from"],
        ["to", "to"],
        ["as-of", "asOf"],
      ] as const) {
        const value = flag(context.args, option);
        if (value) query.set(key, value);
      }
      const { events } = await client.request<{
        events: {
          at: string;
          subject: { name: string };
          phrase: string;
          object: { name: string } | null;
          value: string | null;
        }[];
      }>("GET", `/api/timeline/${encode(space)}?${query}`);
      show(
        context.printer,
        events,
        events.map(
          (event) =>
            `${event.at.slice(0, 16).replace("T", " ")}  ${event.subject.name} ${event.phrase}${event.object ? ` ${event.object.name}` : ""}${event.value ? `: ${event.value}` : ""}`,
        ),
      );
    },
  },
];
