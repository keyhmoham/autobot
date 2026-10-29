/**
 * Apps, read from both sides: the web apps a space's Bots build and run in the space's computer, and
 * how the people of the space open them.
 *
 * An app is a directory in the space computer's workspace with a manifest (`openduet.app.json`) that
 * says what it is called and how to run it. Bots write it with the same tools they write any code
 * with; installing it builds it, starts it as a service the computer keeps running, and lists it in
 * the space. People open it in a sandboxed frame (a web page's iframe, a phone's WebView, a desktop
 * window), through a short-lived link that names the app and the person, so the app's own code never
 * holds anybody's session.
 */

export const APP_MANIFEST_FILE = "openduet.app.json";

/** Where apps live in the space computer, by convention: `/workspace/apps/<slug>`. */
export const APPS_DIRECTORY = "apps";

export const APP_STATUSES = [
  "installing",
  "running",
  "stopped",
  "failed",
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const APP_TEMPLATES = ["static", "bun", "vite-react"] as const;
export type AppTemplate = (typeof APP_TEMPLATES)[number];

/** What a manifest may say. `start` is required; everything else has a default. */
export type AppManifest = {
  name: string;
  description?: string;
  /** A single emoji or short glyph shown on the app's tile. */
  icon?: string;
  /** Run once before starting, when the app is installed or rebuilt: `bun install && bun run build`. */
  build?: string;
  /** Keeps running; must listen on $PORT at $HOST. */
  start: string;
};

export type AppWire = {
  id: string;
  spaceId: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  /** The app's directory in the space computer's workspace. */
  path: string;
  status: AppStatus;
  /** Why it is not running, when it failed. */
  error: string | null;
  version: number;
  createdBy: { kind: "agent" | "person"; id: string };
  installedAt: string;
  updatedAt: string;
};

/** A slug made from an app's name: what its service and its directory are called. */
export function appSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "app";
}

/** How long a link to open an app lasts. Opening it again makes a new one. */
export const APP_LINK_HOURS = 12;

/**
 * The sandbox an app's frame runs in. No `allow-same-origin`: the app's origin is opaque, so its
 * scripts can neither read this deployment's cookies nor call its API as the person viewing it.
 */
export const APP_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox";
