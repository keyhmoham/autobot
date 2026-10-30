/** The social side: profiles, follows, posts, feeds, explore and notifications. */
import { flag } from "../args";
import { type Command, encode, need } from "../command";
import { show, table } from "../output";

type Post = {
  id: string;
  author: { handle: string; name: string };
  body: string;
  likes: number;
  comments: number;
  createdAt: string;
  space: { name: string } | null;
};

const lines = (posts: Post[]) =>
  posts.flatMap((post) => [
    `${post.createdAt.slice(0, 16).replace("T", " ")}  @${post.author.handle}${post.space ? ` in ${post.space.name}` : ""}  (${post.id})`,
    `  ${post.body.replace(/\n/g, "\n  ")}`,
    `  ♥ ${post.likes}  💬 ${post.comments}`,
  ]);

export const socialCommands: Command[] = [
  {
    name: "feed",
    summary: "Posts from people you follow, everybody, or your spaces",
    usage: "feed [following | everyone | spaces] [--space <space>]",
    async run(context) {
      const client = await context.client();
      const kind = context.args.positional[0] ?? "following";
      const space = flag(context.args, "space");
      const { posts } = await client.request<{ posts: Post[] }>(
        "GET",
        `/api/social/feed?kind=${encode(kind)}${space ? `&spaceId=${encode(space)}` : ""}`,
      );
      show(context.printer, posts, lines(posts));
    },
  },
  {
    name: "post",
    summary: "Post to everybody, or into a space",
    usage: "post <text...> [--space <space>]",
    async run(context) {
      const client = await context.client();
      const body = context.args.positional.join(" ");
      if (!body) throw new Error(`usage: openduet ${this.usage}`);
      const { post } = await client.request<{ post: Post }>(
        "POST",
        "/api/social/posts",
        {
          body,
          ...(flag(context.args, "space")
            ? { spaceId: flag(context.args, "space") }
            : {}),
        },
      );
      show(context.printer, post, [`Posted (${post.id}).`]);
    },
  },
  {
    name: "like",
    summary: "Like a post",
    usage: "like <post>",
    async run(context) {
      const client = await context.client();
      const { post } = await client.request<{ post: Post }>(
        "POST",
        `/api/social/posts/${encode(need(context, 0, "a post", this.usage))}/like`,
      );
      show(context.printer, post, [`♥ ${post.likes}`]);
    },
  },
  {
    name: "comment",
    summary: "Comment on a post",
    usage: "comment <post> <text...>",
    async run(context) {
      const client = await context.client();
      const post = need(context, 0, "a post", this.usage);
      const body = context.args.positional.slice(1).join(" ");
      if (!body) throw new Error(`usage: openduet ${this.usage}`);
      const answer = await client.request(
        "POST",
        `/api/social/posts/${encode(post)}/comments`,
        { body },
      );
      show(context.printer, answer, ["Commented."]);
    },
  },
  {
    name: "profile",
    summary: "Your profile or somebody else's; change yours",
    usage:
      "profile [@handle] | profile set [--handle h] [--bio text] [--directs everyone|following|nobody]",
    async run(context) {
      const client = await context.client();
      const [first] = context.args.positional;
      type Profile = {
        handle: string;
        name: string;
        bio: string;
        followers: number;
        following: number;
        posts: number;
        isFollowing: boolean;
        followsYou: boolean;
        directs: string;
      };
      const { profile } =
        first === "set"
          ? await client.request<{ profile: Profile }>(
              "PATCH",
              "/api/social/me",
              {
                ...(flag(context.args, "handle")
                  ? { handle: flag(context.args, "handle") }
                  : {}),
                ...(flag(context.args, "bio") !== undefined
                  ? { bio: flag(context.args, "bio") }
                  : {}),
                ...(flag(context.args, "directs")
                  ? { directs: flag(context.args, "directs") }
                  : {}),
              },
            )
          : await client.request<{ profile: Profile }>(
              "GET",
              first
                ? `/api/social/people/${encode(first.replace(/^@/, ""))}`
                : "/api/social/me",
            );
      show(context.printer, profile, [
        `${profile.name} @${profile.handle}${profile.followsYou ? "  (follows you)" : ""}`,
        ...(profile.bio ? [profile.bio] : []),
        `${profile.posts} posts · ${profile.followers} followers · ${profile.following} following · directs from ${profile.directs}`,
      ]);
    },
  },
  {
    name: "follow",
    summary: "Follow somebody",
    usage: "follow <@handle>",
    async run(context) {
      const client = await context.client();
      const handle = need(context, 0, "a handle", this.usage).replace(/^@/, "");
      await client.request(
        "POST",
        `/api/social/people/${encode(handle)}/follow`,
      );
      context.printer.out(`Following @${handle}.`);
    },
  },
  {
    name: "unfollow",
    summary: "Stop following somebody",
    usage: "unfollow <@handle>",
    async run(context) {
      const client = await context.client();
      const handle = need(context, 0, "a handle", this.usage).replace(/^@/, "");
      await client.request(
        "DELETE",
        `/api/social/people/${encode(handle)}/follow`,
      );
      context.printer.out(`No longer following @${handle}.`);
    },
  },
  {
    name: "explore",
    summary: "Find people, posts, #tags and public spaces",
    usage: "explore [query]",
    async run(context) {
      const client = await context.client();
      const found = await client.request<{
        people: { handle: string; name: string }[];
        posts: Post[];
        spaces: { id: string; name: string }[];
        tags: { tag: string; posts: number }[];
      }>(
        "GET",
        `/api/social/explore?q=${encode(context.args.positional.join(" "))}`,
      );
      show(context.printer, found, [
        `People: ${found.people.map((person) => `@${person.handle}`).join(", ") || "(none)"}`,
        `Spaces: ${found.spaces.map((space) => `${space.name} (${space.id})`).join(", ") || "(none)"}`,
        `Tags: ${found.tags.map((tag) => `#${tag.tag} (${tag.posts})`).join(", ") || "(none)"}`,
        "",
        ...lines(found.posts.slice(0, 10)),
      ]);
    },
  },
  {
    name: "notifications",
    summary: "What happened to your posts and who followed you; mark them read",
    usage: "notifications [read]",
    async run(context) {
      const client = await context.client();
      if (context.args.positional[0] === "read") {
        await client.request("POST", "/api/social/notifications/read");
        return context.printer.out("Marked read.");
      }
      const inbox = await client.request<{
        notifications: {
          kind: string;
          actor: { handle: string };
          excerpt: string | null;
          readAt: string | null;
          createdAt: string;
        }[];
        unread: number;
      }>("GET", "/api/social/notifications");
      if (!context.printer.json) context.printer.out(`${inbox.unread} unread`);
      table(
        context.printer,
        inbox.notifications.map((note) => ({
          when: note.createdAt.slice(0, 16).replace("T", " "),
          who: `@${note.actor.handle}`,
          what: note.kind,
          about: note.excerpt ?? "",
          new: note.readAt ? "" : "•",
        })),
        ["new", "when", "who", "what", "about"],
        inbox,
      );
    },
  },
];
