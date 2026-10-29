/**
 * A room's desk: what the people and the Bots of a room have put in front of everybody in it.
 *
 * Every channel of a room shares its desk. On a wide screen the desk is a surface of floating
 * windows, placed, moved, resized and closed by people and Bots alike; on a phone the same windows
 * are a board of gadgets in a grid, each a compact face that opens the whole window in a sheet. One
 * document holds both views, so a window a Bot opens appears as a window on a laptop and as a gadget
 * on a phone, and arranging either never loses the other.
 *
 * PURE AND SHARED. The server applies every change with `applyDeskOp` and stores the result; the app
 * reads these types and draws them. Nothing here touches a database or a screen.
 *
 * Coordinates are logical pixels from the desk's top-left corner. The desk scrolls, so a window may
 * lie past the visible part; clients report the size they show (`viewport`) so a Bot placing a
 * window puts it where people will see it.
 */

/**
 * What a window shows.
 *
 * `app`: a web app installed on the space's computer, served through the app gateway. `file`: a file
 * of the space computer's `/workspace`. `computer`: the space computer's screen, live. `page`: a page
 * a Bot made (a doc, a deck, a dashboard). `component`: one of the deployment's published
 * components, drawn with the props a Bot gave it.
 */
export const DESK_KINDS = [
  "app",
  "file",
  "computer",
  "page",
  "component",
] as const;
export type DeskKind = (typeof DESK_KINDS)[number];

/** How a gadget sits on the phone board: its shape, and how many cells it takes. */
export const DESK_SHAPES = ["card", "squircle", "pill", "circle"] as const;
export type DeskShape = (typeof DESK_SHAPES)[number];
/** 1×1, 2×1 and 2×2 cells. */
export const DESK_SIZES = ["small", "medium", "large"] as const;
export type DeskSize = (typeof DESK_SIZES)[number];

export const DESK_MARGIN = 16;
/** The band at the foot of the viewport the composer takes: windows placed to be seen stay above. */
export const DESK_BOTTOM_RESERVE = 168;
export const DESK_MIN_W = 240;
export const DESK_MIN_H = 180;
export const DESK_MAX_SIZE = 4000;
export const DESK_MAX_WINDOWS = 40;
export const DESK_MAX_PINS = 60;
const DEFAULT_VIEWPORT: DeskViewport = { w: 1200, h: 800 };

export type DeskViewport = { w: number; h: number };

export type DeskGadget = { order: number; shape?: DeskShape; size?: DeskSize };

/** What a window shows, by kind. Checked by `checkTarget`, so a stored window always has one. */
export type DeskTarget =
  | { kind: "app"; appId: string; path?: string }
  | { kind: "file"; path: string }
  | { kind: "computer" }
  | { kind: "page"; pageId: string }
  | { kind: "component"; name: string; props: Record<string, unknown> };

export type DeskWindow = {
  id: string;
  title: string;
  target: DeskTarget;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  gadget: DeskGadget;
  /** Who opened it: a person's user id, or `agent:<id>` for a Bot. */
  openedBy: string;
  openedAt: string;
};

/** A window kept as a shortcut, to open again later in one tap. */
export type DeskPin = {
  id: string;
  title: string;
  target: DeskTarget;
  w: number;
  h: number;
  gadget: Omit<DeskGadget, "order">;
  pinnedAt: string;
};

export type Desk = {
  version: number;
  viewport: DeskViewport;
  windows: DeskWindow[];
  pins: DeskPin[];
};

export type DeskRect = { x?: number; y?: number; w?: number; h?: number };

/** One change to a desk. A window opened without a rectangle is placed where it overlaps least. */
export type DeskOp =
  | ({
      op: "open";
      title?: string;
      target: DeskTarget;
      gadget?: Partial<Omit<DeskGadget, "order">>;
    } & DeskRect)
  | ({ op: "move"; id: string } & DeskRect)
  | { op: "focus"; id: string }
  | {
      op: "arrange";
      id: string;
      order?: number;
      shape?: DeskShape;
      size?: DeskSize;
    }
  | { op: "close"; id: string }
  | { op: "close_all" }
  | { op: "pin"; id: string }
  | { op: "unpin"; id: string }
  | { op: "open_pin"; id: string }
  | { op: "viewport"; w: number; h: number };

export class DeskOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeskOpError";
  }
}

export function emptyDesk(): Desk {
  return { version: 0, viewport: { w: 0, h: 0 }, windows: [], pins: [] };
}

const PATH_PATTERN = /^\/workspace\/[^\0]+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const APP_PATH_PATTERN = /^\/[^\s\\]*$/;

/** A window's target, refused unless it is one a client can draw safely. */
export function checkTarget(target: DeskTarget): DeskTarget {
  switch (target?.kind) {
    case "app": {
      if (!ID_PATTERN.test(target.appId))
        throw new DeskOpError(
          "An app window names an installed app by its id.",
        );
      const path = target.path ?? "/";
      if (!APP_PATH_PATTERN.test(path) || path.includes(".."))
        throw new DeskOpError(
          "An app window's path is a path inside the app, starting with /.",
        );
      return { kind: "app", appId: target.appId, path };
    }
    case "file": {
      const path = normalizeWorkspacePath(target.path);
      if (!path)
        throw new DeskOpError(
          "A file window shows a file of the space's /workspace.",
        );
      return { kind: "file", path };
    }
    case "computer":
      return { kind: "computer" };
    case "page":
      if (!ID_PATTERN.test(target.pageId))
        throw new DeskOpError("A page window names a page by its id.");
      return { kind: "page", pageId: target.pageId };
    case "component": {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(target.name))
        throw new DeskOpError("A component window names a component.");
      const props =
        target.props &&
        typeof target.props === "object" &&
        !Array.isArray(target.props)
          ? target.props
          : {};
      if (JSON.stringify(props).length > 64_000)
        throw new DeskOpError("A component's props are at most 64KB.");
      return { kind: "component", name: target.name, props };
    }
    default:
      throw new DeskOpError(`A window shows one of: ${DESK_KINDS.join(", ")}.`);
  }
}

/** `/workspace/…` or a path relative to it, as `/workspace/…`; null for anything outside. */
export function normalizeWorkspacePath(raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const relative =
    raw === "/workspace" || raw.startsWith("/workspace/")
      ? raw.slice("/workspace".length)
      : raw.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  const path = `/workspace/${parts.join("/")}`;
  return parts.length && PATH_PATTERN.test(path) ? path : null;
}

/** Two targets that show the same thing are one window. */
export function sameTarget(left: DeskTarget, right: DeskTarget): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function defaultTitle(target: DeskTarget): string {
  switch (target.kind) {
    case "app":
      return "App";
    case "file":
      return target.path.split("/").pop() ?? "File";
    case "computer":
      return "Computer";
    case "page":
      return "Page";
    case "component":
      return target.name;
  }
}

function defaultSize(target: DeskTarget): { w: number; h: number } {
  switch (target.kind) {
    case "app":
      return { w: 640, h: 560 };
    case "computer":
      return { w: 720, h: 520 };
    case "component":
      return { w: 520, h: 420 };
    default:
      return { w: 460, h: 560 };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function viewportOf(desk: Desk): DeskViewport {
  return {
    w: desk.viewport.w >= 320 ? desk.viewport.w : DEFAULT_VIEWPORT.w,
    h: desk.viewport.h >= 320 ? desk.viewport.h : DEFAULT_VIEWPORT.h,
  };
}

/** The part of the viewport windows are placed in to be seen at once. */
export function usableArea(desk: Desk) {
  const viewport = viewportOf(desk);
  return {
    x: DESK_MARGIN,
    y: DESK_MARGIN,
    w: viewport.w - 2 * DESK_MARGIN,
    h: Math.max(DESK_MIN_H, viewport.h - DESK_MARGIN - DESK_BOTTOM_RESERVE),
  };
}

/** Where a w×h window overlaps the open ones least, scanning the usable area top-left first. */
export function placeWindow(
  desk: Desk,
  w: number,
  h: number,
): { x: number; y: number } {
  const area = usableArea(desk);
  const step = 24;
  let best = Number.POSITIVE_INFINITY;
  let at = { x: area.x, y: area.y };
  for (
    let y = area.y;
    y === area.y || y + h <= area.y + area.h + 0.5;
    y += step
  ) {
    for (
      let x = area.x;
      x === area.x || x + w <= area.x + area.w + 0.5;
      x += step
    ) {
      let overlap = 0;
      for (const other of desk.windows) {
        const across = Math.max(
          0,
          Math.min(x + w, other.x + other.w) - Math.max(x, other.x),
        );
        const down = Math.max(
          0,
          Math.min(y + h, other.y + other.h) - Math.max(y, other.y),
        );
        overlap += across * down;
      }
      if (overlap < best) {
        best = overlap;
        at = { x, y };
      }
      if (best === 0) return at;
      if (x + w > area.x + area.w) break;
    }
    if (y + h > area.y + area.h) break;
  }
  return at;
}

function topZ(desk: Desk): number {
  return desk.windows.reduce((top, window) => Math.max(top, window.z), 0);
}

/** The board's order, renumbered 0…n-1, unarranged windows after in the order they opened. */
function renumber(windows: DeskWindow[]): DeskWindow[] {
  const ordered = [...windows].sort(
    (left, right) => left.gadget.order - right.gadget.order,
  );
  return windows.map((window) => ({
    ...window,
    gadget: { ...window.gadget, order: ordered.indexOf(window) },
  }));
}

function checkGadget(gadget: Partial<Omit<DeskGadget, "order">> | undefined) {
  if (
    gadget?.shape &&
    !(DESK_SHAPES as readonly string[]).includes(gadget.shape)
  )
    throw new DeskOpError(
      `A gadget's shape is one of ${DESK_SHAPES.join(", ")}.`,
    );
  if (gadget?.size && !(DESK_SIZES as readonly string[]).includes(gadget.size))
    throw new DeskOpError(
      `A gadget's size is one of ${DESK_SIZES.join(", ")}.`,
    );
}

function moved(window: DeskWindow, rect: DeskRect): DeskWindow {
  return {
    ...window,
    x: finite(rect.x) ? clamp(rect.x, 0, DESK_MAX_SIZE) : window.x,
    y: finite(rect.y) ? clamp(rect.y, 0, DESK_MAX_SIZE) : window.y,
    w: finite(rect.w) ? clamp(rect.w, DESK_MIN_W, DESK_MAX_SIZE) : window.w,
    h: finite(rect.h) ? clamp(rect.h, DESK_MIN_H, DESK_MAX_SIZE) : window.h,
  };
}

function find(desk: Desk, id: string): DeskWindow {
  const window = desk.windows.find((candidate) => candidate.id === id);
  if (!window) throw new DeskOpError(`There is no window ${id} on this desk.`);
  return window;
}

function replace(desk: Desk, window: DeskWindow): DeskWindow[] {
  return desk.windows.map((candidate) =>
    candidate.id === window.id ? window : candidate,
  );
}

export type DeskOpResult = {
  desk: Desk;
  /** The window the op opened, focused, moved or arranged, when it was about one. */
  windowId: string | null;
};

/**
 * One change to a desk, returning the desk after it. Never mutates its input, so a caller holding
 * the stored desk can retry against a newer one. The version is the caller's to advance.
 */
export function applyDeskOp(
  desk: Desk,
  op: DeskOp,
  context: { actor: string; now: Date; newId: () => string },
): DeskOpResult {
  switch (op.op) {
    case "open": {
      const target = checkTarget(op.target);
      checkGadget(op.gadget);
      const existing = desk.windows.find((window) =>
        sameTarget(window.target, target),
      );
      // The same thing twice is one window, brought to the front.
      if (existing) {
        const front = moved(
          {
            ...existing,
            z: topZ(desk) + 1,
            ...(op.title ? { title: op.title.slice(0, 120) } : {}),
            gadget: { ...existing.gadget, ...op.gadget },
          },
          op,
        );
        return {
          desk: { ...desk, windows: replace(desk, front) },
          windowId: front.id,
        };
      }
      if (desk.windows.length >= DESK_MAX_WINDOWS)
        throw new DeskOpError(
          `A desk holds ${DESK_MAX_WINDOWS} windows at most; close some first.`,
        );
      const area = usableArea(desk);
      const size = defaultSize(target);
      const w = clamp(
        finite(op.w) ? op.w : Math.min(size.w, area.w),
        DESK_MIN_W,
        DESK_MAX_SIZE,
      );
      const h = clamp(
        finite(op.h) ? op.h : Math.min(size.h, area.h),
        DESK_MIN_H,
        DESK_MAX_SIZE,
      );
      const place = placeWindow(desk, w, h);
      const window = moved(
        {
          id: context.newId(),
          title: (op.title?.trim() || defaultTitle(target)).slice(0, 120),
          target,
          ...place,
          w,
          h,
          z: topZ(desk) + 1,
          gadget: { order: desk.windows.length, ...op.gadget },
          openedBy: context.actor,
          openedAt: context.now.toISOString(),
        },
        { x: op.x, y: op.y },
      );
      return {
        desk: { ...desk, windows: renumber([...desk.windows, window]) },
        windowId: window.id,
      };
    }
    case "move": {
      const window = moved(find(desk, op.id), op);
      return {
        desk: { ...desk, windows: replace(desk, window) },
        windowId: window.id,
      };
    }
    case "focus": {
      const window = { ...find(desk, op.id), z: topZ(desk) + 1 };
      return {
        desk: { ...desk, windows: replace(desk, window) },
        windowId: window.id,
      };
    }
    case "arrange": {
      const window = find(desk, op.id);
      checkGadget(op);
      const others = [...desk.windows]
        .filter((candidate) => candidate.id !== window.id)
        .sort((left, right) => left.gadget.order - right.gadget.order);
      const at = clamp(
        finite(op.order) ? Math.trunc(op.order) : window.gadget.order,
        0,
        others.length,
      );
      const board = [...others.slice(0, at), window, ...others.slice(at)];
      const windows = desk.windows.map((candidate) => {
        const gadget = {
          ...candidate.gadget,
          ...(candidate.id === window.id
            ? {
                ...(op.shape ? { shape: op.shape } : {}),
                ...(op.size ? { size: op.size } : {}),
              }
            : {}),
          order: board.findIndex((entry) => entry.id === candidate.id),
        };
        return { ...candidate, gadget };
      });
      return { desk: { ...desk, windows }, windowId: window.id };
    }
    case "close": {
      find(desk, op.id);
      return {
        desk: {
          ...desk,
          windows: renumber(
            desk.windows.filter((window) => window.id !== op.id),
          ),
        },
        windowId: op.id,
      };
    }
    case "close_all":
      return { desk: { ...desk, windows: [] }, windowId: null };
    case "pin": {
      const window = find(desk, op.id);
      if (desk.pins.some((pin) => sameTarget(pin.target, window.target)))
        return { desk, windowId: window.id };
      if (desk.pins.length >= DESK_MAX_PINS)
        throw new DeskOpError(`A desk keeps ${DESK_MAX_PINS} pins at most.`);
      const { order: _order, ...gadget } = window.gadget;
      const pin: DeskPin = {
        id: context.newId(),
        title: window.title,
        target: window.target,
        w: window.w,
        h: window.h,
        gadget,
        pinnedAt: context.now.toISOString(),
      };
      return {
        desk: { ...desk, pins: [...desk.pins, pin] },
        windowId: window.id,
      };
    }
    case "unpin": {
      if (!desk.pins.some((pin) => pin.id === op.id))
        throw new DeskOpError(`There is no pin ${op.id} on this desk.`);
      return {
        desk: { ...desk, pins: desk.pins.filter((pin) => pin.id !== op.id) },
        windowId: null,
      };
    }
    case "open_pin": {
      const pin = desk.pins.find((candidate) => candidate.id === op.id);
      if (!pin) throw new DeskOpError(`There is no pin ${op.id} on this desk.`);
      return applyDeskOp(
        desk,
        {
          op: "open",
          title: pin.title,
          target: pin.target,
          w: pin.w,
          h: pin.h,
          gadget: pin.gadget,
        },
        context,
      );
    }
    case "viewport":
      if (!finite(op.w) || !finite(op.h))
        throw new DeskOpError("A viewport is a width and a height.");
      return {
        desk: {
          ...desk,
          viewport: {
            w: clamp(Math.round(op.w), 0, DESK_MAX_SIZE),
            h: clamp(Math.round(op.h), 0, DESK_MAX_SIZE),
          },
        },
        windowId: null,
      };
    default:
      throw new DeskOpError("Unknown desk operation.");
  }
}

/** The windows in board order, which is how a phone lists them. */
export function boardOrder(desk: Pick<Desk, "windows">): DeskWindow[] {
  return [...desk.windows].sort(
    (left, right) => left.gadget.order - right.gadget.order,
  );
}
