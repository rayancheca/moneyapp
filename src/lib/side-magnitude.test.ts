import { describe, expect, test } from "vitest";
import { sideMagnitudeCents } from "./side-magnitude";

describe("sideMagnitudeCents", () => {
  test("a card that owes weighs what it owes", () => {
    expect(sideMagnitudeCents(-55_762, true)).toBe(55_762);
  });

  /*
   * ⛔ THE WHOLE POINT. Chase Sapphire closed 2026-09-02 at $82.72 in credit.
   * `Math.abs` gave it 8.2% of a debt it is not part of, and inflated the
   * denominator every other card was divided by.
   */
  test("a card in CREDIT weighs nothing on the owed side", () => {
    expect(sideMagnitudeCents(8_272, true)).toBe(0);
  });

  test("an account holding money weighs what it holds", () => {
    expect(sideMagnitudeCents(300_760, false)).toBe(300_760);
  });

  test("an OVERDRAWN checking account weighs nothing on the held side", () => {
    expect(sideMagnitudeCents(-4_200, false)).toBe(0);
  });

  test("no balance and a zero balance both weigh nothing", () => {
    expect(sideMagnitudeCents(null, false)).toBe(0);
    expect(sideMagnitudeCents(null, true)).toBe(0);
    expect(sideMagnitudeCents(0, true)).toBe(0);
  });

  /*
   * The measured case, end to end: the two cards that owe share the $925.61
   * they owe between them, and the credit takes none of it.
   */
  test("the owner's three cards share the debt actually owed", () => {
    const cards = [-55_762, -36_799, 8_272];
    const total = cards.reduce((sum, c) => sum + sideMagnitudeCents(c, true), 0);
    expect(total).toBe(92_561);
    expect(Math.round((sideMagnitudeCents(-55_762, true) / total) * 1000) / 10).toBe(60.2);
    expect(Math.round((sideMagnitudeCents(-36_799, true) / total) * 1000) / 10).toBe(39.8);
    expect(sideMagnitudeCents(8_272, true) / total).toBe(0);
  });
});
