import { describe, expect, test } from "vitest";
import { forecastSplit, type SplittableComponent } from "./forecast-split";

/**
 * September 2026 exactly as `forecastForMonth(db, "2026-09", "2026-08-31")`
 * produced it on the real ledger, measured before a line of this module
 * existed. Twenty-seven components: ten fixed (nine bills and one income
 * series) and seventeen variable (two income buckets and fifteen spending).
 *
 * It is the whole month, not a sample, because the thing under test is a
 * partition and a partition can only be checked against the total it came from:
 *
 *   income   $4,188.00 fixed + $45.69 variable = $4,233.69
 *   spending $3,567.60 fixed + $8,197.74 variable = $11,765.34
 *
 * ⚠️ The income side is the reason this fixture is worth its length. ONE stale
 * series carries $4,188.00 of a $4,233.69 projection — 98.9% — and no earlier
 * shape in this repo has that property. A fixture with balanced sides would
 * pass every assertion below while proving nothing about the case the split was
 * built to expose.
 */
const c = (
  kind: "fixed" | "variable",
  cents: number,
  isStale?: boolean,
): SplittableComponent => (isStale === undefined ? { kind, cents } : { kind, cents, isStale });

const SEPTEMBER: SplittableComponent[] = [
  // fixed — bills; the `true` flags are the seven the page reports as late
  c("fixed", -210900, false), // Flamingo South Beach (rent)  last seen 27d
  c("fixed", -18221, true), //   Rent utilities & fees        never seen
  c("fixed", -499, true), //     Amazon Prime                 last seen 57d
  c("fixed", -5000, false), //   Breezeline (internet)        last seen 21d
  c("fixed", -5887, true), //    FPL (electricity)            last seen 52d
  c("fixed", -36149, true), //   Car insurance                never seen
  c("fixed", -69504, true), //   Car lease                    never seen
  c("fixed", -600, false), //    Rocket Money                 last seen 47d
  c("fixed", -10000, true), //   Gym                          never seen
  // fixed — the only income series, 4 × $1,047.00, last matched 2026-06-05
  c("fixed", 418800, true), //   Cash job (weekly pay)        last seen 87d
  // variable — income
  c("variable", 4038), // Dividends
  c("variable", 531), //  Interest
  // variable — spending
  c("variable", -223486), // Travel
  c("variable", -168612), // Food
  c("variable", -115142), // Shopping
  c("variable", -75000), //  Government
  c("variable", -60005), //  Housing
  c("variable", -54828), //  Transport
  c("variable", -32985), //  Entertainment
  c("variable", -26298), //  Subscriptions
  c("variable", -20275), //  Cash & ATM
  c("variable", -14058), //  Weed
  c("variable", -12530), //  Personal Care
  c("variable", -7018), //   Utilities
  c("variable", -4573), //   Fees
  c("variable", -4297), //   Health
  c("variable", -667), //    Gambling
];

/** What `services/forecast` publishes for the same array — summed by sign only. */
const publishedIncome = (rows: readonly SplittableComponent[]) =>
  rows.reduce((s, r) => (r.cents > 0 ? s + r.cents : s), 0);
const publishedSpend = (rows: readonly SplittableComponent[]) =>
  rows.reduce((s, r) => (r.cents < 0 ? s + r.cents : s), 0);

describe("forecastSplit", () => {
  test("splits the real September projection into committed and variable", () => {
    const { income, spending } = forecastSplit(SEPTEMBER);

    expect(spending.fixedCents).toBe(-356760);
    expect(spending.variableCents).toBe(-819774);
    expect(spending.totalCents).toBe(-1176534);
    expect(spending.fixedCount).toBe(9);
    expect(spending.variableCount).toBe(15);

    expect(income.fixedCents).toBe(418800);
    expect(income.variableCents).toBe(4569);
    expect(income.totalCents).toBe(423369);
    expect(income.fixedCount).toBe(1);
    expect(income.variableCount).toBe(2);
  });

  /**
   * The identity the card depends on. The split lines sit directly beneath the
   * headline they decompose, so a partition that did not re-sum to it would put
   * two contradicting numbers 20px apart.
   */
  test("each side re-sums to the total the forecast publishes", () => {
    const { income, spending } = forecastSplit(SEPTEMBER);
    expect(income.totalCents).toBe(publishedIncome(SEPTEMBER));
    expect(spending.totalCents).toBe(publishedSpend(SEPTEMBER));
    expect(income.fixedCents + income.variableCents).toBe(income.totalCents);
    expect(spending.fixedCents + spending.variableCents).toBe(spending.totalCents);
  });

  test("keeps spending net-worth signed rather than flipping to a magnitude", () => {
    const { spending } = forecastSplit(SEPTEMBER);
    expect(spending.fixedCents).toBeLessThan(0);
    expect(spending.variableCents).toBeLessThan(0);
    expect(spending.totalCents).toBeLessThan(0);
  });

  test("fixedShare is the committed fraction of the side, not of everything", () => {
    const { income, spending } = forecastSplit(SEPTEMBER);
    // 356_760 / 1_176_534 — under a third of the spending, which is the point
    expect(spending.fixedShare).toBeCloseTo(0.30323, 5);
    // 418_800 / 423_369 — the income projection is almost entirely one series
    expect(income.fixedShare).toBeCloseTo(0.98921, 5);
  });

  test("fixedShare stays inside 0..1 on both sides", () => {
    const { income, spending } = forecastSplit(SEPTEMBER);
    for (const share of [income.fixedShare, spending.fixedShare]) {
      expect(share).not.toBeNull();
      expect(share!).toBeGreaterThanOrEqual(0);
      expect(share!).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The last day of a month reaches this: no fixed occurrence remains and the
   * trailing pace has one day left to run. Measured 2026-08-31, the running
   * month projected $1.47 of income with no fixed component at all.
   */
  test("a side with no fixed component reports a zero share, not a null one", () => {
    const { income } = forecastSplit([c("variable", 147)]);
    expect(income.fixedCents).toBe(0);
    expect(income.fixedCount).toBe(0);
    expect(income.totalCents).toBe(147);
    expect(income.fixedShare).toBe(0);
  });

  /**
   * ⛔ POSITIVE zero, on a side whose every figure is negative.
   *
   * This is the running month on the real ledger, not a constructed edge:
   * measured 2026-08-31, August projects −$264.44 of spending from seventeen
   * variable components and NO fixed one, because the last bill of the month
   * has already been paid. Dividing the signed cents directly — `0 / -26_444` —
   * yields `-0`, which `Object.is` separates from `0` and which formats as
   * "-0%" the moment anything renders it as a percentage. The magnitudes in
   * `fixedShare` are what stop that, and this is the case that proves it.
   */
  test("an all-variable spending side has a share of positive zero", () => {
    const { spending } = forecastSplit([
      c("variable", -7209), // Travel
      c("variable", -5439), // Food
      c("variable", -13796), // everything else, as one
    ]);
    expect(spending.totalCents).toBe(-26444);
    expect(spending.fixedCents).toBe(0);
    expect(spending.fixedShare).toBe(0);
    expect(Object.is(spending.fixedShare, -0)).toBe(false);
  });

  /**
   * ⛔ NULL, not 0. "Nothing is projected" and "nothing projected is committed"
   * are different statements, and the bar must not draw the second when the
   * first is true.
   */
  test("an empty side has no composition at all", () => {
    const { income, spending } = forecastSplit([c("fixed", -500)]);
    expect(income.totalCents).toBe(0);
    expect(income.fixedShare).toBeNull();
    expect(spending.fixedShare).toBe(1);
  });

  test("no components at all leaves both sides empty", () => {
    const { income, spending } = forecastSplit([]);
    for (const side of [income, spending]) {
      expect(side.totalCents).toBe(0);
      expect(side.fixedCents).toBe(0);
      expect(side.variableCents).toBe(0);
      expect(side.fixedCount).toBe(0);
      expect(side.variableCount).toBe(0);
      expect(side.fixedShare).toBeNull();
    }
  });

  /**
   * A zero-amount component changes no total, so it must not change a count
   * either — a count is an offer to explain, and there is nothing to explain
   * about $0.00.
   */
  test("a zero-amount component is counted into neither side", () => {
    const { income, spending } = forecastSplit([c("fixed", 0), c("variable", 0), c("fixed", -500)]);
    expect(spending.fixedCount).toBe(1);
    expect(spending.variableCount).toBe(0);
    expect(income.fixedCount).toBe(0);
    expect(income.variableCount).toBe(0);
    expect(spending.totalCents).toBe(-500);
  });

  /**
   * The sides are partitioned by SIGN before kind, so a positive fixed
   * component (the income series) can never be added to the committed bills and
   * a negative one can never be added to scheduled income. That is the mistake
   * `committedOutflows` reports as `inflowCents`: a $4,188 salary series landing
   * in a $3,567 bill book publishes a commitment of roughly nothing.
   */
  test("an income series is never netted against the committed bills", () => {
    const { income, spending } = forecastSplit([c("fixed", 418800), c("fixed", -356760)]);
    expect(spending.fixedCents).toBe(-356760);
    expect(income.fixedCents).toBe(418800);
    expect(spending.fixedCents + income.fixedCents).not.toBe(spending.totalCents);
  });

  /**
   * The reading job #1 of the handoff was about. Every dollar of scheduled
   * income in September rests on a series last matched 2026-06-05, and the card
   * has to be able to say so without dropping the money.
   */
  test("reports how much of the scheduled money rests on stale evidence", () => {
    const { income, spending } = forecastSplit(SEPTEMBER);

    expect(income.fixedStaleCents).toBe(418800);
    expect(income.fixedStaleCount).toBe(1);
    // all of it — the whole point
    expect(income.fixedStaleCents).toBe(income.fixedCents);

    // six of the nine bills, $1,402.60 of the $3,567.60 committed
    expect(spending.fixedStaleCents).toBe(-140260);
    expect(spending.fixedStaleCount).toBe(6);
    expect(spending.fixedStaleCents).not.toBe(spending.fixedCents);

    // the page's own "7 series are running late" is these two counts together
    expect(income.fixedStaleCount + spending.fixedStaleCount).toBe(7);
  });

  test("a variable component never counts as stale, flag or no flag", () => {
    const { spending } = forecastSplit([
      { kind: "variable", cents: -5000, isStale: true },
      c("fixed", -1000, true),
    ]);
    expect(spending.fixedStaleCents).toBe(-1000);
    expect(spending.fixedStaleCount).toBe(1);
  });

  /**
   * ⚠️ A missing flag means "not stale", never "unknown". `variableComponents`
   * emits no staleness at all and `fixedComponents` emits one on every
   * component, fresh ones included — so an absent flag here can only come from
   * a caller that has not measured, and guessing "stale" for it would put a
   * warning on the card that no evidence supports.
   */
  test("an absent flag is read as fresh", () => {
    const { spending } = forecastSplit([c("fixed", -1000), c("fixed", -2000, false)]);
    expect(spending.fixedCents).toBe(-3000);
    expect(spending.fixedStaleCents).toBe(0);
    expect(spending.fixedStaleCount).toBe(0);
  });

  test("does not mutate or reorder the input", () => {
    const input = [c("fixed", -100), c("variable", 250)];
    const copy = input.map((r) => ({ ...r }));
    forecastSplit(input);
    expect(input).toEqual(copy);
  });
});

/*
 * 🔴 "$1,402.60 of it running late" over $1,338.74 that had never been billed.
 *
 * `isStale` is the union of two facts — the evidence is past tolerance, and
 * there is no evidence at all — and reducing a component to that boolean left
 * the card unable to tell them apart. Measured on the real ledger at
 * today = 2026-09-01, September's committed MONEY OUT:
 *
 *     running late    $63.86    Amazon Prime $4.99 · FPL (electricity) $58.87
 *     never charged $1,338.74   Car lease $695.04 · Car insurance $361.49 ·
 *                               Rent utilities & fees $182.21 · Gym $100.00
 *
 * 95% of the money the card called late had never been billed by a bank, and
 * three of those four bills were not due yet. The MONEY IN side is genuinely
 * all late, so the two sides must be able to say different things.
 *
 * ⛔ The TYPE could not express it, which is the same shape as this session's
 * budgets bill count: no fixture over `SplittableComponent` could distinguish
 * one case from the other while the only field was a boolean.
 */
describe("never charged is not the same as running late", () => {
  const fixed = (cents: number, over: Partial<SplittableComponent> = {}): SplittableComponent => ({
    kind: "fixed",
    cents,
    ...over,
  });

  test("splits the stale part into charged-but-late and never-charged", () => {
    const split = forecastSplit([
      fixed(-499, { isStale: true, neverCharged: false }),
      fixed(-5887, { isStale: true, neverCharged: false }),
      fixed(-69504, { isStale: true, neverCharged: true }),
      fixed(-36149, { isStale: true, neverCharged: true }),
      fixed(-18221, { isStale: true, neverCharged: true }),
      fixed(-10000, { isStale: true, neverCharged: true }),
      fixed(-216500), // fresh
    ]);
    expect(split.spending.fixedStaleCents).toBe(-140260);
    expect(split.spending.fixedStaleCount).toBe(6);
    expect(split.spending.fixedNeverChargedCents).toBe(-133874);
    expect(split.spending.fixedNeverChargedCount).toBe(4);
    // the never-charged part is a SUBSET of the stale part, always
    expect(Math.abs(split.spending.fixedNeverChargedCents)).toBeLessThanOrEqual(
      Math.abs(split.spending.fixedStaleCents),
    );
  });

  test("a side that is all late reports no never-charged part", () => {
    const split = forecastSplit([fixed(418800, { isStale: true, neverCharged: false })]);
    expect(split.income.fixedStaleCents).toBe(418800);
    expect(split.income.fixedNeverChargedCents).toBe(0);
    expect(split.income.fixedNeverChargedCount).toBe(0);
  });

  test("a missing flag reads as 'has charged', never as unknown", () => {
    const split = forecastSplit([fixed(-1000, { isStale: true })]);
    expect(split.spending.fixedStaleCount).toBe(1);
    expect(split.spending.fixedNeverChargedCount).toBe(0);
  });

  test("never-charged only counts inside the stale set", () => {
    // a fresh component cannot be never-charged — freshness IS a charge
    const split = forecastSplit([fixed(-1000, { isStale: false, neverCharged: true })]);
    expect(split.spending.fixedStaleCount).toBe(0);
    expect(split.spending.fixedNeverChargedCount).toBe(0);
  });
});
