/**
 * The desk, as a Bot reaches it: look at what is on the room's desk, put something on it, rearrange
 * it, take it off. Every call is a `DeskHand` of kind `agent`, decided for the person the turn answers.
 */
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { DESK_KINDS, DESK_SHAPES, DESK_SIZES } from "@openbot/shared/desk";
import { z } from "zod";
import type { Desks } from "./desk";
import { type TurnPlace, workspaceTool } from "./tools";

export const DESK_GUIDANCE = [
  "This room has a desk: a shared board everyone in the room sees beside the conversation, as floating windows on a wide screen and as gadgets on a phone. Every channel in the room shares it.",
  "Put things there that people should keep looking at while you talk: an app you built, a page you made, a file from the space's /workspace, the space computer's screen, or a component with data. Use desk_view to see what is there before you add more, keep it tidy, and close what is no longer useful.",
].join(" ");

const target = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("app"),
    appId: z.string().describe("The installed app's id, from apps_list."),
    path: z
      .string()
      .optional()
      .describe("A path inside the app, starting with /."),
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: z
      .string()
      .describe("A file under /workspace on the space's computer."),
  }),
  z.strictObject({ kind: z.literal("computer") }),
  z.strictObject({
    kind: z.literal("page"),
    pageId: z.string().describe("A page you made with make_page."),
  }),
  z.strictObject({
    kind: z.literal("component"),
    name: z.string().describe("A published component's name."),
    props: z.record(z.string(), z.unknown()),
  }),
]);

export function createDeskTools(
  desks: Desks,
  place: TurnPlace,
): HeadlessTool[] {
  const hand = {
    kind: "agent" as const,
    agentId: place.agentId,
    actingFor: place.actingFor,
  };
  return [
    workspaceTool(
      "desk_view",
      "See what is on this room's desk: its open windows (id, title, what each shows, where it is) and its pins.",
      z.strictObject({}),
      async () => {
        const desk = await desks.read(place.roomId);
        return {
          viewport: desk.viewport,
          windows: desk.windows.map(
            ({ id, title, target, x, y, w, h, gadget }) => ({
              id,
              title,
              target,
              x,
              y,
              w,
              h,
              gadget,
            }),
          ),
          pins: desk.pins.map(({ id, title, target }) => ({
            id,
            title,
            target,
          })),
        };
      },
    ),
    workspaceTool(
      "desk_open",
      `Open a window on this room's desk, or bring one already showing the same thing to the front. A window shows one of: ${DESK_KINDS.join(", ")}. Leave x, y, w and h out to let the desk place it where it overlaps least.`,
      z.strictObject({
        title: z.string().max(120).optional(),
        target,
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        gadget: z
          .strictObject({
            shape: z.enum(DESK_SHAPES).optional(),
            size: z.enum(DESK_SIZES).optional(),
          })
          .optional()
          .describe("How it sits on a phone's board of gadgets."),
      }),
      async (input) => {
        const { windowId } = await desks.apply(place.roomId, hand, {
          op: "open",
          ...input,
        });
        return { opened: windowId };
      },
    ),
    workspaceTool(
      "desk_change",
      "Change a window on this room's desk: move or resize it, bring it to the front, arrange its gadget on phones, pin it so it can be opened again later, or close it. `close_all` clears the desk.",
      z.strictObject({
        op: z.enum([
          "move",
          "focus",
          "arrange",
          "pin",
          "close",
          "close_all",
          "unpin",
          "open_pin",
        ]),
        id: z
          .string()
          .optional()
          .describe("The window's id, or the pin's for unpin and open_pin."),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        order: z.number().int().optional(),
        shape: z.enum(DESK_SHAPES).optional(),
        size: z.enum(DESK_SIZES).optional(),
      }),
      async ({ op, ...rest }) => {
        const result = await desks.apply(place.roomId, hand, { op, ...rest });
        return { done: op, window: result.windowId };
      },
    ),
  ];
}
