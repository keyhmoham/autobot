/**
 * The Bot tools a shared channel's turn is offered beyond its granted ones: the room's desk, the
 * space's apps and its timeline. Each family is its own module; this is the one way they are built,
 * so every one validates its arguments with its schema and answers a refusal in words the Bot can
 * act on rather than as a failure of the turn.
 */
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
} from "./errors";

/** Where a shared channel's turn runs: the channel, its room and space, and the person it answers. */
export type TurnPlace = {
  channelId: string;
  roomId: string;
  spaceId: string;
  agentId: string;
  actingFor: string;
};

export function workspaceTool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  execute: (input: z.output<T>) => Promise<unknown>,
): HeadlessTool {
  return {
    definition: { name, description, parameters: z.toJSONSchema(schema) },
    execute: async (args) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success)
        return {
          error:
            parsed.error.issues[0]?.message ?? "Those arguments are not valid.",
        };
      try {
        return await execute(parsed.data);
      } catch (error) {
        if (
          error instanceof WorkspaceRefusedError ||
          error instanceof WorkspaceForbiddenError ||
          error instanceof WorkspaceNotFoundError
        )
          return { error: error.message };
        throw error;
      }
    },
  };
}
