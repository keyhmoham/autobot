import { describe, expect, test } from "bun:test";
import {
  applyDeskOp,
  boardOrder,
  DESK_MAX_WINDOWS,
  type Desk,
  type DeskOp,
  DeskOpError,
  emptyDesk,
  normalizeWorkspacePath,
} from "./desk";

let counter = 0;
const context = {
  actor: "user-1",
  now: new Date("2026-10-29T10:00:00Z"),
  newId: () => `w${++counter}`,
};
const apply = (desk: Desk, op: DeskOp) => applyDeskOp(desk, op, context).desk;

describe("desk", () => {
  test("an open without a rectangle is placed where it overlaps least", () => {
    let desk = apply(emptyDesk(), { op: "viewport", w: 1600, h: 1000 });
    desk = apply(desk, { op: "open", target: { kind: "computer" } });
    desk = apply(desk, {
      op: "open",
      target: { kind: "file", path: "notes.md" },
    });
    const [first, second] = desk.windows;
    expect(first?.x).toBe(16);
    expect(second?.target).toEqual({
      kind: "file",
      path: "/workspace/notes.md",
    });
    expect((second?.x ?? 0) >= (first?.x ?? 0) + (first?.w ?? 0)).toBe(true);
    expect(second?.z).toBeGreaterThan(first?.z ?? 0);
  });

  test("the same thing opened twice is one window, brought to the front", () => {
    let desk = apply(emptyDesk(), { op: "open", target: { kind: "computer" } });
    desk = apply(desk, { op: "open", target: { kind: "page", pageId: "p1" } });
    const result = applyDeskOp(
      desk,
      { op: "open", target: { kind: "computer" } },
      context,
    );
    expect(result.desk.windows).toHaveLength(2);
    expect(result.windowId).toBe(desk.windows[0]?.id ?? "");
    expect(result.desk.windows[0]?.z).toBe(3);
  });

  test("arranging moves a gadget on the phone board without touching the windows", () => {
    let desk = emptyDesk();
    for (const pageId of ["a", "b", "c"])
      desk = apply(desk, { op: "open", target: { kind: "page", pageId } });
    const last = desk.windows[2]?.id ?? "";
    desk = apply(desk, { op: "arrange", id: last, order: 0, size: "large" });
    expect(boardOrder(desk).map((window) => window.target)).toEqual([
      { kind: "page", pageId: "c" },
      { kind: "page", pageId: "a" },
      { kind: "page", pageId: "b" },
    ]);
    expect(boardOrder(desk)[0]?.gadget.size).toBe("large");
  });

  test("closing renumbers the board", () => {
    let desk = emptyDesk();
    for (const pageId of ["a", "b", "c"])
      desk = apply(desk, { op: "open", target: { kind: "page", pageId } });
    desk = apply(desk, { op: "close", id: desk.windows[0]?.id ?? "" });
    expect(desk.windows.map((window) => window.gadget.order)).toEqual([0, 1]);
  });

  test("a pin opens again with the size it was kept at", () => {
    let desk = apply(emptyDesk(), {
      op: "open",
      target: { kind: "app", appId: "crm" },
      w: 700,
      h: 500,
    });
    const id = desk.windows[0]?.id ?? "";
    desk = apply(desk, { op: "pin", id });
    desk = apply(desk, { op: "close", id });
    desk = apply(desk, { op: "open_pin", id: desk.pins[0]?.id ?? "" });
    expect(desk.windows[0]).toMatchObject({ w: 700, h: 500 });
    expect(desk.windows[0]?.target).toEqual({
      kind: "app",
      appId: "crm",
      path: "/",
    });
  });

  test("targets that leave their place are refused", () => {
    expect(() =>
      apply(emptyDesk(), {
        op: "open",
        target: { kind: "file", path: "../etc/passwd" },
      }),
    ).toThrow(DeskOpError);
    expect(() =>
      apply(emptyDesk(), {
        op: "open",
        target: { kind: "app", appId: "crm", path: "/../../admin" },
      }),
    ).toThrow(DeskOpError);
    expect(normalizeWorkspacePath("/workspace/a/./b")).toBe("/workspace/a/b");
    expect(normalizeWorkspacePath("/workspace")).toBeNull();
  });

  test("a desk holds a bounded number of windows", () => {
    let desk = emptyDesk();
    for (let index = 0; index < DESK_MAX_WINDOWS; index += 1)
      desk = apply(desk, {
        op: "open",
        target: { kind: "page", pageId: `p${index}` },
      });
    expect(() =>
      apply(desk, { op: "open", target: { kind: "page", pageId: "one-more" } }),
    ).toThrow(DeskOpError);
  });

  test("input is never mutated", () => {
    const desk = apply(emptyDesk(), {
      op: "open",
      target: { kind: "computer" },
    });
    const frozen = JSON.stringify(desk);
    apply(desk, { op: "move", id: desk.windows[0]?.id ?? "", x: 300 });
    expect(JSON.stringify(desk)).toBe(frozen);
  });
});
