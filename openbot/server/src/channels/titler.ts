/**
 * One model call for a few words. Not a Bot and not a turn: a title is not said to anybody and is
 * not part of the conversation it names, so there is no runtime work and no thread to hold.
 */
import { type Complete, NoModelError } from "../llm/models";

/** Rules, not an example: a model copies an example's subject as readily as its shape. */
const INSTRUCTION = [
  "You name conversations, like a title in a sidebar.",
  "Answer with three to six words naming what the conversation is about.",
  "No quotation marks, no trailing period, no prefix such as 'Conversation about'.",
  "Name the subject itself, not the fact that somebody asked about it.",
].join(" ");

export type TitlerOptions = {
  /** A short answer from the deployment's decision model, through the model gateway. */
  complete: Complete;
};

export function createChannelTitler(options: TitlerOptions) {
  return async (excerpt: string): Promise<string | null> => {
    let content: string;
    try {
      content = await options.complete({
        role: "decision",
        system: INSTRUCTION,
        prompt: excerpt,
        maxTokens: 512,
      });
    } catch (error) {
      // Not a failure. A deployment with no model set up does not name conversations, and must not
      // fail the work every pass finding that out.
      if (error instanceof NoModelError) return null;
      throw error;
    }
    const answer = content.trim();
    return answer.length > 0 ? answer : null;
  };
}
