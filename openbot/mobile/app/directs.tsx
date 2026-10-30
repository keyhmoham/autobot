import { Redirect, router } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import { card, colors, heading, muted, Problem, Screen } from "../src/ui";
import { useLoad } from "../src/use-load";

type Direct = {
  id: string;
  name: string;
  lastMessage: string | null;
  unread: boolean;
};

/** Private one-to-one conversations. */
export default function DirectsScreen() {
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(
    () => api<{ directs: Direct[] }>("/api/directs"),
    [],
  );
  const directs = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  return (
    <Screen
      refreshing={directs.pending}
      onRefresh={() => void directs.refresh()}
    >
      <Text style={heading}>Messages</Text>
      <Problem message={directs.error} />
      {directs.data?.directs.map((channel) => (
        <Pressable
          key={channel.id}
          accessibilityRole="link"
          accessibilityLabel={`Open ${channel.name}`}
          onPress={() =>
            router.push({
              pathname: "/channel",
              params: { channelId: channel.id },
            })
          }
          style={card}
        >
          <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
            {channel.name}
            {channel.unread ? " · unread" : ""}
          </Text>
          {channel.lastMessage ? (
            <Text style={muted}>{channel.lastMessage}</Text>
          ) : null}
        </Pressable>
      ))}
      {directs.data?.directs.length === 0 ? (
        <Text>No direct messages yet.</Text>
      ) : null}
    </Screen>
  );
}
