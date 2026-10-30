import { Redirect, router } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import { card, colors, heading, muted, Problem, Screen } from "../src/ui";
import { useLoad } from "../src/use-load";

type Space = {
  id: string;
  name: string;
  description: string;
  memberCount: number;
};

/** Spaces this person belongs to. */
export default function SpacesScreen() {
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(
    () => api<{ spaces: Space[] }>("/api/spaces"),
    [],
  );
  const spaces = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  return (
    <Screen refreshing={spaces.pending} onRefresh={() => void spaces.refresh()}>
      <Text style={heading}>Spaces</Text>
      <Problem message={spaces.error} />
      {spaces.data?.spaces.map((space) => (
        <Pressable
          key={space.id}
          accessibilityRole="link"
          accessibilityLabel={`Open ${space.name}`}
          onPress={() =>
            router.push({ pathname: "/space", params: { spaceId: space.id } })
          }
          style={card}
        >
          <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
            {space.name}
          </Text>
          {space.description ? (
            <Text style={muted}>{space.description}</Text>
          ) : null}
          <Text style={muted}>
            {space.memberCount}{" "}
            {space.memberCount === 1 ? "member" : "members"}
          </Text>
        </Pressable>
      ))}
      {spaces.data?.spaces.length === 0 && (
        <Text>No spaces yet. Join or create one in OpenDuet on your computer.</Text>
      )}
    </Screen>
  );
}
