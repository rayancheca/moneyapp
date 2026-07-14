import { describe, expect, test } from "vitest";
import {
  canGoBack,
  canGoForward,
  currentWindow,
  initialWindowHistory,
  windowHistoryReducer,
  type DashboardWindow,
  type WindowHistoryState,
} from "./window-history";

const w = (start: string, end: string, source: DashboardWindow["source"] = "brush"): DashboardWindow => ({
  start,
  end,
  source,
});

/** Apply a sequence of actions to the initial state. */
function run(...actions: Parameters<typeof windowHistoryReducer>[1][]): WindowHistoryState {
  return actions.reduce(windowHistoryReducer, initialWindowHistory);
}

describe("initialWindowHistory", () => {
  test("is an empty stack parked at the base", () => {
    expect(initialWindowHistory).toEqual({ stack: [], index: -1 });
    expect(currentWindow(initialWindowHistory)).toBeNull();
    expect(canGoBack(initialWindowHistory)).toBe(false);
    expect(canGoForward(initialWindowHistory)).toBe(false);
  });
});

describe("PUSH", () => {
  test("appends onto the base and advances the cursor", () => {
    const s = run({ type: "PUSH", window: w("2026-01-01", "2026-02-01") });
    expect(s.stack).toHaveLength(1);
    expect(s.index).toBe(0);
    expect(currentWindow(s)).toEqual(w("2026-01-01", "2026-02-01"));
  });

  test("stacks multiple windows in order", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("b1", "b2") },
    );
    expect(s.stack.map((x) => x?.start)).toEqual(["a1", "b1"]);
    expect(s.index).toBe(1);
  });

  test("ignores an exact re-push of the current window (no dead step)", () => {
    const once = run({ type: "PUSH", window: w("a1", "a2") });
    const twice = windowHistoryReducer(once, { type: "PUSH", window: w("a1", "a2") });
    expect(twice).toBe(once); // same reference — a genuine no-op
    expect(twice.stack).toHaveLength(1);
  });

  test("a differing start is not deduped", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("z1", "a2") },
    );
    expect(s.stack).toHaveLength(2);
  });

  test("a differing end is not deduped", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("a1", "z2") },
    );
    expect(s.stack).toHaveLength(2);
  });

  test("same [start,end] re-selected by a different source dedupes (same view, no dead step)", () => {
    const once = run({ type: "PUSH", window: w("a1", "a2", "brush") });
    const twice = windowHistoryReducer(once, { type: "PUSH", window: w("a1", "a2", "input") });
    expect(twice).toBe(once); // identical view → no-op regardless of source
    expect(twice.stack).toHaveLength(1);
  });

  test("truncates forward history like a browser", () => {
    // push A, B, C → back to A → push D should drop B and C
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("b1", "b2") },
      { type: "PUSH", window: w("c1", "c2") },
      { type: "BACK" },
      { type: "BACK" },
      { type: "PUSH", window: w("d1", "d2") },
    );
    expect(s.stack.map((x) => x?.start)).toEqual(["a1", "d1"]);
    expect(s.index).toBe(1);
    expect(canGoForward(s)).toBe(false);
  });
});

describe("BACK / FORWARD", () => {
  test("BACK steps toward the base, then to the base (null)", () => {
    const s0 = run({ type: "PUSH", window: w("a1", "a2") });
    const s1 = windowHistoryReducer(s0, { type: "BACK" });
    expect(s1.index).toBe(-1);
    expect(currentWindow(s1)).toBeNull();
  });

  test("BACK at the base is a no-op", () => {
    const s = windowHistoryReducer(initialWindowHistory, { type: "BACK" });
    expect(s).toBe(initialWindowHistory);
  });

  test("FORWARD restores the next window", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("b1", "b2") },
      { type: "BACK" },
      { type: "FORWARD" },
    );
    expect(s.index).toBe(1);
    expect(currentWindow(s)).toEqual(w("b1", "b2"));
  });

  test("FORWARD at the head is a no-op", () => {
    const head = run({ type: "PUSH", window: w("a1", "a2") });
    const s = windowHistoryReducer(head, { type: "FORWARD" });
    expect(s).toBe(head);
  });

  test("canGoBack / canGoForward reflect the cursor position", () => {
    const two = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("b1", "b2") },
    );
    expect(canGoBack(two)).toBe(true);
    expect(canGoForward(two)).toBe(false);
    const back = windowHistoryReducer(two, { type: "BACK" });
    expect(canGoBack(back)).toBe(true);
    expect(canGoForward(back)).toBe(true);
  });
});

describe("PUSH_BASE", () => {
  test("navigates to the base view while KEEPING the trail (Back returns to the window)", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH_BASE" }, // a pill click while zoomed
    );
    expect(currentWindow(s)).toBeNull(); // base view — pills drive the chart
    expect(canGoBack(s)).toBe(true); // the trail survives
    const back = windowHistoryReducer(s, { type: "BACK" });
    expect(currentWindow(back)).toEqual(w("a1", "a2"));
  });

  test("FORWARD after BACK re-applies the pill click (base is a real history entry)", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH_BASE" },
      { type: "BACK" },
      { type: "FORWARD" },
    );
    expect(currentWindow(s)).toBeNull();
  });

  test("is a no-op at the fresh base (pill click with no window active)", () => {
    const s = windowHistoryReducer(initialWindowHistory, { type: "PUSH_BASE" });
    expect(s).toBe(initialWindowHistory);
  });

  test("is a no-op when the current entry is already the base view", () => {
    const once = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH_BASE" },
    );
    const twice = windowHistoryReducer(once, { type: "PUSH_BASE" });
    expect(twice).toBe(once); // no dead Back step from repeated pill clicks
  });

  test("is a no-op after BACK lands on the base cursor", () => {
    const s0 = run({ type: "PUSH", window: w("a1", "a2") }, { type: "BACK" });
    const s = windowHistoryReducer(s0, { type: "PUSH_BASE" });
    expect(s).toBe(s0); // index -1 is already the base view
  });

  test("truncates forward history like any navigation", () => {
    // A, B → back to A → pill click should drop B
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("b1", "b2") },
      { type: "BACK" },
      { type: "PUSH_BASE" },
    );
    expect(s.stack.map((x) => x?.start)).toEqual(["a1", undefined]);
    expect(currentWindow(s)).toBeNull();
    expect(canGoForward(s)).toBe(false);
  });

  test("a PUSH after PUSH_BASE extends the trail through the base entry", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH_BASE" },
      { type: "PUSH", window: w("b1", "b2") },
    );
    expect(s.stack.map((x) => x?.start)).toEqual(["a1", undefined, "b1"]);
    const back = windowHistoryReducer(s, { type: "BACK" });
    expect(currentWindow(back)).toBeNull(); // base view sits between the two zooms
  });
});

describe("RESET", () => {
  test("clears a populated stack back to the base", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "PUSH", window: w("b1", "b2") },
      { type: "RESET" },
    );
    expect(s).toEqual(initialWindowHistory);
    expect(currentWindow(s)).toBeNull();
  });

  test("clears even when parked mid-history (stack still populated)", () => {
    const s = run(
      { type: "PUSH", window: w("a1", "a2") },
      { type: "BACK" }, // index -1 but stack still holds A
      { type: "RESET" },
    );
    expect(s.stack).toHaveLength(0);
    expect(s.index).toBe(-1);
  });

  test("is a no-op when already at the fresh base", () => {
    const s = windowHistoryReducer(initialWindowHistory, { type: "RESET" });
    expect(s).toBe(initialWindowHistory);
  });
});
