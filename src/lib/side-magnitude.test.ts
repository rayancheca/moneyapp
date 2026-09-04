import { describe, expect, test } from "vitest";
import { balanceDeltaAccent, balanceHeading, sideMagnitudeCents } from "./side-magnitude";

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

describe("balanceHeading", () => {
  /*
   * ⛔ THE MEASURED CASE. /accounts/<Chase Sapphire> printed "AMOUNT OWED
   * -$82.72" in red, of a card the bank owed HIM $82.72 on. The terrain, the
   * cards card and the accounts table all said "in credit" about the same
   * balance on the same day.
   */
  test("a card in credit says so, and prints the credit", () => {
    expect(balanceHeading(8_272, true)).toEqual({
      label: "In credit",
      subject: "the credit",
      cents: 8_272,
      isAgainstYou: false,
    });
  });

  test("a card that owes prints what it owes", () => {
    expect(balanceHeading(-55_762, true)).toEqual({
      label: "Amount owed",
      subject: "the amount owed",
      cents: 55_762,
      isAgainstYou: true,
    });
  });

  /* ⚠️ `-0` formats as "-$0.00": a card owing nothing, printed as owing a
     negative amount. Found the moment this function was first tested. */
  test("a card at zero owes nothing, and does not print a negative zero", () => {
    const zero = balanceHeading(0, true);
    expect(zero).toEqual({
      label: "Amount owed",
      subject: "the amount owed",
      cents: 0,
      isAgainstYou: false,
    });
    expect(Object.is(zero.cents, -0)).toBe(false);
  });

  /* ⛔ An OVERDRAWN asset account is a debt, not a credit — the mirror of the
     refusal `sideMagnitudeCents` makes on the held side. */
  test("an overdrawn account keeps the plain label and reads as money against you", () => {
    expect(balanceHeading(-4_200, false)).toEqual({
      label: "Balance",
      subject: "this balance",
      cents: -4_200,
      isAgainstYou: true,
    });
  });

  test("an account holding money is neither", () => {
    expect(balanceHeading(300_760, false)).toEqual({
      label: "Balance",
      subject: "this balance",
      cents: 300_760,
      isAgainstYou: false,
    });
  });

  /*
   * ⛔ THE SUBJECT IS A NOUN PHRASE, NOT THE LABEL LOWERCASED. Given
   * `label.toLowerCase()`, the provenance popover read "How amount owed is
   * proven" — caught by the accessible-name assertion in
   * `e2e/provenance.spec.ts`, which is the only place that sentence is
   * assembled.
   */
  test("every subject reads as a noun phrase inside a sentence", () => {
    for (const [cents, liability] of [
      [8_272, true],
      [-55_762, true],
      [0, true],
      [300_760, false],
      [-4_200, false],
    ] as const) {
      const { subject } = balanceHeading(cents, liability);
      expect(`How ${subject} is proven`).toMatch(/^How (this balance|the amount owed|the credit) is proven$/);
    }
  });
});

describe("balanceDeltaAccent", () => {
  /*
   * ⛔ THE WHOLE POINT. `/accounts/<Discover>` on 2026-09-04, under a heading
   * reading "Amount owed $557.62": the chip said "30 days +$119.27" in red and
   * the chart forty pixels below said "▲ +$557.62 · 3M" in green, of the same
   * debt growing.
   */
  test("a debt that GREW is a loss, not a gain", () => {
    expect(balanceDeltaAccent(55_762, true)).toBe("loss");
  });

  test("a debt PAID DOWN is a gain", () => {
    // Venture X, 3M to 2026-09-04: -$1,869.30 in the owed frame, and green
    expect(balanceDeltaAccent(-186_930, true)).toBe("gain");
  });

  test("an account that grew is a gain, and one that fell is a loss", () => {
    expect(balanceDeltaAccent(200_991, false)).toBe("gain");
    expect(balanceDeltaAccent(-223_709, false)).toBe("loss");
  });

  test("no movement is flat on either side", () => {
    expect(balanceDeltaAccent(0, false)).toBe("flat");
    expect(balanceDeltaAccent(0, true)).toBe("flat");
  });

  /*
   * ⚠️ The frame is the LIABILITY's, not the sign of the balance it came from.
   * An overdrawn checking account is still an asset: it falling further is a
   * loss, exactly as it is when it is in the black.
   */
  test("an overdrawn asset account keeps the asset rule", () => {
    expect(balanceDeltaAccent(-4_200, false)).toBe("loss");
  });
});
