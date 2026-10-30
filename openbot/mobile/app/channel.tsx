import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import { card, colors, heading, muted, Problem, Screen } from "../src/ui";
import { useLoad } from "../src/use-load";

type Channel = {
  id: string;
  name: string;
  purpose: string | null;
  agentIds: string[];
};

/**
 * A room or direct channel: its summary, then open the shared conversation the same way other
 * chats do.
 */
export default function ChannelScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(
    () =>
      api<{ channel: Channel }>(
        `/api/room-channels/${encodeURIComponent(channelId ?? "")}`,
      ),
    [channelId],
  );
  const channel = useLoad(load, Boolean(session && channelId));
  if (!session && !isPending) return <Redirect href="/" />;
  const row = channel.data?.channel;
  return (
    <Screen
      refreshing={channel.pending}
      onRefresh={() => void channel.refresh()}
    >
      <Text style={heading}>{row?.name ?? "Channel"}</Text>
      {row?.purpose ? <Text style={muted}>{row.purpose}</Text> : null}
      <Problem message={channel.error} />
      {channelId ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open conversation"
          onPress={() =>
            router.push({
              pathname: "/conversation",
              params: { channelId },
            })
          }
          style={card}
        >
          <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
            Open conversation
          </Text>
          <Text style={muted}>Read and reply in this channel</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
