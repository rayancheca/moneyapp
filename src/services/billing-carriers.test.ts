import { describe, expect, test } from "vitest";
import { paymentFor, paysEarly, type DueDays, type Payment } from "./billing-carriers";
import { dueDaysOf } from "./recurring";

/** A monthly bill's due days on `anchorDay`, stepped as the projection steps them (`dueDaysOf`). */
const monthlyOn = (anchor: string): DueDays =>
  dueDaysOf({ cadence: "monthly", intervalDaysAvg: 30, nextExpectedOn: anchor, anchorDay: Number(anchor.slice(8)) });
/** On time only: no day after it is asked for a late payment, and none before it for an early one. */
const ON_TIME_ONLY: DueDays = { after: () => null, before: () => null };

/**
 * `paymentFor` — the one test of "did a posting cover this occurrence", the arrears' and the calendar's both. His rent
 * is due on the 1st with 3 days' grace; it has posted Jul 8, Aug 4 and Sep 2 (measured 2026-10-08).
 */
describe("paymentFor — the payment that pays a due day", () => {
  const rent = (postedOn: string) => ({ postedOn, toleranceDays: 3 });
  const RENT = monthlyOn("2026-09-01");

  // on time only: asked with no day either side, nothing late or early is asked (below)
  test("a payment within its own tolerance either side of the day pays it; one a day further does not", () => {
    expect(paymentFor([rent("2026-09-02")], "2026-09-01", ON_TIME_ONLY)).toEqual(rent("2026-09-02"));
    expect(paymentFor([rent("2026-08-04")], "2026-08-01", ON_TIME_ONLY)).toEqual(rent("2026-08-04"));
    expect(paymentFor([rent("2026-09-28")], "2026-10-01", ON_TIME_ONLY)).toEqual(rent("2026-09-28"));
    // Jul 8 is a week after Jul 1: past the rent's grace it pays no Jul 1 ON TIME — it pays it late (below)
    expect(paymentFor([rent("2026-07-08")], "2026-07-01", ON_TIME_ONLY)).toBeUndefined();
    expect(paymentFor([rent("2026-10-05")], "2026-10-01", ON_TIME_ONLY)).toBeUndefined();
    expect(paymentFor([], "2026-10-01", ON_TIME_ONLY)).toBeUndefined();
  });

  test("each payment is held to its OWN tolerance — the carrier's, not the day's", () => {
    expect(paymentFor([{ postedOn: "2026-10-06", toleranceDays: 5 }], "2026-10-01", ON_TIME_ONLY)).toEqual({
      postedOn: "2026-10-06",
      toleranceDays: 5,
    });
    expect(paymentFor([{ postedOn: "2026-10-06", toleranceDays: 4 }], "2026-10-01", ON_TIME_ONLY)).toBeUndefined();
  });

  test("of several, the nearest — the earlier of two as near — so the calendar names the payment that paid it", () => {
    expect(paymentFor([rent("2026-09-03"), rent("2026-09-02"), rent("2026-08-30")], "2026-09-01", RENT)).toEqual(
      rent("2026-09-02"),
    );
    expect(paymentFor([rent("2026-09-02"), rent("2026-08-31")], "2026-09-01", RENT)).toEqual(rent("2026-08-31"));
    expect(paymentFor([rent("2026-08-31"), rent("2026-09-02")], "2026-09-01", RENT)).toEqual(rent("2026-08-31"));
  });
});

/*
 * 🔴 A PAYMENT PAST ITS GRACE PAID NOTHING (review of 44eb3e7): the rent paid Oct 5 — four days after Oct 1, past its
 * 3 — paid no due day at all, so its Oct 1 was drawn a red ✕ beside the Oct 5 row, the runway said it "never posted",
 * and /budgets counted the $2,291.21 twice: in what was spent, and in what came due. His July rent posted Jul 8.
 *
 * A payment past a day's grace is still the payment of the day it is LATE for — until the next due day's own grace
 * opens, where it is that day's, on time. The grace stays the days a payment has to post before anything may say "not
 * posted" (his decision 60); it never made a late payment nobody's.
 */
describe("…and a payment past the day's grace pays it late, until the next due day's grace opens", () => {
  const rent = (postedOn: string) => ({ postedOn, toleranceDays: 3 });
  const RENT = monthlyOn("2026-09-01");

  test("his July rent, posted Jul 8 — a week past Jul 1 — pays Jul 1 late", () => {
    expect(paymentFor([rent("2026-07-08")], "2026-07-01", RENT)).toEqual(rent("2026-07-08"));
    expect(paymentFor([rent("2026-10-05")], "2026-10-01", RENT)).toEqual(rent("2026-10-05"));
  });

  test("Jul 28 still pays Jul 1; Jul 29 is inside Aug 1's 3 days — Aug 1's, on time, and never Jul 1's too", () => {
    expect(paymentFor([rent("2026-07-28")], "2026-07-01", RENT)).toEqual(rent("2026-07-28"));
    expect(paymentFor([rent("2026-07-29")], "2026-07-01", RENT)).toBeUndefined();
    expect(paymentFor([rent("2026-07-29")], "2026-08-01", RENT)).toEqual(rent("2026-07-29"));
  });

  test("one on time is the payment — never a later one, however near", () => {
    expect(paymentFor([rent("2026-07-05"), rent("2026-07-04")], "2026-07-01", RENT)).toEqual(rent("2026-07-04"));
    // of two late, the earlier: the day it was late for was paid then
    expect(paymentFor([rent("2026-07-09"), rent("2026-07-06")], "2026-07-01", RENT)).toEqual(rent("2026-07-06"));
  });

  test("a payment BEFORE the day's grace is never late for it: Jun 27, four days early, pays no Jul 1", () => {
    // nothing paid Jun 1, so it is Jun 1's, late (below) — it pays Jul 1 early only once Jun 1 is paid by another
    expect(paymentFor([rent("2026-06-27")], "2026-07-01", RENT)).toBeUndefined();
    expect(paymentFor([rent("2026-06-27")], "2026-06-01", RENT)).toEqual(rent("2026-06-27"));
  });

  test("each payment's late days end where the next due day's grace opens by its OWN tolerance", () => {
    // the rent's own 3 days: Jul 27 is late for Jul 1; held to an annual fee's 14, it would be Aug 1's, on time
    expect(paymentFor([rent("2026-07-27")], "2026-07-01", RENT)).toEqual(rent("2026-07-27"));
    expect(paymentFor([{ postedOn: "2026-07-27", toleranceDays: 14 }], "2026-07-01", RENT)).toBeUndefined();
  });
});

/*
 * ⚖️ His decision 73 (2026-10-13, either/or, recommended): a payment that posts MORE than its grace days EARLY, when the
 * due day before it is already paid, PAYS THE NEXT DUE DAY EARLY. 🔴 FPL (electricity) is due the 8th (his number, 3
 * days' grace), and his Chase Checking holds Jul 10 −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8:
 * Jul 28 paid no due day at all — and if FPL drafts around the 28th, every statement's newest 8th would read "not
 * posted" until the following one.
 */
describe("…and one more than its grace EARLY pays the next due day, once the day before it is paid (decision 73)", () => {
  const fpl = (postedOn: string): Payment => ({ postedOn, toleranceDays: 3 });
  const FPL = monthlyOn("2026-07-08");
  const days = ["2026-06-08", "2026-07-08", "2026-08-08", "2026-09-08", "2026-10-08", "2026-11-08"];
  /** each due day and the day of the payment that pays it, or null */
  const graded = (payments: readonly Payment[]) =>
    days.map((d) => [d, paymentFor(payments, d, FPL)?.postedOn ?? null] as const);

  test("FPL's own shape: Jul 10 pays Jul 8 on time, Jul 28 pays Aug 8 early", () => {
    expect(graded([fpl("2026-07-10"), fpl("2026-07-28")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", "2026-07-28"],
      ["2026-09-08", null],
      ["2026-10-08", null],
      ["2026-11-08", null],
    ]);
  });

  test("drafted every 28th, each draft pays the next 8th — the newest 8th is paid by the newest draft", () => {
    expect(graded([fpl("2026-07-10"), fpl("2026-07-28"), fpl("2026-08-28"), fpl("2026-09-28")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", "2026-07-28"],
      ["2026-09-08", "2026-08-28"],
      ["2026-10-08", "2026-09-28"],
      ["2026-11-08", null],
    ]);
  });

  test("the day before UNPAID: the late rule keeps the payment for it — Jul 28 pays Jul 8 late, never Aug 8 too", () => {
    expect(graded([fpl("2026-07-28")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-28"],
      ["2026-08-08", null],
      ["2026-09-08", null],
      ["2026-10-08", null],
      ["2026-11-08", null],
    ]);
  });

  test("two in one gap: the first pays the unpaid day before it late, the second pays the next day early", () => {
    expect(graded([fpl("2026-07-15"), fpl("2026-07-28")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-15"],
      ["2026-08-08", "2026-07-28"],
      ["2026-09-08", null],
      ["2026-10-08", null],
      ["2026-11-08", null],
    ]);
  });

  test("two in one gap after a day paid on time: the earlier pays the next day early, the later pays nothing", () => {
    expect(graded([fpl("2026-07-10"), fpl("2026-07-28"), fpl("2026-07-20")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", "2026-07-20"],
      ["2026-09-08", null],
      ["2026-10-08", null],
      ["2026-11-08", null],
    ]);
  });

  test("Aug 4 — one day more than its grace before Aug 8 — pays it early; Aug 5, on its grace, pays it on time", () => {
    expect(paymentFor([fpl("2026-07-10"), fpl("2026-08-04")], "2026-08-08", FPL)).toEqual(fpl("2026-08-04"));
    expect(paysEarly(fpl("2026-08-04"), "2026-08-08")).toBe(true);
    expect(paymentFor([fpl("2026-07-10"), fpl("2026-08-05")], "2026-08-08", FPL)).toEqual(fpl("2026-08-05"));
    expect(paysEarly(fpl("2026-08-05"), "2026-08-08")).toBe(false);
    // …and Jul 12, a day past Jul 8's grace with Jul 8 paid on Jul 10, is Aug 8's — paid early, 27 days ahead
    expect(paymentFor([fpl("2026-07-10"), fpl("2026-07-12")], "2026-08-08", FPL)).toEqual(fpl("2026-07-12"));
  });

  test("a day paid on time keeps its own payment: one before it in its gap pays nothing more", () => {
    expect(graded([fpl("2026-07-10"), fpl("2026-07-28"), fpl("2026-08-08")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", "2026-08-08"],
      ["2026-09-08", null],
      ["2026-10-08", null],
      ["2026-11-08", null],
    ]);
  });

  test("two rows of ONE day are one payment — his Jun 16 rent, posted by the card as two (`occurrencesOf`)", () => {
    const rent = (postedOn: string): Payment => ({ postedOn, toleranceDays: 3 });
    const RENT = monthlyOn("2026-09-01");
    const payments = [rent("2026-06-16"), rent("2026-06-16"), rent("2026-07-08"), rent("2026-08-04")];
    // Jun 16 pays Jun 1 late — once — so July's rent is still the Jul 8 payment, late, as it was
    expect(paymentFor(payments, "2026-06-01", RENT)?.postedOn).toBe("2026-06-16");
    expect(paymentFor(payments, "2026-07-01", RENT)?.postedOn).toBe("2026-07-08");
    expect(paymentFor(payments, "2026-08-01", RENT)?.postedOn).toBe("2026-08-04");
  });

  test("the day before is the schedule's own step back — behind the anchor too, and clamped at a month's end", () => {
    expect(FPL.before("2026-07-08")).toBe("2026-06-08");
    expect(FPL.before("2026-01-08")).toBe("2025-12-08");
    const monthEnd = monthlyOn("2026-01-31");
    expect(monthEnd.before("2026-03-31")).toBe("2026-02-28");
    expect(monthEnd.after("2026-02-28")).toBe("2026-03-31");
    // a month-end bill paid Feb 20 — Jan 31 paid Jan 31 — pays its Feb 28 early, read back over the clamped step
    const bill = (postedOn: string): Payment => ({ postedOn, toleranceDays: 3 });
    expect(paymentFor([bill("2026-01-31"), bill("2026-02-20")], "2026-02-28", monthEnd)?.postedOn).toBe("2026-02-20");
  });

  test("with no due day before it asked, nothing pays a day early", () => {
    expect(paymentFor([fpl("2026-07-10"), fpl("2026-07-28")], "2026-08-08", { ...FPL, before: () => null })).toBe(
      undefined,
    );
  });

  test("one payment pays one due day, never two — whatever the shape", () => {
    const shapes = [
      ["2026-07-10", "2026-07-28"],
      ["2026-07-10", "2026-07-28", "2026-08-28", "2026-09-28"],
      ["2026-07-15", "2026-07-28", "2026-08-20", "2026-08-28"],
      ["2026-06-20", "2026-07-15", "2026-07-28", "2026-09-01", "2026-09-30"],
      ["2026-07-08", "2026-07-20", "2026-07-21", "2026-08-15", "2026-09-07"],
    ];
    for (const shape of shapes) {
      const payments = shape.map(fpl);
      const paid = days.map((d) => paymentFor(payments, d, FPL)).filter((p) => p !== undefined);
      expect(new Set(paid).size).toBe(paid.length);
    }
  });
});
