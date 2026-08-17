import { describe, expect, test } from "vitest";
import { dayWeight, heaviestDayCents, MIN_VISIBLE_WEIGHT, type WeighableEntry } from "./calendar-day-weight";

const e = (
  amountCents: number,
  state: WeighableEntry["state"] = "upcoming",
  name = "Some series",
): WeighableEntry => ({ amountCents, state, name });

describe("heaviestDayCents", () => {
  test("takes the largest absolute NET, not the largest single entry", () => {
    // rent out and a paycheque in is a QUIET day; calling it the month's
    // heaviest would misreport where the money went
    expect(
      heaviestDayCents({
        "2026-09-01": [e(-228570), e(104600)],
        "2026-09-10": [e(-5000)],
      }),
    ).toBe(228570 - 104600);
  });

  test("an empty month has no heaviest day", () => {
    expect(heaviestDayCents({})).toBe(0);
  });

  test("ignores the sign", () => {
    expect(heaviestDayCents({ "2026-09-03": [e(104600)] })).toBe(104600);
  });
});

describe("dayWeight", () => {
  const HEAVIEST = 228570;

  test("a day with no entries stays empty", () => {
    expect(dayWeight(undefined, HEAVIEST)).toBeNull();
    expect(dayWeight([], HEAVIEST)).toBeNull();
  });

  test("the heaviest day fills the bar", () => {
    expect(dayWeight([e(-228570)], HEAVIEST)!.weight).toBe(1);
  });

  test("a small charge against rent is a hairline, not an equal tick", () => {
    // THE point of the whole module: $4.99 and $2,285.70 used to draw identically
    const light = dayWeight([e(-499)], HEAVIEST)!;
    const heavy = dayWeight([e(-228570)], HEAVIEST)!;
    expect(light.weight).toBeLessThan(heavy.weight / 10);
  });

  test("nothing is ever invisible — a day with activity always shows some bar", () => {
    expect(dayWeight([e(-1)], HEAVIEST)!.weight).toBe(MIN_VISIBLE_WEIGHT);
  });

  /*
   * The regression this scale exists for, taken from the e2e fixture as it
   * actually renders: a $3,200 paycheque is the month's heaviest day, and the
   * other three bills are 3.9%, 1.5% and 0.5% of it. Under the previous linear
   * scale all three fell under the 0.08 floor and drew the SAME bar — the grid
   * asserted that a $125 bill and a $15.99 one were the same size.
   *
   * Strict ordering is the assertion; the exact values are pinned separately
   * below so a future scale change has to be deliberate rather than incidental.
   */
  test("bills far below the heaviest day stay distinguishable from each other", () => {
    const paycheck = 320000;
    const mealKit = dayWeight([e(-12500)], paycheck)!.weight;
    const gym = dayWeight([e(-4900)], paycheck)!.weight;
    const netflix = dayWeight([e(-1599)], paycheck)!.weight;

    expect(mealKit).toBeGreaterThan(gym);
    expect(gym).toBeGreaterThan(netflix);
    // …and none of them has collapsed onto the floor, which is what "distinct"
    // has to mean here — three values all equal to MIN would also be "ordered"
    // if the comparison were >=
    expect(netflix).toBeGreaterThan(MIN_VISIBLE_WEIGHT);
  });

  test("the bar is the square root of the linear share", () => {
    // 25% of the month's heaviest day draws at half length, not a quarter
    expect(dayWeight([e(-HEAVIEST / 4)], HEAVIEST)!.weight).toBeCloseTo(0.5, 10);
    expect(dayWeight([e(-HEAVIEST / 100)], HEAVIEST)!.weight).toBeCloseTo(0.1, 10);
  });

  test("names the largest entry, so a heavy day can say which bill it is", () => {
    const w = dayWeight(
      [e(-499, "upcoming", "Uber One"), e(-228570, "upcoming", "Rent"), e(-1599, "upcoming", "Netflix")],
      HEAVIEST,
    )!;
    expect(w.dominantName).toBe("Rent");
  });

  test("the dominant entry is by MAGNITUDE, so an incoming paycheque can own the day", () => {
    const w = dayWeight([e(-4900, "upcoming", "Gym"), e(320000, "upcoming", "Paycheck")], HEAVIEST)!;
    expect(w.dominantName).toBe("Paycheck");
  });

  test("a tie keeps the first entry, so the cell is deterministic", () => {
    const w = dayWeight([e(-5000, "upcoming", "Aaa"), e(-5000, "upcoming", "Bbb")], HEAVIEST)!;
    expect(w.dominantName).toBe("Aaa");
  });

  test("a day that nets to zero still shows, and prints the honest $0.00", () => {
    const w = dayWeight([e(-228570), e(228570)], HEAVIEST)!;
    expect(w.netCents).toBe(0);
    expect(w.weight).toBe(MIN_VISIBLE_WEIGHT);
  });

  test("weight never exceeds 1 even if the day beats the stated maximum", () => {
    expect(dayWeight([e(-999999)], HEAVIEST)!.weight).toBe(1);
  });

  test("an empty month cannot divide by zero", () => {
    expect(dayWeight([e(-499)], 0)!.weight).toBe(MIN_VISIBLE_WEIGHT);
  });

  test("the net is signed, so money in reads as money in", () => {
    expect(dayWeight([e(104600)], HEAVIEST)!.netCents).toBe(104600);
  });

  test("the day takes its MOST URGENT state, not its first or its last", () => {
    expect(dayWeight([e(-1, "paid"), e(-1, "missed"), e(-1, "upcoming")], HEAVIEST)!.state).toBe("missed");
    expect(dayWeight([e(-1, "paid"), e(-1, "paid_different")], HEAVIEST)!.state).toBe("paid_different");
    expect(dayWeight([e(-1, "paid"), e(-1, "upcoming")], HEAVIEST)!.state).toBe("upcoming");
    expect(dayWeight([e(-1, "paid"), e(-1, "paid")], HEAVIEST)!.state).toBe("paid");
  });

  test("counts the entries, so the cell can say there is more than one", () => {
    expect(dayWeight([e(-1), e(-2), e(-3)], HEAVIEST)!.count).toBe(3);
  });
});
