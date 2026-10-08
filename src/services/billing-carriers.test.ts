import { describe, expect, test } from "vitest";
import { paymentFor } from "./billing-carriers";

/**
 * `paymentFor` — the one test of "did a posting cover this occurrence", the arrears' and the calendar's both. His rent
 * is due on the 1st with 3 days' grace; it has posted Jul 8, Aug 4 and Sep 2 (measured 2026-10-08).
 */
describe("paymentFor — the payment that pays a due day", () => {
  const rent = (postedOn: string) => ({ postedOn, toleranceDays: 3 });

  test("a payment within its own tolerance either side of the day pays it; one a day further does not", () => {
    expect(paymentFor([rent("2026-09-02")], "2026-09-01")).toEqual(rent("2026-09-02"));
    expect(paymentFor([rent("2026-08-04")], "2026-08-01")).toEqual(rent("2026-08-04"));
    expect(paymentFor([rent("2026-09-28")], "2026-10-01")).toEqual(rent("2026-09-28"));
    // Jul 8 is a week after Jul 1: past the rent's grace, it pays no Jul 1
    expect(paymentFor([rent("2026-07-08")], "2026-07-01")).toBeUndefined();
    expect(paymentFor([rent("2026-10-05")], "2026-10-01")).toBeUndefined();
    expect(paymentFor([], "2026-10-01")).toBeUndefined();
  });

  test("each payment is held to its OWN tolerance — the carrier's, not the day's", () => {
    expect(paymentFor([{ postedOn: "2026-10-06", toleranceDays: 5 }], "2026-10-01")).toEqual({
      postedOn: "2026-10-06",
      toleranceDays: 5,
    });
    expect(paymentFor([{ postedOn: "2026-10-06", toleranceDays: 4 }], "2026-10-01")).toBeUndefined();
  });

  test("of several, the nearest — the earlier of two as near — so the calendar names the payment that paid it", () => {
    expect(paymentFor([rent("2026-09-03"), rent("2026-09-02"), rent("2026-08-30")], "2026-09-01")).toEqual(
      rent("2026-09-02"),
    );
    expect(paymentFor([rent("2026-09-02"), rent("2026-08-31")], "2026-09-01")).toEqual(rent("2026-08-31"));
    expect(paymentFor([rent("2026-08-31"), rent("2026-09-02")], "2026-09-01")).toEqual(rent("2026-08-31"));
  });
});
