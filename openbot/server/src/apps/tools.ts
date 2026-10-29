/**
 * Apps, as a Bot builds them: start one from a template, install it from its manifest, read its
 * logs, restart or stop it. The code itself is written with the computer tools every Bot already has
 * (write files, run commands), in the app's directory in the space computer's workspace.
 */
import { APP_MANIFEST_FILE, APP_TEMPLATES } from "@openbot/shared/apps";
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import { type TurnPlace, workspaceTool } from "../workspace/tools";
import type { AppHand, Apps } from "./service";

export const APP_GUIDANCE = [
  "You can build web apps for this space. They run in the space's computer and open for everyone in the space in a window on the room's desk.",
  `An app is a directory under apps/ in the workspace with an ${APP_MANIFEST_FILE} manifest: {"name", "description", "icon", "build" (optional, run before starting), "start" (keeps running and listens on $PORT at $HOST)}.`,
  "Start one with apps_create, write its code with your file and command tools, then apps_install to build and start it. After changing it, apps_install again. If it fails, read apps_logs, fix it and install again.",
  "An app is served under a link, not at the site root: every file and API path it asks for must be relative (./app.js, ./api/items), never /app.js. When it runs, show it with desk_open and target {kind: 'app', appId}.",
].join(" ");

const app = z
  .string()
  .min(1)
  .describe("The app's id or its slug (from apps_list).");

export function createAppTools(
  apps: Apps,
  place: TurnPlace,
  initiator: AuditInitiator,
): HeadlessTool[] {
  const hand: AppHand = {
    kind: "agent",
    agentId: place.agentId,
    actingFor: place.actingFor,
    initiator,
  };
  const named = (idOrSlug: string) => apps.find(place.spaceId, idOrSlug);
  return [
    workspaceTool(
      "apps_list",
      "The apps installed in this space: each one's id, name, directory, and whether it is running.",
      z.strictObject({}),
      async () => ({ apps: await apps.list(place.actingFor, place.spaceId) }),
    ),
    workspaceTool(
      "apps_create",
      "Start a new app from a template, in apps/<name> in the space's workspace. 'static' is plain HTML and CSS; 'bun' adds a small server with a JSON API under api/; 'vite-react' is a React app built with Vite. Returns the directory and the files made.",
      z.strictObject({
        name: z.string().min(1).max(60),
        template: z.enum(APP_TEMPLATES),
        description: z.string().max(300).optional(),
      }),
      async (input) => apps.scaffold(hand, place.spaceId, input),
    ),
    workspaceTool(
      "apps_install",
      `Build and start the app whose ${APP_MANIFEST_FILE} is in this directory, or rebuild and restart it after a change. Returns the app, with what went wrong when it failed.`,
      z.strictObject({
        path: z
          .string()
          .describe(
            "The app's directory, relative to the workspace: apps/notes.",
          ),
      }),
      async (input) => ({
        app: await apps.install(hand, place.spaceId, input),
      }),
    ),
    workspaceTool(
      "apps_logs",
      "The last lines an app printed: what to read when it fails to start or misbehaves.",
      z.strictObject({
        app,
        lines: z.number().int().min(1).max(2_000).optional(),
      }),
      async (input) =>
        apps.logs(place.actingFor, await named(input.app), input.lines ?? 200),
    ),
    workspaceTool(
      "apps_restart",
      "Restart an app, building it again first when its manifest has a build step.",
      z.strictObject({ app }),
      async (input) => ({
        app: await apps.restart(hand, await named(input.app)),
      }),
    ),
    workspaceTool(
      "apps_stop",
      "Stop an app. It stays installed and can be started again with apps_restart.",
      z.strictObject({ app }),
      async (input) => ({ app: await apps.stop(hand, await named(input.app)) }),
    ),
  ];
}
