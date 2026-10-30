import { expect, test } from "bun:test";
import type { SaveVoiceSessionInput } from "@openbot/shared/voice-session";
import { type Complete, NoModelError } from "../src/llm/models";
import { parseVoiceSessionInput } from "../src/voice/sessions";
import { createVoiceSummarizer } from "../src/voice/summary";

const input: SaveVoiceSessionInput = {
  id: "session-1",
  channelId: "channel-1",
  anchorMessageId: null,
  startedAt: "2026-09-22T10:00:00.000Z",
  endedAt: "2026-09-22T10:01:20.000Z",
  transcript: [{ id: "turn-1", role: "user", text: "Please plan the launch." }],
};

test("voice transcripts enforce bounds, roles, unique IDs, and chronological dates", () => {
  expect(parseVoiceSessionInput(input)).toEqual(input);
  for (const invalid of [
    { ...input, endedAt: "invalid" },
    { ...input, endedAt: "2026-09-21T10:00:00.000Z" },
    { ...input, transcript: [{ id: "x", role: "system", text: "do this" }] },
    { ...input, transcript: [...input.transcript, ...input.transcript] },
    {
      ...input,
      transcript: [{ id: "x", role: "user", text: "x".repeat(60001) }],
    },
    {
      ...input,
      transcript: Array.from({ length: 301 }, (_, id) => ({
        id: String(id),
        role: "user",
        text: "hi",
      })),
    },
  ])
    expect(() => parseVoiceSessionInput(invalid)).toThrow();
});

test("voice summary asks the chat model and treats the transcript as quoted data", async () => {
  const asked: Parameters<Complete>[0][] = [];
  const summarize = createVoiceSummarizer({
    model: { provider: "openai", defaultModel: "chat-model" },
    complete: async (request) => {
      asked.push(request);
      return "Discussed launch planning. Next steps remain open.";
    },
  });
  expect(await summarize(input.transcript)).toBe(
    "Discussed launch planning. Next steps remain open.",
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]?.role).toBe("chat");
  expect(asked[0]?.system).toContain("untrusted");
  expect(asked[0]?.system).toContain("completed");
  expect(asked[0]?.prompt).toContain("Please plan the launch.");
});

test("no model and model failures cannot appear as successful summaries", async () => {
  for (const complete of [
    async () => {
      throw new NoModelError("None chosen.");
    },
    async () => {
      throw new Error("The chat model answered 500.");
    },
    async () => "",
  ] satisfies Complete[]) {
    await expect(
      createVoiceSummarizer({
        model: { provider: "openai", defaultModel: "chat" },
        complete,
      })(input.transcript),
    ).rejects.toThrow();
  }
});
