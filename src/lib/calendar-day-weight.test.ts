import { describe, expect, test } from "vitest";
import { dayWeight, heaviestDayCents, MIN_VISIBLE_WEIGHT, type WeighableEntry } from "./calendar-day-weight";

const e = (amountCents: number, state: WeighableEntry["state"] = "upcoming"): WeighableEntry => ({
  amountCents,
  state,
});

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
