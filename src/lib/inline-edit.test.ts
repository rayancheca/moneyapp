import { describe, expect, it } from "vitest";
import {
  IDLE,
  inlineEditReducer,
  keyToIntent,
  resolveAmountCommit,
  resolveDateCommit,
  resolveTextCommit,
} from "./inline-edit";

describe("inlineEditReducer", () => {
  it("begins editing with the current value as the draft", () => {
    expect(inlineEditReducer(IDLE, { type: "begin", value: "Chase" })).toEqual({
      editing: true,
      draft: "Chase",
    });
  });

  it("updates the draft only while editing", () => {
    const editing = inlineEditReducer(IDLE, { type: "begin", value: "a" });
    expect(inlineEditReducer(editing, { type: "change", draft: "ab" })).toEqual({
      editing: true,
      draft: "ab",
    });
  });

  it("ignores a change while idle (no phantom draft)", () => {
    expect(inlineEditReducer(IDLE, { type: "change", draft: "x" })).toEqual(IDLE);
  });

  it("closes back to idle", () => {
    const editing = inlineEditReducer(IDLE, { type: "begin", value: "a" });
    expect(inlineEditReducer(editing, { type: "close" })).toEqual(IDLE);
  });

  it("returns the state unchanged for an unknown action (defensive default)", () => {
    const editing = inlineEditReducer(IDLE, { type: "begin", value: "a" });
    // a bogus action never happens under the types, but the reducer must not throw
    expect(inlineEditReducer(editing, { type: "bogus" } as unknown as never)).toBe(editing);
  });
});

describe("keyToIntent", () => {
  it("maps Enter to commit and Escape to cancel", () => {
    expect(keyToIntent("Enter")).toBe("commit");
    expect(keyToIntent("Escape")).toBe("cancel");
  });
  it("ignores every other key", () => {
    expect(keyToIntent("a")).toBeNull();
    expect(keyToIntent("Tab")).toBeNull();
    expect(keyToIntent(" ")).toBeNull();
  });
});

describe("resolveTextCommit", () => {
  it("saves a changed value, trimmed", () => {
    expect(resolveTextCommit("Chase", "  Chase Checking  ")).toEqual({
      kind: "save",
      value: "Chase Checking",
    });
  });

  it("is a no-op when unchanged (ignoring surrounding whitespace)", () => {
    expect(resolveTextCommit("Chase", "Chase")).toEqual({ kind: "noop" });
    expect(resolveTextCommit("Chase", "  Chase ")).toEqual({ kind: "noop" });
  });

  it("treats blanking a required field as a silent no-op, never saving empty", () => {
    expect(resolveTextCommit("Chase", "")).toEqual({ kind: "noop" });
    expect(resolveTextCommit("Chase", "   ")).toEqual({ kind: "noop" });
  });

  it("allows clearing an optional field, but no-ops if it was already empty", () => {
    expect(resolveTextCommit("note", "", { required: false })).toEqual({ kind: "save", value: "" });
    expect(resolveTextCommit("", "", { required: false })).toEqual({ kind: "noop" });
    // a whitespace-only original is "already empty" — clearing it is a no-op, not a save
    expect(resolveTextCommit("   ", "", { required: false })).toEqual({ kind: "noop" });
  });

  it("rejects a draft past maxLength", () => {
    const out = resolveTextCommit("a", "abcdef", { maxLength: 3 });
    expect(out.kind).toBe("invalid");
  });

  it("saves a within-limit draft when maxLength is set", () => {
    expect(resolveTextCommit("a", "abc", { maxLength: 3 })).toEqual({ kind: "save", value: "abc" });
  });
});

describe("resolveAmountCommit", () => {
  it("parses formatted money and saves integer cents when changed", () => {
    expect(resolveAmountCommit(0, "$1,234.56")).toEqual({ kind: "save", value: 123456 });
    expect(resolveAmountCommit(0, "(5)")).toEqual({ kind: "save", value: -500 });
    expect(resolveAmountCommit(0, "12.5")).toEqual({ kind: "save", value: 1250 });
  });

  it("is a no-op when the parsed cents equal the original (formatting differences ignored)", () => {
    expect(resolveAmountCommit(100000, "1000")).toEqual({ kind: "noop" });
    expect(resolveAmountCommit(100000, "$1,000.00")).toEqual({ kind: "noop" });
  });

  it("rejects an unparseable amount", () => {
    const out = resolveAmountCommit(0, "abc");
    expect(out.kind).toBe("invalid");
    expect(out).toHaveProperty("error");
  });
});

describe("resolveDateCommit", () => {
  it("saves a changed valid ISO date, trimming whitespace", () => {
    expect(resolveDateCommit("2026-07-01", " 2026-07-04 ")).toEqual({ kind: "save", value: "2026-07-04" });
  });

  it("treats blank and unchanged drafts as silent no-ops", () => {
    expect(resolveDateCommit("2026-07-01", "")).toEqual({ kind: "noop" });
    expect(resolveDateCommit("2026-07-01", "   ")).toEqual({ kind: "noop" });
    expect(resolveDateCommit("2026-07-01", "2026-07-01")).toEqual({ kind: "noop" });
  });

  it("rejects malformed and impossible dates", () => {
    for (const bad of ["07/04/2026", "2026-13-01", "2026-02-30", "yesterday"]) {
      const out = resolveDateCommit("2026-07-01", bad);
      expect(out.kind).toBe("invalid");
    }
  });
});
