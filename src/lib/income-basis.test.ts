import { describe, expect, test } from "vitest";
import type { Cadence } from "@/db/schema/recurring";
import { CADENCES } from "@/db/schema/recurring";
import { BUDGET_JARGON } from "./jargon";
import { incomeBasis, levelledMonthlyCents, OCCURRENCES_PER_YEAR } from "./income-basis";

describe("OCCURRENCES_PER_YEAR", () => {
  test("covers every cadence the schema can store", () => {
    // A missing entry is `undefined` at runtime and NaN cents on the page —
    // silently, because arithmetic on undefined does not throw.
    expect(Object.keys(OCCURRENCES_PER_YEAR).sort()).toEqual([...CADENCES].sort());
  });

  test("every count is a whole number of payments a year", () => {
    // The whole point of a levelled basis is that it does not move month to
    // month. A fractional count (365.2425 ÷ 7 = 52.18) would make the figure
    // depend on which year it was asked about.
    for (const c of CADENCES) {
      expect(Number.isInteger(OCCURRENCES_PER_YEAR[c]), c).toBe(true);
      expect(OCCURRENCES_PER_YEAR[c], c).toBeGreaterThan(0);
    }
  });

  test("the counts are ordered from most to least frequent", () => {
    const order: Cadence[] = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual"];
    const counts = order.map((c) => OCCURRENCES_PER_YEAR[c]);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});

describe("levelledMonthlyCents", () => {
  test("the owner's weekly wage lands on the base his budgets were sized from", () => {
    // $1,047.00 × 52 ÷ 12 = $4,537.00 — docs/HANDOFF-2026-08-21-pass60.md §1.5.
    // If this moves, the /budgets header stops agreeing with the budgets on it.
    expect(levelledMonthlyCents(104_700, "weekly")).toBe(453_700);
  });

  test("a monthly series levels to itself", () => {
    expect(levelledMonthlyCents(228_570, "monthly")).toBe(228_570);
  });

  test("biweekly is twenty-six payments, not twenty-four", () => {
    // The trap this pins: two payments a month is 24 a year, which loses two
    // whole paycheques. $762.14 × 26 ÷ 12 = $1,651.30.
    expect(levelledMonthlyCents(76_214, "biweekly")).toBe(165_130);
  });

  test("semimonthly is twenty-four and does level to twice the amount", () => {
    expect(levelledMonthlyCents(50_000, "semimonthly")).toBe(100_000);
  });

  test("an annual payment spreads across twelve months", () => {
    expect(levelledMonthlyCents(1_200_000, "annual")).toBe(100_000);
  });

  test("quarterly is four payments a year", () => {
    expect(levelledMonthlyCents(30_000, "quarterly")).toBe(10_000);
  });

  test("a fractional cent rounds to NEAREST, and the rule is pinned in both directions", () => {
    /*
     * Found by mutation: `Math.round` -> `Math.floor` survived the entire suite,
     * because $1,047.00 x 52 / 12 is exactly $4,537.00 and every other case here
     * only checked integer-ness. A rule nothing can distinguish is a rule the
     * next reader is free to change.
     */
    // $1,047.02 weekly = 453,708.67 cents: round 453,709, floor would give 453,708
    expect(levelledMonthlyCents(104_702, "weekly")).toBe(453_709);
    // exactly .5 rounds up, which is what Math.round does and what a reader expects
    expect(levelledMonthlyCents(50_001, "biweekly")).toBe(108_336);
    // and downward, so `Math.ceil` cannot pass either
    expect(levelledMonthlyCents(104_701, "weekly")).toBe(453_704);
  });

  test("always returns an integer number of cents", () => {
    // formatCents asserts an integer input, so a fractional cent is a thrown
    // error on the page rather than a rounding nit.
    for (const c of CADENCES) {
      expect(Number.isInteger(levelledMonthlyCents(104_701, c)), c).toBe(true);
    }
  });

  test("zero levels to zero for every cadence", () => {
    for (const c of CADENCES) expect(levelledMonthlyCents(0, c), c).toBe(0);
  });
});

const input = {
  levelledCents: 453_700,
  postedCents: 0,
  scheduledCents: 418_800,
  scheduledOccurrences: 4,
  measuredCents: 418_800,
};

describe("incomeBasis — which figure budgets are graded against", () => {
  test("with a live series it grades against the levelled figure, not the calendar month", () => {
    const got = incomeBasis(input);
    expect(got.kind).toBe("levelled");
    expect(got.cents).toBe(453_700);
  });

  test("the month delta is the levelled figure minus what the month is scheduled to pay", () => {
    // $4,537.00 − $4,188.00 = $349.00. This is NOT the over-allocation figure:
    // that one compares budgets to income, this compares two income readings.
    expect(incomeBasis(input).monthDeltaCents).toBe(34_900);
  });

  test("a four-payday month reads under the annualised figure", () => {
    const note = incomeBasis(input).monthNote;
    expect(note).toContain("4 paydays fall in this month");
    expect(note).toContain("$4,188.00");
    expect(note).toContain("$349.00 under");
  });

  test("a five-payday month reads over it, by the amount of one extra payday", () => {
    const got = incomeBasis({ ...input, scheduledCents: 523_500, scheduledOccurrences: 5 });
    // 5 × $1,047.00 = $5,235.00, and $5,235.00 − $4,537.00 = $698.00.
    expect(got.monthDeltaCents).toBe(-69_800);
    expect(got.monthNote).toContain("5 paydays fall in this month");
    expect(got.monthNote).toContain("$698.00 over");
  });

  test("a month that matches the annualised figure says so rather than stating a zero", () => {
    // "$0.00 under" is the kind of line that reads as a bug.
    const got = incomeBasis({ ...input, scheduledCents: 453_700, scheduledOccurrences: 4 });
    expect(got.monthDeltaCents).toBe(0);
    expect(got.monthNote).toContain("exactly the annualised figure");
    expect(got.monthNote).not.toContain("under");
    expect(got.monthNote).not.toContain("over");
  });

  test("one payday is singular", () => {
    const got = incomeBasis({ ...input, scheduledCents: 104_700, scheduledOccurrences: 1 });
    expect(got.monthNote).toContain("1 payday falls in this month");
  });

  test("a month with no payday at all says that, and states no amount", () => {
    // Reachable: a quarterly or annual income series pays in one month of
    // several. "0 paydays fall in this month, scheduled at $0.00" invites the
    // reader to think the schedule broke.
    const got = incomeBasis({ ...input, scheduledCents: 0, scheduledOccurrences: 0 });
    expect(got.kind).toBe("levelled");
    expect(got.cents).toBe(453_700);
    expect(got.monthNote).toContain("No payday falls in this month");
    expect(got.monthNote).not.toContain("$0.00");
  });

  test("a rate is never published BELOW what the window already measured", () => {
    /*
     * The defect this pins, reproduced against a seeded ledger: $5,000.00 of
     * salary posts, the detector picks up a $0.14-a-month interest series, and
     * the header reads "$0.14 expected income" — a measured near-zero asserted
     * over real, banked, reconciled money, with every budget on the page
     * screaming over-allocated behind it.
     *
     * The old `max(posted + still-due, whole-period forecast)` was the guard
     * against exactly this and the levelled branch had dropped it.
     */
    const got = incomeBasis({ ...input, levelledCents: 14, postedCents: 500_000 });
    expect(got.kind).toBe("banked");
    expect(got.cents).toBe(500_000);
  });

  test("the floor is what ARRIVED, never what is scheduled — that is what keeps the figure still", () => {
    // The swing being cured is projection-driven: a five-payday month schedules
    // $5,235.00 against a $4,537.00 rate. Flooring on the schedule would hand
    // the swing straight back, so only posted money can raise the basis.
    const fivePayday = incomeBasis({
      ...input,
      scheduledCents: 523_500,
      scheduledOccurrences: 5,
      measuredCents: 523_500,
    });
    expect(fivePayday.kind).toBe("levelled");
    expect(fivePayday.cents).toBe(453_700);
  });

  test("posted money EQUAL to the rate leaves the rate in charge", () => {
    // The boundary. `>` not `>=`, so a month that banks exactly the rate is
    // still described as a rate — which is what it is.
    const got = incomeBasis({ ...input, postedCents: 453_700 });
    expect(got.kind).toBe("levelled");
    expect(got.cents).toBe(453_700);
  });

  test("the banked state still counts the paydays, but claims no comparison", () => {
    // The figure above is no longer the annualised one, so a note ending "under
    // the annualised figure above" would be describing something that is not
    // there. The count is still worth having.
    const got = incomeBasis({ ...input, levelledCents: 14, postedCents: 500_000 });
    expect(got.monthNote).toContain("4 paydays fall in this month");
    expect(got.monthNote).toContain("$4,188.00");
    expect(got.monthNote).not.toContain("annualised figure above");
    expect(got.monthDeltaCents).toBe(0);
  });

  test("each kind names what an over-allocated plan actually outran", () => {
    /*
     * Confirmed defect, reproduced twice against the real database: the page
     * hard-coded "these budgets total more than this month is expected to bring
     * in" while grading against the annualised rate. In the four five-payday
     * months a year the month brings in MORE than the budgets, so the clause
     * stated the reverse of the note printed directly beneath it.
     */
    const levelled = incomeBasis(input);
    expect(levelled.overAllocatedClause).not.toContain("this month");
    expect(levelled.overAllocatedClause).toContain("twelve");

    const banked = incomeBasis({ ...input, levelledCents: 14, postedCents: 500_000 });
    expect(banked.overAllocatedClause).not.toContain("this month");

    const calendar = incomeBasis({ ...input, levelledCents: 0 });
    expect(calendar.overAllocatedClause).toContain("this month");

    // three kinds, three clauses — none of them shared
    const clauses = [levelled, banked, calendar].map((b) => b.overAllocatedClause);
    expect(new Set(clauses).size).toBe(3);
  });

  test("with nothing to level it falls back to the measured month and stays silent", () => {
    // No live income series at all. There is no plan to be under or over, so
    // the note would be describing something the page is not doing.
    const got = incomeBasis({ ...input, levelledCents: 0, measuredCents: 690_000 });
    expect(got.kind).toBe("calendar");
    expect(got.cents).toBe(690_000);
    expect(got.monthDeltaCents).toBe(0);
    expect(got.monthNote).toBeNull();
  });

  test("a negative levelled total is treated as nothing to level", () => {
    // Defence in depth: the service filters non-positive amounts, and if that
    // filter is ever weakened this must not publish a negative income basis.
    const got = incomeBasis({ ...input, levelledCents: -1, measuredCents: 418_800 });
    expect(got.kind).toBe("calendar");
    expect(got.cents).toBe(418_800);
  });

  test("each basis carries the definition of the figure it chose", () => {
    // The drift this prevents: a header showing an annualised rate above a
    // tooltip describing posted-plus-still-due. Both branches were previously
    // one tooltip, mounted unconditionally.
    expect(incomeBasis(input).explanation).toBe(BUDGET_JARGON.expectedIncomeLevelled);
    expect(incomeBasis({ ...input, levelledCents: 14, postedCents: 500_000 }).explanation).toBe(
      BUDGET_JARGON.expectedIncomeBanked,
    );
    expect(incomeBasis({ ...input, levelledCents: 0 }).explanation).toBe(
      BUDGET_JARGON.expectedIncomeCalendar,
    );
    const bodies = [
      BUDGET_JARGON.expectedIncomeLevelled,
      BUDGET_JARGON.expectedIncomeBanked,
      BUDGET_JARGON.expectedIncomeCalendar,
    ];
    expect(new Set(bodies).size).toBe(3);
  });

  test("the note never repeats the term the header already owns", () => {
    // "expected income" is read by an exact-count e2e locator on this very
    // page — see RESERVED_JARGON_PHRASES.
    for (const occ of [0, 1, 4, 5]) {
      const note = incomeBasis({ ...input, scheduledOccurrences: occ, scheduledCents: occ * 104_700 })
        .monthNote;
      expect(note ?? "").not.toContain("expected income");
      expect(note ?? "").not.toContain("left to allocate");
      expect(note ?? "").not.toContain("Over-allocated by");
    }
  });
});
