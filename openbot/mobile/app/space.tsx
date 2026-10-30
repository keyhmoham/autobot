import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";
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

type SpaceDetail = {
  id: string;
  name: string;
  description: string;
  rooms: Room[];
};

/** One space: its rooms and channels, plus a link to its apps. */
export default function SpaceScreen() {
  const { spaceId } = useLocalSearchParams<{ spaceId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(
    () =>
      api<{ space: SpaceDetail }>(
        `/api/spaces/${encodeURIComponent(spaceId ?? "")}`,
      ),
    [spaceId],
  );
  const space = useLoad(load, Boolean(session && spaceId));
  if (!session && !isPending) return <Redirect href="/" />;
  const detail = space.data?.space;
  return (
    <Screen refreshing={space.pending} onRefresh={() => void space.refresh()}>
      <Text style={heading}>{detail?.name ?? "Space"}</Text>
      {detail?.description ? <Text style={muted}>{detail.description}</Text> : null}
      <Problem message={space.error} />
      {spaceId ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open apps"
          onPress={() =>
            router.push({ pathname: "/apps", params: { spaceId } })
          }
          style={card}
        >
          <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
            Apps
          </Text>
          <Text style={muted}>Open a web app this space runs</Text>
        </Pressable>
      ) : null}
      {detail?.rooms.map((room) => (
        <Section key={room.id} title={room.name}>
          {room.topic ? <Text style={muted}>{room.topic}</Text> : null}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open ${room.name} desk`}
            onPress={() =>
              router.push({
                pathname: "/room",
                params: { spaceId: detail.id, roomId: room.id },
              })
            }
            style={card}
          >
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.link }}>
              Room and desk
            </Text>
            <Text style={muted}>
              {room.channels.length}{" "}
              {room.channels.length === 1 ? "conversation" : "conversations"}
            </Text>
          </Pressable>
          {room.channels.map((channel) => (
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
              <Text
                style={{ fontSize: 16, fontWeight: "600", color: colors.link }}
              >
                {channel.name}
                {channel.unread ? " · unread" : ""}
              </Text>
              {channel.purpose ? (
                <Text style={muted}>{channel.purpose}</Text>
              ) : null}
            </Pressable>
          ))}
          {room.channels.length === 0 ? (
            <Text style={muted}>No channels in this room.</Text>
          ) : null}
        </Section>
      ))}
      {detail && detail.rooms.length === 0 ? (
        <Text>No rooms in this space yet.</Text>
      ) : null}
    </Screen>
  );
}
