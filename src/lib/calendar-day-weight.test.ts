import { describe, expect, test } from "vitest";
import {
  compactDayAmount,
  compactDayTotal,
  dayTotalCents,
  dayWeight,
  heaviestDayCents,
  MIN_VISIBLE_WEIGHT,
  type WeighableEntry,
} from "./calendar-day-weight";

const e = (
  amountCents: number,
  state: WeighableEntry["state"] = "upcoming",
  name = "Some series",
): WeighableEntry => ({ amountCents, settledCents: null, state, name });

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

/**
 * 🔴 A DAY'S FIGURE DREW ONE WEEK OF PAY TWICE (§6A 29 review).
 *
 * The figure is what the day's marks add to the month — the step the flow strip
 * takes that day, the share of the footer it holds (`flowEntryOf`). It summed
 * each mark's AMOUNT instead, and once a payday could be drawn beside a deposit
 * of its own series that counted a week twice: his Sep 24, read 2026-10-01 —
 * the deposit dated Sep 24, whose money paid Aug 20, beside the Sep 24 payday
 * the lump of Sep 23 paid — read "2.3k" on a day that adds nothing to September.
 */
describe("a day's figure is what its marks add to the month", () => {
  const PAY = "It America LLC (weekly pay)";
  const mark = (amountCents: number, settledCents: number | null, name = PAY): WeighableEntry => ({
    amountCents,
    settledCents,
    state: settledCents === null ? "upcoming" : "paid",
    name,
  });
  const sep24 = [mark(114192, 0), mark(114192, 0)];

  test("his Sep 24 — a deposit whose money paid August, and a payday paid on Sep 23 — adds nothing", () => {
    expect(dayWeight(sep24, 456768)!.netCents).toBe(0);
    expect(dayTotalCents(sep24)).toBe(0);
  });

  test("the scale is weighed by what each day adds, so a doubled week cannot set it", () => {
    expect(heaviestDayCents({ "2026-09-02": [mark(-150000, -150000, "Rent")], "2026-09-24": sep24 })).toBe(150000);
  });

  test("the day is named for the money it holds, not for a payday whose money is counted elsewhere", () => {
    // his Sep 10: Breezeline's $50.00 left that day; the payday's week is the lump's, on Sep 23
    const w = dayWeight([mark(114192, 0), mark(-5000, -5000, "Breezeline (internet)")], 456768)!;
    expect(w.netCents).toBe(-5000);
    expect(w.dominantName).toBe("Breezeline (internet)");
  });

  test("a payday paid from another month adds that money, and a mark not yet settled what it expects", () => {
    expect(dayTotalCents([mark(114192, 114192), mark(-499, null, "Amazon Prime")])).toBe(114192 - 499);
  });
});

/**
 * 🔴 S27. The /spending heatmap wrote its cell figure as `$${Math.round(dollars)}`,
 * so a day that earned 1–49¢ printed "+$0" over money that really came in.
 * Measured on the owner's ledger 2026-09-15: 20 cells across 50 months, every one
 * on the earned side — Sep 8 2025 "$260.01 spent …, $0.29 earned" read "−$260 +$0".
 * Its thousands tier tested the RAW value, so $999.50 printed "$1000" and
 * $9,999.99 printed "$10.0k", a sixth character in a five-character cell; no
 * day on either ledger reaches those bands yet.
 *
 * ⚖️ Owner decision 2026-09-14 (F3): under 50¢ prints "<$1", after renderPercent's
 * "<0.1%" floor; the cell's aria-label and the day sheet keep the exact cents.
 */
describe("compactDayAmount — the heatmap cell's figure", () => {
  test("a day under 50¢ prints <$1, never a printed zero", () => {
    expect(compactDayAmount(1)).toBe("<$1");
    expect(compactDayAmount(29)).toBe("<$1");
    expect(compactDayAmount(49)).toBe("<$1");
  });

  test("from 50¢ it rounds to whole dollars, the rule every calendar cell follows", () => {
    expect(compactDayAmount(50)).toBe("$1");
    expect(compactDayAmount(26_001)).toBe("$260");
    expect(compactDayAmount(99_949)).toBe("$999");
  });

  test("$999.50 is a thousand, and says so in thousands — not $1000", () => {
    expect(compactDayAmount(99_950)).toBe("$1.0k");
    expect(compactDayAmount(99_999)).toBe("$1.0k");
    expect(compactDayAmount(100_000)).toBe("$1.0k");
  });

  test("$9,950 and up is $10k — not $10.0k", () => {
    expect(compactDayAmount(994_999)).toBe("$9.9k");
    expect(compactDayAmount(995_000)).toBe("$10k");
    expect(compactDayAmount(999_999)).toBe("$10k");
    expect(compactDayAmount(1_000_000)).toBe("$10k");
  });

  test("never wider than five characters, across compactDayTotal's own range", () => {
    // the same ceiling `compactDayTotal`'s width test holds to — the ledger's largest day is ~$29,800
    const amounts = [1, 49, 50, 99_949, 99_950, 99_999, 994_999, 995_000, 999_999, 9_949_999, 99_949_999, 99_950_000, 100_000_000];
    const tooWide = amounts
      .map((c) => compactDayAmount(c))
      .filter((s) => s.length > 5)
      .map((s) => `${s} (${s.length})`);
    expect(tooWide).toEqual([]);
  });
});

describe("compactDayTotal", () => {
  test("drops the cents — this is a magnitude, not a figure", () => {
    expect(compactDayTotal(-12500)).toBe("-125");
    expect(compactDayTotal(-1599)).toBe("-16");
    expect(compactDayTotal(0)).toBe("0");
    expect(compactDayTotal(320000)).toBe("3.2k");
  });

  test("spends its one decimal only below $10k, where it distinguishes bills", () => {
    expect(compactDayTotal(-180000)).toBe("-1.8k"); // $1,800 rent
    expect(compactDayTotal(-120000)).toBe("-1.2k"); // …is not $1,200
    expect(compactDayTotal(-2980000)).toBe("-30k"); // $29,800 — magnitude is enough
  });

  /*
   * THE regression. A 320px cell fits about five characters, and the first
   * version always used one decimal in the thousands. The e2e fixture's widest
   * value is "-1.8k", so it fit and every test passed — while the largest amount
   * in the owner's real ledger, $29,800, would have rendered "-29.8k" and
   * overflowed the cell on his own data. The fixture could never have shown it.
   */
  test("never exceeds five characters, at any amount the ledger can hold", () => {
    const amounts = [
      0, 1, -1, 99999, -99999, 100000, -100000, 999499, -999499, 999500, 998900,
      -998900, 999000, 1000000, -1000000, 2980000, -2980000, 99999999, -99999999,
      99949999, 99950000, -99950000, 100000000, -100000000,
    ];
    const tooWide = amounts
      .map((c) => compactDayTotal(c))
      .filter((s) => s.length > 5)
      .map((s) => `${s} (${s.length})`);
    expect(tooWide).toEqual([]);
  });

  test("the tier boundary is the ROUNDED value, so $9,989 does not become 10.0k", () => {
    // 9989/1000 = 9.989 → toFixed(1) = "10.0", which would have been a sixth character
    expect(compactDayTotal(-998900)).toBe("-10k");
    expect(compactDayTotal(-994900)).toBe("-9.9k");
    // …and the same trap one tier down: $999.60 must not print as "1000"
    expect(compactDayTotal(-99960)).toBe("-1.0k");
    expect(compactDayTotal(-99940)).toBe("-999");
  });

  test("millions stay readable rather than becoming a wall of k", () => {
    expect(compactDayTotal(100000000)).toBe("1.0M");
    expect(compactDayTotal(-250000000)).toBe("-2.5M");
  });
});

describe("dayWeight confidence", () => {
  test("a day with no forecast on it carries no confidence", () => {
    expect(
      dayWeight([{ amountCents: -1549, settledCents: -1549, state: "paid", name: "Netflix" }], 1549)!.confidence,
    ).toBeNull();
  });

  test("takes the LEAST confident forecast on the day", () => {
    // One bar per day, so a signed lease sharing a square with a detector guess
    // must not lend the guess its certainty. Understating costs a second look;
    // overstating is the app vouching for something nobody agreed to.
    const w = dayWeight(
      [
        { amountCents: -55989, settledCents: null, state: "upcoming", name: "Car lease", confidence: "scheduled" },
        { amountCents: -1539, settledCents: null, state: "upcoming", name: "YA-FIT", confidence: "predicted" },
      ],
      55989,
    )!;
    expect(w.confidence).toBe("predicted");
  });

  test("order does not change the answer", () => {
    const entries = [
      { amountCents: -1539, settledCents: null, state: "upcoming" as const, name: "YA-FIT", confidence: "expected" as const },
      { amountCents: -55989, settledCents: null, state: "upcoming" as const, name: "Car lease", confidence: "scheduled" as const },
    ];
    expect(dayWeight(entries, 55989)!.confidence).toBe("expected");
    expect(dayWeight([...entries].reverse(), 55989)!.confidence).toBe("expected");
  });

  test("a settled entry beside a forecast does not erase the forecast's confidence", () => {
    const w = dayWeight(
      [
        { amountCents: -1549, settledCents: -1549, state: "paid", name: "Netflix", confidence: null },
        { amountCents: -600, settledCents: null, state: "upcoming", name: "Rocket Money", confidence: "predicted" },
      ],
      2149,
    )!;
    expect(w.confidence).toBe("predicted");
  });

  test("an unsettled day outranks upcoming and paid for the cell's colour", () => {
    // Attention order: a mark nobody can grade needs a look before one that
    // went exactly as expected, and after one that definitely failed.
    expect(
      dayWeight(
        [
          { amountCents: -1549, settledCents: -1549, state: "paid", name: "Netflix" },
          { amountCents: 104700, settledCents: null, state: "unsettled", name: "Cash job" },
        ],
        103151,
      )!.state,
    ).toBe("unsettled");
    expect(
      dayWeight(
        [
          { amountCents: -5000, settledCents: null, state: "missed", name: "Breezeline" },
          { amountCents: 104700, settledCents: null, state: "unsettled", name: "Cash job" },
        ],
        99700,
      )!.state,
    ).toBe("missed");
  });
});
