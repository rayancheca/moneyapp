import { describe, expect, test } from "vitest";
import { paymentFor } from "./billing-carriers";

/**
 * `paymentFor` — the one test of "did a posting cover this occurrence", the arrears' and the calendar's both. His rent
 * is due on the 1st with 3 days' grace; it has posted Jul 8, Aug 4 and Sep 2 (measured 2026-10-08).
 */
describe("paymentFor — the payment that pays a due day", () => {
  const rent = (postedOn: string) => ({ postedOn, toleranceDays: 3 });

  // on time only: asked with no next due day, nothing late is asked (below)
  test("a payment within its own tolerance either side of the day pays it; one a day further does not", () => {
    expect(paymentFor([rent("2026-09-02")], "2026-09-01", null)).toEqual(rent("2026-09-02"));
    expect(paymentFor([rent("2026-08-04")], "2026-08-01", null)).toEqual(rent("2026-08-04"));
    expect(paymentFor([rent("2026-09-28")], "2026-10-01", null)).toEqual(rent("2026-09-28"));
    // Jul 8 is a week after Jul 1: past the rent's grace it pays no Jul 1 ON TIME — it pays it late (below)
    expect(paymentFor([rent("2026-07-08")], "2026-07-01", null)).toBeUndefined();
    expect(paymentFor([rent("2026-10-05")], "2026-10-01", null)).toBeUndefined();
    expect(paymentFor([], "2026-10-01", null)).toBeUndefined();
  });

  test("each payment is held to its OWN tolerance — the carrier's, not the day's", () => {
    expect(paymentFor([{ postedOn: "2026-10-06", toleranceDays: 5 }], "2026-10-01", null)).toEqual({
      postedOn: "2026-10-06",
      toleranceDays: 5,
    });
    expect(paymentFor([{ postedOn: "2026-10-06", toleranceDays: 4 }], "2026-10-01", null)).toBeUndefined();
  });

  test("of several, the nearest — the earlier of two as near — so the calendar names the payment that paid it", () => {
    expect(
      paymentFor([rent("2026-09-03"), rent("2026-09-02"), rent("2026-08-30")], "2026-09-01", "2026-10-01"),
    ).toEqual(rent("2026-09-02"));
    expect(paymentFor([rent("2026-09-02"), rent("2026-08-31")], "2026-09-01", "2026-10-01")).toEqual(
      rent("2026-08-31"),
    );
    expect(paymentFor([rent("2026-08-31"), rent("2026-09-02")], "2026-09-01", "2026-10-01")).toEqual(
      rent("2026-08-31"),
    );
  });
});

/*
 * 🔴 A PAYMENT PAST ITS GRACE PAID NOTHING (review of 44eb3e7): the rent paid Oct 5 — four days after Oct 1, past its
 * 3 — paid no due day at all, so its Oct 1 was drawn a red ✕ beside the Oct 5 row, the runway said it "never posted",
 * and /budgets counted the $2,291.21 twice: in what was spent, and in what came due. His July rent posted Jul 8.
 *
 * A payment past a day's grace is still the payment of the day it is LATE for — until the next due day's own grace
 * opens, where it is that day's, early. The grace stays the days a payment has to post before anything may say "not
 * posted" (his decision 60); it never made a late payment nobody's.
 */
describe("…and a payment past the day's grace pays it late, until the next due day's grace opens", () => {
  const rent = (postedOn: string) => ({ postedOn, toleranceDays: 3 });

  test("his July rent, posted Jul 8 — a week past Jul 1 — pays Jul 1 late", () => {
    expect(paymentFor([rent("2026-07-08")], "2026-07-01", "2026-08-01")).toEqual(rent("2026-07-08"));
    expect(paymentFor([rent("2026-10-05")], "2026-10-01", "2026-11-01")).toEqual(rent("2026-10-05"));
  });

  test("Jul 28 still pays Jul 1; Jul 29 is inside Aug 1's 3 days — Aug 1's, early, and never Jul 1's too", () => {
    expect(paymentFor([rent("2026-07-28")], "2026-07-01", "2026-08-01")).toEqual(rent("2026-07-28"));
    expect(paymentFor([rent("2026-07-29")], "2026-07-01", "2026-08-01")).toBeUndefined();
    expect(paymentFor([rent("2026-07-29")], "2026-08-01", "2026-09-01")).toEqual(rent("2026-07-29"));
  });

  test("one on time is the payment — never a later one, however near", () => {
    expect(paymentFor([rent("2026-07-05"), rent("2026-07-04")], "2026-07-01", "2026-08-01")).toEqual(
      rent("2026-07-04"),
    );
    // of two late, the earlier: the day it was late for was paid then
    expect(paymentFor([rent("2026-07-09"), rent("2026-07-06")], "2026-07-01", "2026-08-01")).toEqual(
      rent("2026-07-06"),
    );
  });

  test("a payment BEFORE the day's grace is never late for it: Jun 27, four days early, pays no Jul 1", () => {
    expect(paymentFor([rent("2026-06-27")], "2026-07-01", "2026-08-01")).toBeUndefined();
  });

  test("each payment's late days end where the next due day's grace opens by its OWN tolerance", () => {
    // the rent's own 3 days: Jul 27 is late for Jul 1; held to an annual fee's 14, it would be Aug 1's, early
    expect(paymentFor([rent("2026-07-27")], "2026-07-01", "2026-08-01")).toEqual(rent("2026-07-27"));
    expect(paymentFor([{ postedOn: "2026-07-27", toleranceDays: 14 }], "2026-07-01", "2026-08-01")).toBeUndefined();
  });
});
