import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  colors,
  heading,
  muted,
  Problem,
  Screen,
  Section,
} from "../src/ui";
import { useLoad } from "../src/use-load";

type Channel = {
  id: string;
  name: string;
  purpose: string | null;
  unread: boolean;
};

type Room = {
  id: string;
  name: string;
  topic: string;
  channels: Channel[];
};

type DeskWindow = {
  id: string;
  title: string;
  target: { kind: string };
};

type DeskPin = {
  id: string;
  title: string;
  target: { kind: string };
};

/** A room: its conversations and the desk gadgets people and Bots put on it. */
export default function RoomScreen() {
  const { spaceId, roomId } = useLocalSearchParams<{
    spaceId: string;
    roomId: string;
  }>();
  const { data: session, isPending } = authClient.useSession();
  const spaceLoad = useCallback(
    () =>
      api<{ space: { name: string; rooms: Room[] } }>(
        `/api/spaces/${encodeURIComponent(spaceId ?? "")}`,
      ),
    [spaceId],
  );
  const deskLoad = useCallback(
    () =>
      api<{ desk: { windows: DeskWindow[]; pins: DeskPin[] } }>(
        `/api/rooms/${encodeURIComponent(roomId ?? "")}/desk`,
      ),
    [roomId],
  );
  const space = useLoad(spaceLoad, Boolean(session && spaceId));
  const desk = useLoad(deskLoad, Boolean(session && roomId));
  if (!session && !isPending) return <Redirect href="/" />;

  const room = space.data?.space.rooms.find((candidate) => candidate.id === roomId);

  return (
    <Screen
      refreshing={space.pending || desk.pending}
      onRefresh={() => {
        void space.refresh();
        void desk.refresh();
      }}
    >
      <Text style={heading}>{room?.name ?? "Room"}</Text>
      {room?.topic ? <Text style={muted}>{room.topic}</Text> : null}
      <Problem message={space.error || desk.error} />

      <Section title="Conversations">
        {room?.channels.map((channel) => (
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
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.link }}>
              {channel.name}
              {channel.unread ? " · unread" : ""}
            </Text>
            {channel.purpose ? <Text style={muted}>{channel.purpose}</Text> : null}
          </Pressable>
        ))}
        {room && room.channels.length === 0 ? (
          <Text style={muted}>No conversations in this room.</Text>
        ) : null}
      </Section>

      <Section title="Desk">
        {desk.data?.desk.windows.map((window) => (
          <View key={window.id} style={card}>
            <Text style={{ fontWeight: "600" }}>{window.title}</Text>
            <Text style={muted}>{window.target.kind}</Text>
          </View>
        ))}
        {desk.data?.desk.pins.map((pin) => (
          <View key={pin.id} style={card}>
            <Text style={{ fontWeight: "600" }}>Pinned · {pin.title}</Text>
            <Text style={muted}>{pin.target.kind}</Text>
          </View>
        ))}
        {desk.data &&
        desk.data.desk.windows.length === 0 &&
        desk.data.desk.pins.length === 0 ? (
          <Text style={muted}>Nothing on this desk yet.</Text>
        ) : null}
      </Section>
    </Screen>
  );
}
