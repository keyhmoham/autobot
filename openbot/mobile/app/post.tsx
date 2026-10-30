import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  heading,
  input,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

type Post = {
  id: string;
  body: string;
  author: { handle: string; name: string };
  likes: number;
  comments: number;
  likedByYou: boolean;
  createdAt: string;
};

/** One post, its comments, and a reply field. */
export default function PostScreen() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const [reply, setReply] = useState("");
  const action = useAction();
  const loadPost = useCallback(
    () =>
      api<{ post: Post }>(
        `/api/social/posts/${encodeURIComponent(postId ?? "")}`,
      ),
    [postId],
  );
  const loadComments = useCallback(
    () =>
      api<{ comments: Post[] }>(
        `/api/social/posts/${encodeURIComponent(postId ?? "")}/comments`,
      ),
    [postId],
  );
  const post = useLoad(loadPost, Boolean(session && postId));
  const comments = useLoad(loadComments, Boolean(session && postId));
  if (!session && !isPending) return <Redirect href="/" />;
  const row = post.data?.post;
  return (
    <Screen
      refreshing={post.pending || comments.pending}
      onRefresh={() => {
        void post.refresh();
        void comments.refresh();
      }}
    >
      <Problem message={post.error || comments.error || action.error} />
      {row ? (
        <View style={card}>
          <Text style={heading}>@{row.author.handle}</Text>
          <Text>{row.body}</Text>
          <Text style={muted}>
            {row.likes} likes · {new Date(row.createdAt).toLocaleString()}
          </Text>
          <Button
            disabled={Boolean(action.busy)}
            title={row.likedByYou ? "Unlike" : "Like"}
            onPress={() => {
              void action.run("like", async () => {
                await api(
                  `/api/social/posts/${encodeURIComponent(row.id)}/like`,
                  { method: row.likedByYou ? "DELETE" : "POST" },
                );
                await post.refresh();
              });
            }}
          />
        </View>
      ) : null}
      <Section title="Comments">
        {comments.data?.comments.map((comment) => (
          <View key={comment.id} style={card}>
            <Text style={{ fontWeight: "600" }}>@{comment.author.handle}</Text>
            <Text>{comment.body}</Text>
          </View>
        ))}
        {comments.data?.comments.length === 0 ? (
          <Text style={muted}>No comments yet.</Text>
        ) : null}
        <TextInput
          accessibilityLabel="Write a comment"
          multiline
          onChangeText={setReply}
          placeholder="Reply"
          style={[input, { minHeight: 56 }]}
          value={reply}
        />
        <Button
          disabled={Boolean(action.busy) || !reply.trim() || !postId}
          title="Comment"
          onPress={() => {
            void action.run("comment", async () => {
              await api(
                `/api/social/posts/${encodeURIComponent(postId ?? "")}/comments`,
                { method: "POST", body: { body: reply.trim() } },
              );
              setReply("");
              await comments.refresh();
              await post.refresh();
            });
          }}
        />
      </Section>
    </Screen>
  );
}
