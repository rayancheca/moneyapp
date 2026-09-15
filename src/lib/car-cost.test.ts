import { describe, expect, test } from "vitest";
import { carCost, carEvidenceCaption, type CarCostInput } from "./car-cost";
import { committedOutflows, type CommittedOccurrence } from "./committed";

/**
 * The car, measured on the live ledger 2026-08-24.
 *
 * 🔴 **There is no post-car spending history to measure.** The program's brief
 * for this pass asked for "pre-car and post-car spend measured rather than
 * assumed", and the measurement says the second half does not exist: the Car
 * category holds exactly three rows, all in August 2026, and all of them predate
 * the first lease payment on 2026-09-11.
 *
 *   2026-08-11  −$5,000.00  Cash on Hand    Car lease down payment (cash)
 *   2026-08-12  −$1,100.00  Chase Checking  Mercedes Benz of Coral Gables
 *   2026-08-12    −$357.58  Venture X       PROGRESSIVE INS
 *
 * So this module forecasts from the REGISTERED COMMITMENTS and says so, rather
 * than extrapolating a running cost from three rows of buying the thing.
 *
 * ⚠️ Two disclosures the arithmetic must carry, both measured:
 *
 * 1. The insurance series ends 2027-01-11 — a six-month policy term, five
 *    payments left, and a renewal that is not in the ledger. Projecting the car
 *    as costing $559.89 from February would be false, so the evidenced end date
 *    is reported instead of assumed away.
 * 2. The first Progressive charge was $357.58; the registered series says
 *    $361.49. The $3.91 gap is real and is not silently reconciled here.
 */
const REAL: CarCostInput = {
  months: 12,
  // lease 12 × $559.89, insurance 5 × $361.49 (ends 2027-01-11)
  committedCents: 671868 + 180745,
  committedMonthlyCents: 55989 + 36149,
  upfrontCents: 500000 + 110000 + 35758,
  upfrontAmortisedOverMonths: 24, // the lease term, 2026-09-11 → 2028-08-11
  baselineMonthlySpendCents: 802592,
  evidencedThrough: "2027-01-11",
};

describe("carCost — the monthly figure", () => {
  test("the committed monthly cost is the lease plus the insurance", () => {
    expect(carCost(REAL).monthlyCents).toBe(92138);
  });

  test("upfront money is amortised over the lease term, and kept separate", () => {
    const c = carCost(REAL);
    expect(c.upfrontCents).toBe(645758);
    expect(c.upfrontMonthlyCents).toBe(26907); // 645758 / 24
    expect(c.allInMonthlyCents).toBe(92138 + 26907);
  });

  test("echoes the amortisation term back, so no caller re-derives it", () => {
    // The card printed `months * 2`, right only because 12 and 24 are in that
    // ratio. Changing the horizon must not silently change what the card claims.
    expect(carCost(REAL).upfrontAmortisedOverMonths).toBe(24);
    expect(carCost({ ...REAL, months: 6 }).upfrontAmortisedOverMonths).toBe(24);
  });

  test("the all-in figure is never quietly the same as the committed one", () => {
    const c = carCost(REAL);
    expect(c.allInMonthlyCents).toBeGreaterThan(c.monthlyCents);
  });

  test("with nothing paid upfront the two figures agree", () => {
    const c = carCost({ ...REAL, upfrontCents: 0 });
    expect(c.upfrontMonthlyCents).toBe(0);
    expect(c.allInMonthlyCents).toBe(c.monthlyCents);
  });
});

/**
 * The percentage is where a car card can most easily lie. "Y% of everything you
 * spend" has two defensible denominators and they differ by more than a point:
 * against the measured baseline alone the car is 11.5%, and against spending
 * WITH the car in it — which is what "everything you spend" means once you own
 * one — it is 10.3%. The module publishes the second and names its denominator,
 * so the figure cannot be read against the wrong one.
 */
describe("carCost — the share of spending", () => {
  test("the share is measured against spending WITH the car in it", () => {
    const c = carCost(REAL);
    expect(c.projectedMonthlySpendCents).toBe(802592 + 92138);
    expect(c.sharePct).toBeCloseTo(10.3, 1);
  });

  test("the all-in share is published beside it, on the same denominator basis", () => {
    const c = carCost(REAL);
    expect(c.allInProjectedMonthlySpendCents).toBe(802592 + 92138 + 26907);
    expect(c.allInSharePct).toBeCloseTo(12.92, 2);
  });

  test("a share can never exceed one hundred percent of the total it is part of", () => {
    const c = carCost({ ...REAL, baselineMonthlySpendCents: 0 });
    expect(c.sharePct).toBe(100);
    expect(c.allInSharePct).toBe(100);
  });

  test("with no car cost at all the share is zero, not a division by zero", () => {
    const c = carCost({
      ...REAL,
      committedCents: 0,
      committedMonthlyCents: 0,
      upfrontCents: 0,
      baselineMonthlySpendCents: 0,
    });
    expect(c.sharePct).toBe(0);
    expect(c.allInSharePct).toBe(0);
    expect(Number.isNaN(c.sharePct)).toBe(false);
  });

  test("a negative baseline cannot manufacture a share above one hundred", () => {
    const c = carCost({ ...REAL, baselineMonthlySpendCents: -100000 });
    expect(c.sharePct).toBeLessThanOrEqual(100);
    expect(c.sharePct).toBeGreaterThanOrEqual(0);
  });
});

describe("carCost — what it refuses to claim", () => {
  test("reports the date its evidence runs out rather than projecting past it", () => {
    expect(carCost(REAL).evidencedThrough).toBe("2027-01-11");
  });

  test("an open-ended commitment has no evidence horizon to disclose", () => {
    expect(carCost({ ...REAL, evidencedThrough: null }).evidencedThrough).toBeNull();
  });

  test("rejects a zero amortisation term rather than dividing by it", () => {
    expect(() => carCost({ ...REAL, upfrontAmortisedOverMonths: 0 })).toThrow(/months/i);
  });

  test("rejects a zero horizon rather than dividing by it", () => {
    expect(() => carCost({ ...REAL, months: 0 })).toThrow(/months/i);
  });

  test("the horizon total and the monthly figure are reported separately", () => {
    const c = carCost(REAL);
    // 12 × $921.38 would be $11,056.56, but insurance stops after five payments
    // — the horizon total is $8,526.13 and must not be back-derived from the
    // monthly figure, nor the monthly figure from it.
    expect(c.committedCents).toBe(852613);
    expect(c.committedCents).not.toBe(c.monthlyCents * REAL.months);
  });
});

/**
 * 🔴 "Insurance is evidenced through Nov 11, 2026 — a renewal is not in the
 * ledger, so the monthly figure above stops being what you pay after that date"
 * — measured on the owner's dashboard 2026-09-15, beside a runway card saying
 * the premium runs to Jan 11, 2027. The date was the earliest end of any car
 * series (a one-payment balance), and the word was hard-coded.
 */
describe("carEvidenceCaption", () => {
  const book = (occurrences: CommittedOccurrence[]) =>
    committedOutflows({ from: "2026-09-15", to: "2027-09-15", months: 12, occurrences, overdue: [] });
  const line = (name: string, cents: number, dates: string[], endsOn: string | null): CommittedOccurrence[] =>
    dates.map((date) => ({ seriesId: name, name, date, amountCents: cents, lastMatchedOn: null, isStale: true, cadence: "monthly", endsOn }));

  test("nothing ending inside the horizon is silence", () => {
    expect(carEvidenceCaption(book(line("Car lease", -69504, ["2026-09-15"], "2028-08-15")))).toBeNull();
  });

  test("names the commitment it dates, and counts the others that end", () => {
    const caption = carEvidenceCaption(
      book([
        ...line("Car lease", -69504, ["2026-09-15", "2026-10-15"], "2028-08-15"),
        ...line("Car insurance", -35758, ["2026-12-11", "2027-01-11"], "2027-01-11"),
        ...line("Nov 11 balance", -7274, ["2026-11-11"], "2026-11-11"),
      ]),
    )!;
    expect(caption).toBe(
      "Car insurance stops inside the next 12 months — evidenced through Jan 11, 2027, with no renewal in the ledger, and one other does too — so the monthly figure above stops being what you pay after that date.",
    );
  });
});
