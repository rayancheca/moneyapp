import { describe, expect, test } from "vitest";
import { numberRollSlots } from "./number-roll";

function chars(prev: string | null, next: string): string[] {
  return numberRollSlots(prev, next).map((s) => s.char);
}

function changedFlags(prev: string | null, next: string): boolean[] {
  return numberRollSlots(prev, next).map((s) => s.changed);
}

describe("first render (prev null)", () => {
  test("every slot is unchanged so nothing animates on mount", () => {
    const slots = numberRollSlots(null, "$1,234.56");
    expect(slots.every((s) => !s.changed)).toBe(true);
    expect(chars(null, "$1,234.56")).toEqual(["$", "1", ",", "2", "3", "4", ".", "5", "6"]);
  });

  test("digit detection covers $ , . - and digits", () => {
    const slots = numberRollSlots(null, "-$1,0.2");
    expect(slots.map((s) => s.isDigit)).toEqual([false, false, true, false, true, false, true]);
  });
});

describe("diffing against a previous value", () => {
  test("identical values mark nothing changed", () => {
    expect(changedFlags("$43.64", "$43.64")).toEqual([false, false, false, false, false, false]);
  });

  test("a single digit change marks only that slot", () => {
    expect(changedFlags("$1,234.56", "$1,234.57")).toEqual([
      false, false, false, false, false, false, false, false, true,
    ]);
  });

  test("alignment is right-to-left when the value grows a digit", () => {
    // $99.99 → $100.00: the new leading '1' aligns against prev '$'
    const slots = numberRollSlots("$99.99", "$100.00");
    expect(slots.map((s) => s.char)).toEqual(["$", "1", "0", "0", ".", "0", "0"]);
    expect(slots.map((s) => s.changed)).toEqual([false, true, true, true, false, true, true]);
  });

  test("a digit slot with no prev counterpart counts as changed", () => {
    // prev "999" right-aligns under ",000" — the leading '1' has no prev char
    expect(changedFlags("999", "1,000")).toEqual([true, false, true, true, true]);
  });

  test("shrinking drops the prev value's extra leading chars", () => {
    const slots = numberRollSlots("$100.00", "$99.99");
    expect(slots).toHaveLength(6);
    expect(slots.map((s) => s.changed)).toEqual([false, true, true, false, true, true]);
  });

  test("non-digit slots are never marked changed, even when they differ", () => {
    expect(changedFlags("+$5.00", "-$5.00")).toEqual([false, false, false, false, false, false]);
  });

  test("empty prev string still marks incoming digits changed", () => {
    expect(changedFlags("", "5")).toEqual([true]);
  });

  test("empty next produces no slots", () => {
    expect(numberRollSlots("$1.00", "")).toEqual([]);
    expect(numberRollSlots(null, "")).toEqual([]);
  });
});
