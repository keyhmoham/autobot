import * as WebBrowser from "expo-web-browser";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Button, Linking, Pressable, Text, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  colors,
  heading,
  muted,
  Problem,
  Screen,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

type AppRow = {
  id: string;
  name: string;
  description: string;
  status: string;
};

/**
 * Apps in a space. Launch opens the URL in the system browser (no WebView dependency).
 */
export default function AppsScreen() {
  const { spaceId, appId } = useLocalSearchParams<{
    spaceId?: string;
    appId?: string;
  }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const load = useCallback(() => {
    if (!spaceId) return Promise.resolve({ apps: [] as AppRow[] });
    return api<{ apps: AppRow[] }>(
      `/api/apps?spaceId=${encodeURIComponent(spaceId)}`,
    );
  }, [spaceId]);
  const apps = useLoad(load, Boolean(session && spaceId));
  if (!session && !isPending) return <Redirect href="/" />;

  async function launch(id: string) {
    const result = await api<{ url?: string; link?: string }>(
      `/api/apps/${encodeURIComponent(id)}/launch`,
      { method: "POST" },
    );
    const url = result.url || result.link;
    if (!url) throw new Error("That app did not return an address to open.");
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      await Linking.openURL(url);
    }
  }

  return (
    <Screen refreshing={apps.pending} onRefresh={() => void apps.refresh()}>
      <Text style={heading}>Apps</Text>
      <Problem message={apps.error || action.error} />
      {!spaceId ? (
        <Text>Open apps from a space.</Text>
      ) : (
        <>
          {apps.data?.apps.map((app) => (
            <View key={app.id} style={card}>
              <Text style={{ fontSize: 17, fontWeight: "600" }}>{app.name}</Text>
              {app.description ? (
                <Text style={muted}>{app.description}</Text>
              ) : null}
              <Text style={muted}>{app.status}</Text>
              <Button
                disabled={Boolean(action.busy)}
                title="Open"
                onPress={() => {
                  void action.run("launch", () => launch(app.id));
                }}
              />
            </View>
          ))}
          {apps.data?.apps.length === 0 ? (
            <Text>No apps in this space yet.</Text>
          ) : null}
          {appId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void action.run("launch", () => launch(appId));
              }}
              style={card}
            >
              <Text style={{ color: colors.link, fontWeight: "600" }}>
                Open selected app
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </Screen>
  );
}
