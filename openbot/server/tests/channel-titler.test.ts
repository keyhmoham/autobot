import { describe, expect, test } from "bun:test";
import { createChannelTitler } from "../src/channels/titler";
import { type Complete, NoModelError } from "../src/llm/models";

/** The gateway's `complete`, answering as a model would, and remembering what it was asked. */
function completing(answer: string | Error) {
  const asked: Parameters<Complete>[0][] = [];
  const complete: Complete = async (input) => {
    asked.push(input);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { asked, complete };
}

describe("asking the model for a title", () => {
  test("asks the decision model, with the naming rules and the excerpt", async () => {
    const { asked, complete } = completing("Travel receipt rules");
    const answer = await createChannelTitler({ complete })(
      "Asked: which receipts count as travel?",
    );
    expect(answer).toBe("Travel receipt rules");
    expect(asked[0]).toMatchObject({
      role: "decision",
      prompt: "Asked: which receipts count as travel?",
    });
    expect(asked[0]?.system).toContain("You name conversations");
  });

  test("names nothing, without failing, when no model is set up", async () => {
    const { complete } = completing(new NoModelError("None chosen."));
    expect(
      await createChannelTitler({ complete })("Asked: anything?"),
    ).toBeNull();
  });

  test("throws when the model refuses, so the work is tried again", async () => {
    const { complete } = completing(
      new Error("The decision model answered 429."),
    );
    await expect(
      createChannelTitler({ complete })("Asked: anything?"),
    ).rejects.toThrow("429");
  });

  test("an empty completion is no answer rather than an empty title", async () => {
    const { complete } = completing("   ");
    expect(
      await createChannelTitler({ complete })("Asked: anything?"),
    ).toBeNull();
  });
});
