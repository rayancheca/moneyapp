import { describe, expect, it, vi } from "vitest";

/**
 * The two pure halves of the action runner. `useAction` itself is React and is
 * covered by e2e (no jsdom in this project), but the parts that decide whether
 * a call failed and whether a run still owns the UI are plain functions — and
 * they are exactly where the silent-failure bug lived.
 */

// the hook module imports the toast store for its default failure report; the
// pure exports under test never reach it
vi.mock("@/components/ui/Toast", () => ({ toast: vi.fn() }));

const { ACTION_FAILED, createRunGuard, settleAction } = await import("./useAction");

describe("settleAction", () => {
  it("passes a success straight through", async () => {
    const result = await settleAction(async () => ({ ok: true, data: 7 }) as const);
    expect(result).toEqual({ ok: true, data: 7 });
  });

  it("keeps the server's own message on a reported failure", async () => {
    const result = await settleAction(async () => ({ ok: false, error: "Rule not found" }) as const);
    expect(result).toEqual({ ok: false, error: "Rule not found" });
  });

  it("turns a REJECTED call into a failure instead of silence", async () => {
    const result = await settleAction(async () => {
      throw new Error("Failed to fetch");
    });
    expect(result).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("treats a synchronous throw as a failure too", async () => {
    const result = await settleAction(() => {
      throw new Error("boom");
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("falls back when the rejection carries nothing readable", async () => {
    const nonError = await settleAction(async () => Promise.reject("nope"));
    const blank = await settleAction(async () => {
      throw new Error("   ");
    });
    expect(nonError).toEqual({ ok: false, error: ACTION_FAILED });
    expect(blank).toEqual({ ok: false, error: ACTION_FAILED });
  });

  it("falls back when the server reports a blank error", async () => {
    const result = await settleAction(async () => ({ ok: false, error: "" }) as const);
    expect(result).toEqual({ ok: false, error: ACTION_FAILED });
  });

  it("uses the caller's fallback wording", async () => {
    const result = await settleAction(async () => {
      throw new Error();
    }, "Couldn’t undo that");
    expect(result).toEqual({ ok: false, error: "Couldn’t undo that" });
  });
});

describe("createRunGuard", () => {
  it("keeps a lone run latest", () => {
    const isLatest = createRunGuard().begin();
    expect(isLatest()).toBe(true);
  });

  it("lets a later run supersede an earlier one, never the reverse", () => {
    const guard = createRunGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("gives each hook instance its own generations", () => {
    const a = createRunGuard();
    const b = createRunGuard();
    const runA = a.begin();
    b.begin();
    // b starting a run must not supersede a's
    expect(runA()).toBe(true);
  });
});
