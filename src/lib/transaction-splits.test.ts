import { describe, expect, test } from "vitest";
import {
  MIN_SPLIT_LINES,
  allocationsFor,
  remainingCents,
  validateSplitDraft,
  type SplitDraftLine,
  type SplitRow,
} from "./transaction-splits";

const line = (amountCents: number, categoryId: string | null = "cat"): SplitDraftLine => ({
  amountCents,
  categoryId,
});

describe("remainingCents", () => {
  test("is the parent amount when there are no lines", () => {
    expect(remainingCents(-2_000, [])).toBe(-2_000);
  });

  test("is zero when lines sum exactly to the parent", () => {
    expect(remainingCents(-2_000, [line(-1_500), line(-500)])).toBe(0);
  });

  test("is the unallocated remainder when lines fall short", () => {
    // parent -2000, allocated -1500 → -500 still to allocate
    expect(remainingCents(-2_000, [line(-1_500)])).toBe(-500);
  });

  test("goes past zero (opposite sign) when lines overshoot", () => {
    expect(remainingCents(-2_000, [line(-1_500), line(-800)])).toBe(300);
  });
});

describe("validateSplitDraft", () => {
  test("accepts two same-sign parts that sum to a negative (expense) parent", () => {
    // Arrange: a $20 grocery run split $15 groceries + $5 household
    const result = validateSplitDraft(-2_000, [line(-1_500, "groceries"), line(-500, "household")]);
    // Assert
    expect(result.ok).toBe(true);
  });

  test("accepts the flagship same-sign, mixed-category positive split (Robert Cohn)", () => {
    // +$2,500 deposit = +$1,500 refund + +$1,000 bed sale
    const result = validateSplitDraft(250_000, [line(150_000, "refunds"), line(100_000, "other-income")]);
    expect(result.ok).toBe(true);
  });

  test("accepts three or more parts", () => {
    const result = validateSplitDraft(-3_000, [line(-1_000, "a"), line(-1_000, "b"), line(-1_000, "c")]);
    expect(result.ok).toBe(true);
  });

  test("rejects a $0.00 parent transaction", () => {
    const result = validateSplitDraft(0, [line(0, "a"), line(0, "b")]);
    expect(result).toMatchObject({ ok: false, error: "zero-parent" });
  });

  test("rejects fewer than the minimum number of parts", () => {
    expect(validateSplitDraft(-2_000, [line(-2_000)])).toMatchObject({
      ok: false,
      error: "too-few-lines",
    });
    expect(validateSplitDraft(-2_000, [])).toMatchObject({ ok: false, error: "too-few-lines" });
  });

  test("rejects a zero-amount part", () => {
    const result = validateSplitDraft(-2_000, [line(-2_000, "a"), line(0, "b")]);
    expect(result).toMatchObject({ ok: false, error: "zero-amount" });
  });

  test("rejects a part whose sign differs from the parent", () => {
    // parent negative, one part positive — parts still sum to -2000 but flip sign
    const result = validateSplitDraft(-2_000, [line(-3_000, "a"), line(1_000, "b")]);
    expect(result).toMatchObject({ ok: false, error: "sign-mismatch" });
  });

  test("rejects an uncategorized part", () => {
    const result = validateSplitDraft(-2_000, [line(-1_500, "a"), line(-500, null)]);
    expect(result).toMatchObject({ ok: false, error: "uncategorized-line" });
  });

  test("rejects parts that do not sum to the parent amount", () => {
    const result = validateSplitDraft(-2_000, [line(-1_500, "a"), line(-400, "b")]);
    expect(result).toMatchObject({ ok: false, error: "sum-mismatch" });
  });

  test("every rejection carries a human message", () => {
    const result = validateSplitDraft(-2_000, [line(-1_500, "a"), line(-400, "b")]);
    if (result.ok) throw new Error("expected failure");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("MIN_SPLIT_LINES is at least two", () => {
    expect(MIN_SPLIT_LINES).toBeGreaterThanOrEqual(2);
  });
});

describe("allocationsFor", () => {
  const split = (id: string, categoryId: string, amountCents: number): SplitRow => ({
    id,
    categoryId,
    amountCents,
  });

  test("yields a single whole-transaction allocation when unsplit", () => {
    const allocs = allocationsFor("groceries", -2_000, []);
    expect(allocs).toEqual([{ categoryId: "groceries", amountCents: -2_000, splitId: null }]);
  });

  test("carries a null parent category through as an uncategorized whole allocation", () => {
    const allocs = allocationsFor(null, -2_000, []);
    expect(allocs).toEqual([{ categoryId: null, amountCents: -2_000, splitId: null }]);
  });

  test("yields one allocation per split part, tagged with its split id", () => {
    const allocs = allocationsFor("groceries", -2_000, [
      split("s1", "groceries", -1_500),
      split("s2", "household", -500),
    ]);
    expect(allocs).toEqual([
      { categoryId: "groceries", amountCents: -1_500, splitId: "s1" },
      { categoryId: "household", amountCents: -500, splitId: "s2" },
    ]);
  });

  test("ignores the parent category once splits exist", () => {
    // parent categoryId is a stale 'primary' — must NOT leak into allocations
    const allocs = allocationsFor("stale-primary", 250_000, [
      split("s1", "refunds", 150_000),
      split("s2", "other-income", 100_000),
    ]);
    expect(allocs.map((a) => a.categoryId)).toEqual(["refunds", "other-income"]);
  });
});
