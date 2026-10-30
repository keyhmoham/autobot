import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { TeamBotConsentCard } from "@/components/channels/team-bot-consent";
import { usePageChrome } from "@/components/shell/page-chrome";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import { markdownComponents } from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { markRoomChannelReadMutationOptions } from "@/lib/spaces/mutations";
import { roomChannelQueryOptions } from "@/lib/spaces/queries";

/**
 * A room or direct conversation under Spaces.
 *
 * ChannelScreen is for a person's dressed Duet channels with one Bot; shared room and direct
 * channels use the shared transcript (`/api/conversations`), so this page marks the channel read
 * and draws that transcript instead.
 */
export const Route = createFileRoute(
  "/_authed/_app/spaces/channels/$channelId",
)({
  component: SpaceChannelPage,
});

type SharedMessage = {
  id: string;
  channelId: string;
  actorUserId: string;
  agentId: string | null;
  text: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  createdAt: string;
  reason?: string;
  answeredBy?: string;
  consent?: { botId: string; serverId: string };
};

type SharedConversation = {
  bots: { id: string; name: string }[];
  people: {
    userId: string;
    email: string;
    name: string | null;
  }[];
  messages: SharedMessage[];
};

function sharedConversationQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: ["spaces", "conversation", channelId] as const,
    queryFn: async (): Promise<SharedConversation> => {
      const response = await client(
        `/api/conversations/${encodeURIComponent(channelId)}`,
        { fallback: "Couldn't load this conversation." },
      );
      return (await response.json()) as SharedConversation;
    },
    refetchInterval: (query) =>
      query.state.data?.messages.some(
        (message) =>
          message.status === "running" || message.status === "queued",
      )
        ? 1_500
        : false,
  });
}

function SpaceChannelPage() {
  const { channelId } = Route.useParams();
  const queryClient = useQueryClient();
  const channel = useQuery(roomChannelQueryOptions(channelId));
  const markRead = useMutation(markRoomChannelReadMutationOptions(queryClient));
  const marked = useRef<string | null>(null);

  useEffect(() => {
    if (marked.current === channelId) return;
    marked.current = channelId;
    markRead.mutate(channelId);
  }, [channelId, markRead.mutate]);

  usePageChrome({
    title: channel.data?.name ?? "Conversation",
    column: "phone",
    backTo: { to: "/spaces" },
  });

  if (channel.isPending) return null;
  if (channel.error || !channel.data)
    return (
      <p className="type-sub flex flex-1 items-center justify-center px-6 text-duet-red" role="alert">
        {channel.error?.message ?? "Couldn't open this conversation."}
      </p>
    );

  return (
    <>
      <h1 className="sr-only">{channel.data.name}</h1>
      <SharedChannelChat channelId={channelId} key={channelId} />
    </>
  );
}

/** Shared room/direct transcript: people and Bots, polled while a Bot is still answering. */
function SharedChannelChat({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const conversation = useQuery(sharedConversationQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const send = useMutation({
    mutationFn: async (input: {
      id: string;
      text: string;
      agentId: string | null;
    }) => {
      await client(`/api/conversations/${encodeURIComponent(channelId)}`, {
        method: "POST",
        body: input,
        fallback: "Couldn't send that message.",
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["spaces", "conversation", channelId],
      }),
  });

  const bots = conversation.data?.bots ?? [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const people = new Map(
    (conversation.data?.people ?? []).map((person) => [
      person.userId,
      person.name ?? person.email,
    ]),
  );
  const messages = conversation.data?.messages ?? [];
  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastKey = `${messages.length}:${messages.at(-1)?.status ?? ""}`;
  useEffect(() => {
    if (lastKey) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastKey]);

  if (conversation.isPending) return null;
  if (conversation.isError)
    return (
      <p className="type-sub p-8 text-duet-red" role="alert">
        {conversation.error.message}
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[88px] pb-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          {messages.length === 0 ? (
            <p className="type-sub text-duet-ink-2">
              {bots.length
                ? `Say something to ${bots.map((bot) => bot.name).join(" and ")}.`
                : "Say something to start the conversation."}
            </p>
          ) : null}
          {messages.map((message) => (
            <SharedLine
              key={message.id}
              message={message}
              mine={message.actorUserId === me?.id}
              name={
                message.agentId
                  ? (names.get(message.agentId) ?? "A Bot no longer here")
                  : message.actorUserId === me?.id
                    ? "You"
                    : (people.get(message.actorUserId) ?? "A teammate")
              }
              answeredBy={
                message.answeredBy
                  ? (names.get(message.answeredBy) ?? "another Bot")
                  : undefined
              }
            />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-[calc(var(--duet-tab-space,12px)+8px)]">
        {send.error ? (
          <p className="type-sub pb-2 text-duet-red" role="alert">
            {send.error.message}
          </p>
        ) : null}
        <Composer
          agents={toAgentOptions(bots)}
          autoFocus
          className="mt-auto w-full"
          commands={[]}
          compact
          disabled={false}
          pending={send.isPending || working}
          onSubmit={async (draft) => {
            if (!draft.text) return;
            await send.mutateAsync({
              id: newId(),
              text: draft.text,
              agentId: draft.agentId,
            });
          }}
        />
      </div>
    </div>
  );
}

function SharedLine({
  message,
  name,
  answeredBy,
  mine,
}: {
  message: SharedMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
}) {
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="type-caption font-medium text-duet-ink-2">
              {name}
            </MessageHeader>
          )}
          <Bubble align={mine ? "end" : "start"} variant="muted">
            <BubbleContent>
              <span className="whitespace-pre-wrap">{message.text}</span>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </MessageRow>
    );
  return (
    <MessageRow align="start" data-speaker={message.agentId}>
      <div className="shrink-0 pt-0.5">
        <ChannelAvatar participantIds={[message.agentId]} size={24} />
      </div>
      <MessageContent>
        <MessageHeader className="type-caption font-medium text-duet-ink-2">
          {name}
          {answeredBy ? ` · answer from ${answeredBy}` : null}
        </MessageHeader>
        {(message.status === "running" || message.status === "queued") &&
        !message.text ? (
          <p className="tool-line-running type-sub text-duet-ink-2" role="status">
            Thinking
          </p>
        ) : message.status === "waiting" ? (
          <p className="type-sub text-duet-ink-2">
            {message.reason ?? "Waiting for your response."}{" "}
            <Link
              className="underline"
              params={{ agentId: message.agentId }}
              to="/bots/$agentId"
            >
              Open {name}
            </Link>
          </p>
        ) : message.consent ? (
          mine ? (
            <TeamBotConsentCard
              botId={message.consent.botId}
              message={message.text}
              serverId={message.consent.serverId}
            />
          ) : (
            <p className="type-sub text-duet-ink-2">
              Asked a teammate for permission to use their own{" "}
              {message.consent.serverId} account.
            </p>
          )
        ) : message.status === "failed" ? (
          <p className="type-sub text-duet-red" role="alert">
            {message.text || "This Bot couldn't answer."}
          </p>
        ) : (
          <Bubble
            align="start"
            aria-busy={message.status === "running"}
            className="w-full"
            variant="ghost"
          >
            <BubbleContent className="w-full">
              <Streamdown components={markdownComponents}>
                {message.text}
              </Streamdown>
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </MessageRow>
  );
}
