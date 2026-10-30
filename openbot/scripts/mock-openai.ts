/**
 * A tiny OpenAI-compatible stub for local UI testing when no vendor key is available.
 * Serves /v1/models and /v1/chat/completions on MOCK_OPENAI_PORT (default 3099).
 */
const port = Number(process.env.MOCK_OPENAI_PORT ?? 3099);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return Response.json({
        object: "list",
        data: [{ id: "gpt-4o-mini", object: "model", created: 1, owned_by: "mock" }],
      });
    }
    if (
      url.pathname === "/v1/chat/completions" ||
      url.pathname === "/chat/completions"
    ) {
      const body = (await req.json().catch(() => ({}))) as {
        stream?: boolean;
        messages?: { role: string; content: string }[];
      };
      const last = body.messages?.at(-1)?.content ?? "";
      const text =
        "This is the local mock model. I can help you try OpenDuet's Spaces, Feed, Wallet and Admin screens.";
      if (body.stream) {
        const chunk = {
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `${text}\n\n(You said: ${String(last).slice(0, 200)})` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock openai on http://127.0.0.1:${port}/v1`);
