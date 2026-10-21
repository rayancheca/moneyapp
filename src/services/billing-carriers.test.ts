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
 * A payment past a day's grace is still the payment of the day it is LATE for — while it lies nearer that day than the
 * next (⚖️ his decision 76, 2026-10-14, below). The grace stays the days a payment has to post before anything may say
 * "not posted" (his decision 60); it never made a late payment nobody's.
 */
describe("…and a payment past the day's grace pays it late, while it lies nearer it than the next due day", () => {
  const rent = (postedOn: string) => ({ postedOn, toleranceDays: 3 });
  const RENT = monthlyOn("2026-09-01");

  test("his July rent, posted Jul 8 — a week past Jul 1 — pays Jul 1 late", () => {
    expect(paymentFor([rent("2026-07-08")], "2026-07-01", RENT)).toEqual(rent("2026-07-08"));
    expect(paymentFor([rent("2026-10-05")], "2026-10-01", RENT)).toEqual(rent("2026-10-05"));
  });

  test("Jul 16 — 15 days after Jul 1, 16 before Aug 1 — pays Jul 1; Jul 17, nearer Aug 1, pays it early", () => {
    expect(paymentFor([rent("2026-07-16")], "2026-07-01", RENT)).toEqual(rent("2026-07-16"));
    expect(paymentFor([rent("2026-07-16")], "2026-08-01", RENT)).toBeUndefined();
    expect(paymentFor([rent("2026-07-17")], "2026-07-01", RENT)).toBeUndefined();
    expect(paymentFor([rent("2026-07-17")], "2026-08-01", RENT)).toEqual(rent("2026-07-17"));
    // …and Jul 29, inside Aug 1's 3 days, is Aug 1's on time
    expect(paymentFor([rent("2026-07-29")], "2026-07-01", RENT)).toBeUndefined();
    expect(paymentFor([rent("2026-07-29")], "2026-08-01", RENT)).toEqual(rent("2026-07-29"));
  });

  test("one on time is the payment — never a later one, however near", () => {
    expect(paymentFor([rent("2026-07-05"), rent("2026-07-04")], "2026-07-01", RENT)).toEqual(rent("2026-07-04"));
    // of two late, the earlier: the day it was late for was paid then
    expect(paymentFor([rent("2026-07-09"), rent("2026-07-06")], "2026-07-01", RENT)).toEqual(rent("2026-07-06"));
  });

  test("a payment BEFORE the day's grace is never late for it: Jun 27, four days early, pays Jul 1 early", () => {
    // nearer Jul 1 than Jun 1, it pays Jul 1 even with Jun 1 unpaid — the cost he accepted (decision 76)
    expect(paymentFor([rent("2026-06-27")], "2026-07-01", RENT)).toEqual(rent("2026-06-27"));
    expect(paymentFor([rent("2026-06-27")], "2026-06-01", RENT)).toBeUndefined();
  });

  test("each payment is held to its OWN tolerance: Jul 27 pays Aug 1 early at the rent's 3, on time at 14", () => {
    expect(paymentFor([rent("2026-07-27")], "2026-08-01", RENT)).toEqual(rent("2026-07-27"));
    expect(paysEarly(rent("2026-07-27"), "2026-08-01")).toBe(true);
    const fee = { postedOn: "2026-07-27", toleranceDays: 14 };
    expect(paymentFor([fee], "2026-08-01", RENT)).toEqual(fee);
    expect(paysEarly(fee, "2026-08-01")).toBe(false);
    expect(paymentFor([rent("2026-07-27")], "2026-07-01", RENT)).toBeUndefined();
  });
});

/*
 * ⚖️ His decision 73 (2026-10-13): a payment that posts MORE than its grace days EARLY pays the next due day early —
 * refined by his decision 76 (2026-10-14, his answer): THE NEARER DUE DAY WINS. A payment between two due days pays the
 * one it lies nearer, a tie the earlier; it pays the later early only when nothing paid that day on time, otherwise it
 * is the earlier's, late — or pays nothing, that day already paid. 🔴 FPL (electricity) is due the 8th (his number, 3
 * days' grace), and his Chase Checking holds Jul 10 −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8:
 * Jul 28 paid no due day at all — and if FPL drafts around the 28th, every statement's newest 8th would read "not
 * posted" until the following one.
 */
describe("…and one more than its grace EARLY pays the next due day, when it lies nearer it (decisions 73, 76)", () => {
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

  /*
   * ⚖️ The cost he accepted (decision 76): nearer Aug 8, Jul 28 pays it even with Jul 8 unpaid — one month owed either
   * way. 🔴 Under decision 73 the late rule kept it for Jul 8, and the Car lease's Sep 2 −$695.04 read as Aug 15's.
   */
  test("the day before UNPAID: Jul 28, nearer Aug 8, pays it early, and Jul 8 is the month owed", () => {
    expect(graded([fpl("2026-07-28")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", null],
      ["2026-08-08", "2026-07-28"],
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

  /*
   * 🔴 Nothing asked a day paid by the SECOND of two in its gap (review of 844e484): read as unpaid, Aug 28 was Aug 8's
   * late payment — which Jul 28 had already made — so it paid no due day, Sep 8 read "not posted" once Chase was read
   * past Sep 11, and every newest 8th after it, read back through Sep 8, did the same until the next draft.
   */
  test("…and the next gap's one draft pays the day after: Aug 8 is paid by Jul 28, so Aug 28 pays Sep 8 early", () => {
    expect(graded([fpl("2026-07-15"), fpl("2026-07-28"), fpl("2026-08-28")])[3]).toEqual(["2026-09-08", "2026-08-28"]);
    // drafted every 28th from then on, each draft pays the next 8th — read back through Sep 8 to the gap of two
    expect(graded([fpl("2026-07-15"), fpl("2026-07-28"), fpl("2026-08-28"), fpl("2026-09-28")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-15"],
      ["2026-08-08", "2026-07-28"],
      ["2026-09-08", "2026-08-28"],
      ["2026-10-08", "2026-09-28"],
      ["2026-11-08", null],
    ]);
  });

  test("two in one gap after a day paid on time: the one nearer the next day pays it, nearer Jul 8 nothing", () => {
    // Jul 20 is 12 days after Jul 8 and 19 before Aug 8 — Jul 8's, already paid on Jul 10
    expect(graded([fpl("2026-07-10"), fpl("2026-07-28"), fpl("2026-07-20")])).toEqual([
      ["2026-06-08", null],
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", "2026-07-28"],
      ["2026-09-08", null],
      ["2026-10-08", null],
      ["2026-11-08", null],
    ]);
    // both nearer Aug 8 (Jul 24 is 16 after, 15 before): the earlier pays it, the later nothing — one day, one payment
    expect(graded([fpl("2026-07-10"), fpl("2026-07-28"), fpl("2026-07-24")]).slice(1, 4)).toEqual([
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", "2026-07-24"],
      ["2026-09-08", null],
    ]);
  });

  test("Aug 4 — one day more than its grace before Aug 8 — pays it early; Aug 5, on its grace, pays it on time", () => {
    expect(paymentFor([fpl("2026-07-10"), fpl("2026-08-04")], "2026-08-08", FPL)).toEqual(fpl("2026-08-04"));
    expect(paysEarly(fpl("2026-08-04"), "2026-08-08")).toBe(true);
    expect(paymentFor([fpl("2026-07-10"), fpl("2026-08-05")], "2026-08-08", FPL)).toEqual(fpl("2026-08-05"));
    expect(paysEarly(fpl("2026-08-05"), "2026-08-08")).toBe(false);
    // …and Jul 12, a day past Jul 8's grace, is nearer Jul 8 — paid on Jul 10 — so it pays nothing: no Aug 8 early
    // (🔴 decision 73 read it as Aug 8's, 27 days ahead: the shape of a rent split Oct 1 + Oct 9 paying Nov 1)
    expect(graded([fpl("2026-07-10"), fpl("2026-07-12")]).slice(1, 3)).toEqual([
      ["2026-07-08", "2026-07-10"],
      ["2026-08-08", null],
    ]);
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
      // nearer a day paid on time, so the day before's (decision 76)
      ["2026-07-28", "2026-08-08"],
      ["2026-07-12", "2026-07-30", "2026-08-08", "2026-08-25", "2026-09-08"],
      ["2026-06-30", "2026-07-24", "2026-07-28", "2026-08-08", "2026-09-26", "2026-10-08"],
    ];
    for (const shape of shapes) {
      const payments = shape.map(fpl);
      const paid = days.map((d) => paymentFor(payments, d, FPL)).filter((p) => p !== undefined);
      expect(new Set(paid).size).toBe(paid.length);
    }
  });
});

/*
 * ⚖️ His decision 76 (2026-10-14, his answer, refines 73): THE NEARER DUE DAY WINS — measured with the reviewer's
 * prototype on his ledger copy 2026-10-13, every shape below is one he was shown.
 */
describe("the nearer due day wins (decision 76)", () => {
  const pay = (postedOn: string): Payment => ({ postedOn, toleranceDays: 3 });
  /** each due day of `days` and the day of the payment that pays it, or null */
  const graded = (payments: readonly Payment[], due: DueDays, days: readonly string[]) =>
    days.map((d) => [d, paymentFor(payments, d, due)?.postedOn ?? null] as const);

  // 🔴 decision 73 read the Sep 2 −$695.04 as Aug 15's late payment (Aug 15 unpaid) and left Sep 15 unpaid
  test("the Car lease, due the 15th: Sep 2 pays Sep 15 early, Aug 15 owed; an Oct 1 web pay pays Oct 15", () => {
    const LEASE = monthlyOn("2026-10-15");
    const days = ["2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15"];
    expect(graded([pay("2026-09-02")], LEASE, days)).toEqual([
      ["2026-08-15", null],
      ["2026-09-15", "2026-09-02"],
      ["2026-10-15", null],
      ["2026-11-15", null],
    ]);
    expect(graded([pay("2026-09-02"), pay("2026-10-01")], LEASE, days)).toEqual([
      ["2026-08-15", null],
      ["2026-09-15", "2026-09-02"],
      ["2026-10-15", "2026-10-01"],
      ["2026-11-15", null],
    ]);
  });

  test("a payment past the next day's grace window is never the day before's: Sep 19 is Sep 15's, late", () => {
    const LEASE = monthlyOn("2026-10-15");
    // Sep 18 is Sep 15's on time, Sep 19 — past its 3 — late; neither reaches back to Aug 15
    for (const day of ["2026-09-18", "2026-09-19"]) {
      expect(graded([pay(day)], LEASE, ["2026-08-15", "2026-09-15", "2026-10-15"])).toEqual([
        ["2026-08-15", null],
        ["2026-09-15", day],
        ["2026-10-15", null],
      ]);
    }
  });

  test("an exact tie is the earlier day's: his Jun 16 rent, 15 days after Jun 1 and 15 before Jul 1", () => {
    const RENT = monthlyOn("2026-09-01");
    const days = ["2026-06-01", "2026-07-01", "2026-08-01"];
    expect(graded([pay("2026-06-16")], RENT, days)).toEqual([
      ["2026-06-01", "2026-06-16"],
      ["2026-07-01", null],
      ["2026-08-01", null],
    ]);
    // a day later it is nearer Jul 1
    expect(graded([pay("2026-06-17")], RENT, days)).toEqual([
      ["2026-06-01", null],
      ["2026-07-01", "2026-06-17"],
      ["2026-08-01", null],
    ]);
  });

  test("nearer a day paid ON TIME by another: the other day, late — Jul 28 pays Jul 8 when Aug 8 is paid", () => {
    const FPL = monthlyOn("2026-07-08");
    expect(graded([pay("2026-07-28"), pay("2026-08-08")], FPL, ["2026-07-08", "2026-08-08", "2026-09-08"])).toEqual([
      ["2026-07-08", "2026-07-28"],
      ["2026-08-08", "2026-08-08"],
      ["2026-09-08", null],
    ]);
  });

  // 🔴 decision 73 paid Nov 1 early with Oct 9 (Oct 1 paid by then): Nov 1 left Upcoming and the November forecast
  test("…and nearer the day before, paid on time, it pays nothing: a rent split Oct 1 + Oct 9 leaves Nov 1", () => {
    const RENT = monthlyOn("2026-09-01");
    const split = [pay("2026-09-02"), pay("2026-10-01"), pay("2026-10-09")];
    expect(graded(split, RENT, ["2026-09-01", "2026-10-01", "2026-11-01"])).toEqual([
      ["2026-09-01", "2026-09-02"],
      ["2026-10-01", "2026-10-01"],
      ["2026-11-01", null],
    ]);
  });

  /*
   * ⚠️ OPEN — his call (review of f8b5320..eb48365, 2026-10-21): a payment LEFT OVER — nearer a day another payment
   * already pays — pays nothing as built, which is what keeps the split rent's Nov 1 above. The redirect runs one way
   * only (nearer the LATER day, paid on time: the earlier's, late). "Then the other day, if unpaid" would pay each day
   * below — and Nov 1 above, early, with Oct 9. One decision: either answer flips this test and the one above.
   */
  test("⚠️ left over, it pays nothing: a prepay a week after an on-time Oct 15, and Sep 30 after an early Sep 2", () => {
    const LEASE = monthlyOn("2026-10-15");
    // Oct 22: 7 days after Oct 15, paid on time, 24 before Nov 15
    expect(graded([pay("2026-10-15"), pay("2026-10-22")], LEASE, ["2026-10-15", "2026-11-15"])).toEqual([
      ["2026-10-15", "2026-10-15"],
      ["2026-11-15", null],
    ]);
    // Sep 30: 15 days either side — the tie, Sep 15's, which Sep 2 paid early
    expect(graded([pay("2026-09-02"), pay("2026-09-30")], LEASE, ["2026-09-15", "2026-10-15"])).toEqual([
      ["2026-09-15", "2026-09-02"],
      ["2026-10-15", null],
    ]);
  });

  /*
   * The review's shape (of 844e484): his June rent in two halves a day apart, then rents past their grace. Each late
   * rent pays its own month. ⚠️ The second half, Jun 17, is nearer Jul 1 and pays it early — a known gap neither 73
   * nor 76 catches (only rows within a few days as one payment, or a floor on an early payment's amount, would); and
   * Jul 8, nearer Jul 1, finds it paid and pays nothing.
   */
  test("late rents each pay their own month; two halves a day apart pay two months — the known gap", () => {
    const RENT = monthlyOn("2026-09-01");
    const rows = ["2026-06-16", "2026-06-17", "2026-07-08", "2026-08-05", "2026-09-06", "2026-10-07"].map(pay);
    const days = ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];
    expect(graded(rows, RENT, days)).toEqual([
      ["2026-06-01", "2026-06-16"],
      ["2026-07-01", "2026-06-17"],
      ["2026-08-01", "2026-08-05"],
      ["2026-09-01", "2026-09-06"],
      ["2026-10-01", "2026-10-07"],
      ["2026-11-01", null],
    ]);
  });
});
