import { Redirect, router } from "expo-router";
import { useCallback, useState } from "react";
import { Button, Pressable, Text, TextInput, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  colors,
  heading,
  input,
  muted,
  Problem,
  Screen,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

type Post = {
  id: string;
  body: string;
  author: { handle: string; name: string };
  likes: number;
  comments: number;
  createdAt: string;
};

/** The Feed: recent posts and a short composer. */
export default function FeedScreen() {
  const { data: session, isPending } = authClient.useSession();
  const [draft, setDraft] = useState("");
  const action = useAction();
  const load = useCallback(
    () =>
      api<{ posts: Post[] }>("/api/social/feed?kind=following"),
    [],
  );
  const feed = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  return (
    <Screen refreshing={feed.pending} onRefresh={() => void feed.refresh()}>
      <Text style={heading}>Feed</Text>
      <Problem message={feed.error || action.error} />
      <View style={card}>
        <TextInput
          accessibilityLabel="Write a post"
          multiline
          onChangeText={setDraft}
          placeholder="Share something"
          style={[input, { minHeight: 72 }]}
          value={draft}
        />
        <Button
          disabled={Boolean(action.busy) || !draft.trim()}
          title="Post"
          onPress={() => {
            void action.run("post", async () => {
              await api("/api/social/posts", {
                method: "POST",
                body: { body: draft.trim() },
              });
              setDraft("");
              await feed.refresh();
            });
          }}
        />
      </View>
      {feed.data?.posts.map((post) => (
        <Pressable
          key={post.id}
          accessibilityRole="link"
          accessibilityLabel={`Open post by ${post.author.handle}`}
          onPress={() =>
            router.push({ pathname: "/post", params: { postId: post.id } })
          }
          style={card}
        >
          <Text style={{ fontWeight: "600", color: colors.link }}>
            @{post.author.handle}
          </Text>
          <Text>{post.body}</Text>
          <Text style={muted}>
            {post.likes} likes · {post.comments} comments ·{" "}
            {new Date(post.createdAt).toLocaleString()}
          </Text>
        </Pressable>
      ))}
      {feed.data?.posts.length === 0 && (
        <Text>Nothing here yet. Follow people or post something.</Text>
      )}
    </Screen>
  );
}
