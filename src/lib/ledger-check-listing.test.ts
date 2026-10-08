import { describe, expect, test } from "vitest";
import { listed } from "./ledger-check-listing";

/** The shape the pre-commit hook knows a listing by (scripts/pre-commit-hook.test.ts runs the hook on it). */
describe("a line ledger-check names and fails nothing on", () => {
  test("two spaces, its tag in brackets, its sentence", () => {
    expect(listed("line-left-out, acknowledged", "+$25.00 on 2026-07-01")).toBe("  [line-left-out, acknowledged] +$25.00 on 2026-07-01");
  });

  test("⚠️ before the tag where it warns", () => {
    expect(listed("read at two banks", "x.pdf reads accounts at Robinhood and SoFi", { warns: true })).toBe(
      "  ⚠️ [read at two banks] x.pdf reads accounts at Robinhood and SoFi",
    );
  });
});
