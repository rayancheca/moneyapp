import { describe, expect, test } from "vitest";
import { paymentFor, paysEarly, type DueDays, type Payment } from "./billing-carriers";
import { dueDaysOf } from "./recurring";

/** A monthly bill's due days on `anchorDay`, stepped as the projection steps them (`dueDaysOf`) — detection's day. */
const monthlyOn = (anchor: string): DueDays =>
  dueDaysOf(
    { cadence: "monthly", intervalDaysAvg: 30, nextExpectedOn: anchor, anchorDay: Number(anchor.slice(8)) },
    { userNextExpectedOn: null },
  );
/** …on a date HE set (`userNextExpectedOn`), stepped as `effectiveSchedule` steps one: no detected interval or day */
const hisDate = (date: string): DueDays =>
  dueDaysOf(
    { cadence: "monthly", intervalDaysAvg: null, nextExpectedOn: date, anchorDay: null },
    { userNextExpectedOn: date },
  );
/** On time only: no day after it is asked for a late payment, and none before it for an early one. */
const ON_TIME_ONLY: DueDays = { after: () => null, before: () => null, opensOn: null, opensOnHisDate: false };

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
 * A payment past a day's grace is still the payment of the day it is LATE for — when it lies nearer that day than the
 * next (⚖️ his decision 76, 2026-10-14, below), or nearer the next when another payment paid that one on time (⚖️
 * default (c), built, not asked — below). The grace stays the days a payment has to post before anything may say "not
 * posted" (his decision 60); it never made a late payment nobody's.
 */
describe("…and a payment past the day's grace pays it late — nearer it than the next due day, or (c) below", () => {
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
 * one it lies nearer, a tie the earlier; it pays the later early only when nothing paid that day on time (his
 * "unless"). Otherwise it is the earlier's, late — or pays nothing, that day already paid: ⚖️ default (c), built, not
 * asked (below). 🔴 FPL (electricity) is due the 8th (his number, 3 days' grace), and his Chase Checking holds Jul 10
 * −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8: Jul 28 paid no due day at all. Those two are
 * every FPL posting on his ledger (his copy, 2026-10-21); the drafts on the 28th of later months below are a what-if,
 * a bill drafted so — which would have read every statement's newest 8th "not posted" until the following one.
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

  test("a what-if drafted every 28th: each draft pays the next 8th — the newest 8th by the newest draft", () => {
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
   * 🔴 Under decision 73 nothing asked a day paid by the SECOND of two in its gap (review of 844e484, on this what-if):
   * read as unpaid, Aug 28 was Aug 8's late payment — which Jul 28 had already made — so it paid no due day, and Sep 8
   * read "not posted" once Chase was read past Sep 11; 73 read each later 8th back through Sep 8, so every newest 8th
   * after it did the same until the next draft. Nearer, nothing is read back (`paymentFor`): Aug 28 lies nearer Sep 8.
   */
  test("…and the next gap's one draft pays the day after: Aug 8 is paid by Jul 28, so Aug 28 pays Sep 8 early", () => {
    expect(graded([fpl("2026-07-15"), fpl("2026-07-28"), fpl("2026-08-28")])[3]).toEqual(["2026-09-08", "2026-08-28"]);
    // drafted every 28th from then on, each draft pays the next 8th — each lies nearer it, whatever the gap of two did
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
    // (🔴 decision 73 read it as Aug 8's, 27 days ahead: the shape of a rent split Oct 1 + Oct 9 paying Nov 1 —
    // ⚖️ default (a), built, not asked — "the nearer due day wins" below: the other day would be Aug 8 again)
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
      // nearer the next day, paid on time, so the day before's (⚖️ default (c), built, not asked)
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
 * ⚖️ His decision 76 (2026-10-14, his answer, refines 73): THE NEARER DUE DAY WINS — the option he chose, word for
 * word: "A payment between two due days pays the one it's nearer to (a tie goes to the earlier one), unless the nearer
 * one is already paid on time." Of the shapes below he was shown the Car lease's only (Sep 2 pays Sep 15, an Oct 1
 * payment Oct 15), and the tie's rule. The split rent and the late rents are the review's of 844e484; Sep 19 and Jul 28
 * paying Jul 8 are the build's own (f8b5320, from its brief); the Oct 22 prepay and Sep 30 are the reviews' of
 * f8b5320..eb48365 and 7e36835. What his words leave unsaid — what a payment LEFT OVER pays — is pinned as three ⚖️
 * defaults built, not asked (2026-10-21): (a), (b) and (c) (`paymentFor`).
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

  /*
   * ⚖️ Default (c), built, not asked (2026-10-21): nearer the LATER day, which another payment paid ON TIME, a
   * payment is the EARLIER day's, late — the LATE default (2026-10-12) still reading it once his "unless" rules Aug 8
   * out, as 73 read it too. His answer says no more. Paying nothing instead would flip this test and
   * nearer-due-day.test.ts' (c) pins, and leave (a)'s and (b)'s green.
   */
  test("⚖️ (c) nearer the LATER day, paid ON TIME by another: the earlier day's, late — Jul 28 pays Jul 8", () => {
    const FPL = monthlyOn("2026-07-08");
    expect(graded([pay("2026-07-28"), pay("2026-08-08")], FPL, ["2026-07-08", "2026-08-08", "2026-09-08"])).toEqual([
      ["2026-07-08", "2026-07-28"],
      ["2026-08-08", "2026-08-08"],
      ["2026-09-08", null],
    ]);
  });

  // 🔴 decision 73 paid Nov 1 early with Oct 9 (Oct 1 paid by then): Nov 1 left Upcoming and the November forecast
  // ⚖️ default (a), built, not asked (below): paying the other day would pay Nov 1 early with Oct 9 again
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
   * ⚖️ Default (a), built, not asked (2026-10-21 — he said no more questions): a payment LEFT OVER, nearer the
   * EARLIER day, which another paid ON TIME, pays nothing — never the later day early — which is what keeps the split
   * rent's Nov 1 above. His answer, "unless the nearer one is already paid on time", says no more. Paying the other
   * day early would flip this test, the split rent's above and the Aug 4 test's Jul 12 together (and
   * nearer-due-day.test.ts' (a) pins), and leave the (b) and (c) tests green. 🔴 This takes back decision 73 here: run
   * against 7aca8e5's paymentFor, Oct 22 paid Nov 15 early (Oct 15 was paid by then).
   */
  test("⚖️ (a) nearer the EARLIER day, paid ON TIME, it pays nothing: a lease prepaid after an on-time Oct 15", () => {
    const LEASE = monthlyOn("2026-10-15");
    // Oct 22: 7 days after Oct 15, paid on time, 24 before Nov 15
    expect(graded([pay("2026-10-15"), pay("2026-10-22")], LEASE, ["2026-10-15", "2026-11-15"])).toEqual([
      ["2026-10-15", "2026-10-15"],
      ["2026-11-15", null],
    ]);
  });

  /*
   * ⚖️ Default (b), built, not asked (2026-10-21), apart from (a): nearer a day another paid EARLY, it pays nothing.
   * His answer does not reach it — Sep 15 is paid early, not on time — so changing (a) or (c) leaves this test green;
   * only changing (b) flips it, and the known gap's below with it. Not a regression: 73 owed Oct 15 here too.
   */
  test("⚖️ (b) nearer a day paid EARLY, it pays nothing: Sep 30 after an early Sep 2 leaves Oct 15 owed", () => {
    const LEASE = monthlyOn("2026-10-15");
    // Sep 30: 15 days either side — the tie, Sep 15's, which Sep 2 paid early
    expect(graded([pay("2026-09-02"), pay("2026-09-30")], LEASE, ["2026-09-15", "2026-10-15"])).toEqual([
      ["2026-09-15", "2026-09-02"],
      ["2026-10-15", null],
    ]);
  });

  /*
   * ⚖️ (b) at February's turn, for a bill due the 15th after an early Feb 15: a Feb 28, a Feb 29, or a Mar 1 outside a
   * leap year is Feb 15's — nearer it, or the tie — so it pays nothing and Mar 15 stays owed; a leap year's Mar 1 is
   * nearer Mar 15 and pays it. (A what-if: his lease has posted once, Sep 2.)
   */
  test("⚖️ (b) …at February's turn: a leap year's Feb 29 is Feb 15's, and so is Mar 1 outside one", () => {
    const LEAP = monthlyOn("2028-01-15");
    // 2028: Feb 15 → Mar 15 is 29 days — Feb 29 is 14 after Feb 15, 15 before Mar 15; Mar 1 is 15 after, 14 before
    expect(graded([pay("2028-02-02"), pay("2028-02-29")], LEAP, ["2028-02-15", "2028-03-15"])).toEqual([
      ["2028-02-15", "2028-02-02"],
      ["2028-03-15", null],
    ]);
    expect(graded([pay("2028-02-02"), pay("2028-03-01")], LEAP, ["2028-02-15", "2028-03-15"])).toEqual([
      ["2028-02-15", "2028-02-02"],
      ["2028-03-15", "2028-03-01"],
    ]);
    // 2027: Feb 15 → Mar 15 is 28 days — Mar 1 is 14 either side, the tie: Feb 15's
    const COMMON = monthlyOn("2027-01-15");
    expect(graded([pay("2027-02-02"), pay("2027-03-01")], COMMON, ["2027-02-15", "2027-03-15"])).toEqual([
      ["2027-02-15", "2027-02-02"],
      ["2027-03-15", null],
    ]);
  });

  // ⚖️ (b)'s other side: nearer the LATER day, paid EARLY by another — Oct 5, after Oct 1 paid Oct 15 — it pays no
  // Sep 15 late either: (c) asks only whether the later day was paid ON TIME
  test("⚖️ (b) …and nearer the LATER day, paid EARLY by another, it pays nothing: Oct 1 + Oct 5 owe Sep 15", () => {
    const LEASE = monthlyOn("2026-10-15");
    expect(graded([pay("2026-10-01"), pay("2026-10-05")], LEASE, ["2026-09-15", "2026-10-15", "2026-11-15"])).toEqual([
      ["2026-09-15", null],
      ["2026-10-15", "2026-10-01"],
      ["2026-11-15", null],
    ]);
  });

  /*
   * The review's shape (of 844e484): his June rent in two halves a day apart, then rents past their grace. Each late
   * rent pays its own month. ⚠️ The second half, Jun 17, is nearer Jul 1 and pays it early — a known gap neither 73
   * nor 76 catches (only rows within a few days as one payment, or a floor on an early payment's amount, would); and
   * Jul 8, nearer Jul 1, finds it paid and pays nothing. ⚖️ Default (b), built, not asked (above): Jul 1 is paid
   * EARLY, and paying the other day there would pay Aug 1 with Jul 8, Sep 1 with Aug 5, Oct 1 with Sep 6 and Nov 1
   * with Oct 7 — every late rent a month ahead of its own, Nov 1 gone from Upcoming.
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

  /*
   * ⚖️ default built, not asked (2026-10-23) — THE CATCH-UP: a payment that covered more than one charge (its posted
   * average names it, `paidAheadDays`; `Payment.coveredMore`) pays the unpaid due day on its OTHER side too. A premium
   * due the 11th, Sep 11 missed, then one payment of two premiums: between the two days it pays the one it lies nearer
   * (decision 76) and then the other; on time for Oct 11, Oct 11 and the missed Sep 11, late — never Nov 11, a day
   * still to come. 🔴 At 66daebd it paid one day and left the other unpaid, the twin of the two halves above (review
   * of 66daebd, 2026-10-23; nearer-due-day.test.ts pins what each surface read). Latent: no bill of his has one.
   */
  describe("⚖️ the catch-up — a payment of two charges pays the unpaid day on its other side", () => {
    const PREMIUM = monthlyOn("2026-09-11");
    const days = ["2026-08-11", "2026-09-11", "2026-10-11", "2026-11-11"];
    const twice = (postedOn: string): Payment => ({ ...pay(postedOn), coveredMore: true });
    const rows = (catchUp: Payment) => [...["2026-06-11", "2026-07-11", "2026-08-11"].map(pay), catchUp];
    /** …with Aug 11 missed too */
    const augMissed = (catchUp: Payment) => [...["2026-06-11", "2026-07-11"].map(pay), catchUp];
    // `stillToComeReader` asks no day after one (nothing late is asked of a day from today on)
    const ahead: DueDays = { ...PREMIUM, after: () => null };

    test("Sep 19, Sep 28 or Oct 12: the missed Sep 11 and its own Oct 11, whichever it lies nearer", () => {
      // Sep 19, 8 days after Sep 11: Sep 11's, late — and Oct 11's, early
      expect(graded(rows(twice("2026-09-19")), PREMIUM, days)).toEqual([
        ["2026-08-11", "2026-08-11"],
        ["2026-09-11", "2026-09-19"],
        ["2026-10-11", "2026-09-19"],
        ["2026-11-11", null],
      ]);
      // Sep 28, 13 days before Oct 11: Oct 11's, early — and Sep 11's, late
      expect(graded(rows(twice("2026-09-28")), PREMIUM, days)).toEqual([
        ["2026-08-11", "2026-08-11"],
        ["2026-09-11", "2026-09-28"],
        ["2026-10-11", "2026-09-28"],
        ["2026-11-11", null],
      ]);
      // Oct 12, inside Oct 11's grace: Oct 11's, on time — and Sep 11's, late; Nov 11 is still to come
      expect(graded(rows(twice("2026-10-12")), PREMIUM, days)).toEqual([
        ["2026-08-11", "2026-08-11"],
        ["2026-09-11", "2026-10-12"],
        ["2026-10-11", "2026-10-12"],
        ["2026-11-11", null],
      ]);
    });

    test("…only a payment that covered more than one charge: one of a single charge still pays one day", () => {
      expect(graded(rows(pay("2026-09-19")), PREMIUM, days).map(([, p]) => p)).toEqual([
        "2026-08-11",
        "2026-09-19",
        null,
        null,
      ]);
      expect(graded(rows(pay("2026-09-28")), PREMIUM, days).map(([, p]) => p)).toEqual([
        "2026-08-11",
        null,
        "2026-09-28",
        null,
      ]);
      expect(graded(rows(pay("2026-10-12")), PREMIUM, days).map(([, p]) => p)).toEqual([
        "2026-08-11",
        null,
        "2026-10-12",
        null,
      ]);
    });

    test("…only the unpaid day on its OTHER side: Car insurance's Sep 3, Aug 11 paid, pays no Oct 11", () => {
      // his shape: Aug 12 on time for Aug 11, then Sep 3's -$1,000.00, 8 days before Sep 11 — Sep 11's, early
      expect(graded([pay("2026-08-12"), twice("2026-09-03")], PREMIUM, days.slice(0, 3))).toEqual([
        ["2026-08-11", "2026-08-12"],
        ["2026-09-11", "2026-09-03"],
        ["2026-10-11", null],
      ]);
      // …with Aug 11 on its schedule and missed it is a catch-up of Aug 11, late
      expect(graded([twice("2026-09-03")], monthlyOn("2026-08-11"), days.slice(0, 3)).map(([, p]) => p)).toEqual([
        "2026-09-03",
        "2026-09-03",
        null,
      ]);
      // …and with none paid before it and its schedule opening on Sep 11, Aug 11 was no charge (below): Sep 11 alone
      expect(graded([twice("2026-09-03")], PREMIUM, days.slice(0, 3)).map(([, p]) => p)).toEqual([
        null,
        "2026-09-03",
        null,
      ]);
    });

    /*
     * ⚖️ default built, not asked (2026-10-23) — late for its own day, its second charge pays the UNPAID DAY BEHIND
     * first: a day ahead only once the day before its own is paid. 🔴 At 67b3b79 a late one always paid the day after,
     * early, whatever lay behind (review of 67b3b79; his ledger copy 2026-10-23 with this premium added on Venture X):
     * Aug 11 and Sep 11 missed, Sep 19 dropped Oct 11 from Upcoming and October's forecast on Sep 25 and left August ✕;
     * Sep 11 and Oct 11 missed, Oct 20 drew Nov 11 "paid early by its payment of Oct 20, 2026" and left Sep 11 ✕.
     */
    test("…after TWO missed charges, a late one pays both of them — never a day still to come", () => {
      // Aug 11 AND Sep 11 missed: Sep 19 pays Sep 11 late, its own, and Aug 11 behind it — never Oct 11
      expect(graded(augMissed(twice("2026-09-19")), PREMIUM, days)).toEqual([
        ["2026-08-11", "2026-09-19"],
        ["2026-09-11", "2026-09-19"],
        ["2026-10-11", null],
        ["2026-11-11", null],
      ]);
      // Sep 11 AND Oct 11 missed: Oct 20 pays Oct 11 late, its own, and Sep 11 behind it — never Nov 11
      expect(graded(rows(twice("2026-10-20")), PREMIUM, days)).toEqual([
        ["2026-08-11", "2026-08-11"],
        ["2026-09-11", "2026-10-20"],
        ["2026-10-11", "2026-10-20"],
        ["2026-11-11", null],
      ]);
      // with no day behind its own, it has nothing to catch up: it pays the day after, early — as one whose day behind
      // lies before its schedule opens (below)
      const noneBehind: DueDays = { ...PREMIUM, before: (d) => (d === "2026-10-11" ? "2026-09-11" : null) };
      expect(paymentFor([twice("2026-09-19")], "2026-09-11", noneBehind)?.postedOn).toBe("2026-09-19");
      expect(paymentFor([twice("2026-09-19")], "2026-10-11", noneBehind)?.postedOn).toBe("2026-09-19");
      // ⚠️ the known gap: only the day behind its own is asked — Aug 11 missed, Sep 11 paid, Oct 11 missed, and Oct 20
      // still pays Nov 11 early beside an unpaid Aug 11
      const gap = [...["2026-06-11", "2026-07-11", "2026-09-11"].map(pay), twice("2026-10-20")];
      expect(graded(gap, PREMIUM, days).map(([, p]) => p)).toEqual([null, "2026-09-11", "2026-10-20", "2026-10-20"]);
    });

    /*
     * ⚖️ default built, not asked (2026-10-23) — …and a day the payment of two BEFORE it paid early is paid: late for
     * its own day, the next one pays the day after too. 🔴 At 8348349 the day behind counted as paid only by its own
     * payment, so of two late payments of two in a row the second paid one day (review of 8348349; his ledger copy
     * 2026-10-23 with this premium added on Venture X, read through Oct 14): Jun 11 paid, then Jul 20 and Sep 20 each
     * -$715.16 — five charges, four days paid; on Sep 25 Upcoming listed Oct 11 and October's forecast held -$357.58,
     * and on Oct 23 October drew Oct 11 missed beside a page naming both as covering more than one month.
     */
    test("…two late ones two due days apart each pay their own day and the next: every charge pays a day", () => {
      const elevenths = ["2026-06-11", "2026-07-11", ...days, "2026-12-11", "2027-01-11"];
      const lates = ["2026-07-20", "2026-09-20", "2026-11-20"];
      for (let n = 1; n <= lates.length; n++) {
        const shape = [pay("2026-06-11"), ...lates.slice(0, n).map(twice)];
        // Jun 11 its own; then each late one its own day and the next — and the day after the last still to come
        const payer = (i: number) => (i === 0 ? "2026-06-11" : i <= 2 * n ? lates[Math.ceil(i / 2) - 1] : null);
        expect(graded(shape, PREMIUM, elevenths).map(([, p]) => p)).toEqual(elevenths.map((_, i) => payer(i)));
        // …as the readers that look ahead read it: the last one's second day is no longer coming
        expect(paymentFor(shape, elevenths[2 * n]!, ahead)?.postedOn).toBe(lates[n - 1]);
      }
      // the review's own: Jul 11 and Aug 11 paid, then Sep 20 and Nov 20 — Dec 11 is Nov 20's
      const later = [pay("2026-07-11"), pay("2026-08-11"), twice("2026-09-20"), twice("2026-11-20")];
      expect(graded(later, PREMIUM, ["2026-11-11", "2026-12-11", "2027-01-11"]).map(([, p]) => p)).toEqual([
        "2026-11-20",
        "2026-11-20",
        null,
      ]);
      expect(paymentFor(later, "2026-12-11", ahead)?.postedOn).toBe("2026-11-20");
    });

    /*
     * ⚠️ …but only two due days apart — THE KNOWN GAP (review of b6e11a76): of two ADJACENT late payments of two, the
     * later is asked first for its own late day (`nearerDaysPayment`, before the catch-up), the day the earlier one's
     * second charge paid ahead — so that charge pays no day: five charges, four days, the last one owed; with a third,
     * seven and five. Paying every one reads the run as one allocation, each payment pushing the next a day further
     * ahead, a day still to come at its end — not built (an owner's call, 2026-10-29). The error shows a paid day owed,
     * the safe direction. nearer-due-day.test.ts pins what each surface reads.
     */
    test("⚠️ the known gap: two ADJACENT late ones pay three days for four charges — the day after stays owed", () => {
      const adjacent = [pay("2026-06-11"), twice("2026-07-20"), twice("2026-08-20")];
      const five = ["2026-06-11", "2026-07-11", "2026-08-11", "2026-09-11", "2026-10-11"];
      // anchored Sep 11 (detection's step after Aug 20) or Jul 11, the same: Aug 11 is Aug 20's late, not Jul 20's
      for (const due of [PREMIUM, monthlyOn("2026-07-11")]) {
        expect(graded(adjacent, due, five).map(([, p]) => p)).toEqual([
          "2026-06-11",
          "2026-07-20",
          "2026-08-20",
          "2026-08-20",
          null,
        ]);
        expect(paymentFor(adjacent, "2026-10-11", { ...due, after: () => null })).toBeUndefined();
      }
      // …and with a third, Sep 20: seven charges, five days — Nov 11 and Dec 11 still to come
      const three = [...adjacent, twice("2026-09-20")];
      expect(graded(three, PREMIUM, [...five, "2026-11-11", "2026-12-11"]).map(([, p]) => p)).toEqual([
        "2026-06-11",
        "2026-07-20",
        "2026-08-20",
        "2026-09-20",
        "2026-09-20",
        null,
        null,
      ]);
    });

    /*
     * ⚖️ default built, not asked (2026-10-23) — …and a day before its schedule opens is no charge: before his date
     * (his date IS the schedule, whatever posted before it), or before detection's anchor and every payment of it (the
     * days before the ledger's first statement), no reader projects it and no payment was its, so a late payment of two
     * there pays the day after instead. 🔴 At 8348349 it paid that day behind (review of 8348349; his ledger copy
     * 2026-10-23, this premium on Venture X): started Aug 11 by his date, Aug 20 -$715.16 then Oct 11 -$357.58 — Aug
     * 20 paid Aug 11 and Jul 11, which no surface shows, September drew Sep 11 unsettled, and on Sep 25 the arrears
     * owed it $357.58 beside "Aug 20's -$715.16 covered more than one month" — and so with Jun 11 paid before his date.
     */
    test("…a day before its schedule opens is no charge: started Aug 11, Aug 20 pays Aug 11 and Sep 11", () => {
      const STARTED = hisDate("2026-08-11");
      const opening = [twice("2026-08-20"), pay("2026-10-11")];
      const afterJun11 = [pay("2026-06-11"), ...opening];
      const five = ["2026-07-11", "2026-08-11", "2026-09-11", "2026-10-11", "2026-11-11"];
      const paid = [null, "2026-08-20", "2026-08-20", "2026-10-11", null];
      expect(graded(opening, STARTED, five).map(([, p]) => p)).toEqual(paid);
      // …as the readers that look ahead read it: on Sep 1, Sep 11 is not still to come
      expect(paymentFor(opening, "2026-09-11", { ...STARTED, after: () => null })?.postedOn).toBe("2026-08-20");
      // …and with Jun 11 paid before his date: his date is the schedule, and Jul 11 no charge of it
      expect(graded(afterJun11, STARTED, five).map(([, p]) => p)).toEqual(paid);
      // …and anchored after it, as detection lays it, the first payment is where it opens
      expect(graded(opening, monthlyOn("2026-11-11"), five).map(([, p]) => p)).toEqual(paid);
      expect(graded(opening, monthlyOn("2026-08-11"), five).map(([, p]) => p)).toEqual(paid);
      // …but a day his date puts on the schedule is a charge: started Jul 11, Aug 20 catches it up and Sep 11 is owed
      const caughtUp = ["2026-08-20", "2026-08-20", null, "2026-10-11", null];
      expect(graded(opening, hisDate("2026-07-11"), five).map(([, p]) => p)).toEqual(caughtUp);
      // …and so, before detection's anchor, is one after a payment of it: Jun 11 paid, Jul 11 missed
      expect(graded(afterJun11, monthlyOn("2026-08-11"), five).map(([, p]) => p)).toEqual(caughtUp);
    });

    /*
     * ⚖️ default built, not asked (2026-10-29) — …and a payment of two LATE FOR A DAY BEFORE HIS DATE pays nothing on
     * his schedule: that day is no charge, so it has no payment to catch up from, and its second charge pays no day of
     * his early. 🔴 At b6e11a76 the day before his date was asked as the payment's own day, the day behind it settled
     * for lying before his date too (review of b6e11a76; his ledger copy 2026-10-29 with this premium added on Venture
     * X, read through Oct 14): Jun 11 and Jul 11 paid, Aug 11 and Sep 11 missed, Sep 19 -$715.16, then he typed Oct 11
     * — October drew Oct 11 "paid early by its payment of Sep 19, 2026"; on Sep 25 Upcoming listed Nov 11 alone and
     * October's forecast left it out; on Oct 29 nothing was owed and the runway read "A further $3,519.98 came due
     * earlier this month and no statement has covered it yet." — round 2's two-missed defect, back for his own date.
     */
    test("…late for a day before his date it pays none of his: typed Oct 11 after Sep 19, Oct 11 is owed", () => {
      const lateBefore = [...["2026-06-11", "2026-07-11"].map(pay), twice("2026-09-19")];
      const ahead = ["2026-10-11", "2026-11-11"];
      expect(graded(lateBefore, hisDate("2026-10-11"), ahead).map(([, p]) => p)).toEqual([null, null]);
      // …as the readers that look ahead read it: on Sep 25, Oct 11 is still to come
      expect(paymentFor(lateBefore, "2026-10-11", { ...hisDate("2026-10-11"), after: () => null })).toBeUndefined();
      // …as with detection's own Oct 11 and nothing typed: the day behind Sep 11, Aug 11, is a charge and unpaid
      expect(graded(lateBefore, monthlyOn("2026-10-11"), ahead).map(([, p]) => p)).toEqual([null, null]);
      // …and with only Sep 11 missed: his date still owes Oct 11, where detection's Oct 11 is Sep 19's second day
      const oneMissed = [...["2026-06-11", "2026-07-11", "2026-08-11"].map(pay), twice("2026-09-19")];
      expect(graded(oneMissed, hisDate("2026-10-11"), ahead).map(([, p]) => p)).toEqual([null, null]);
      expect(graded(oneMissed, monthlyOn("2026-10-11"), ahead).map(([, p]) => p)).toEqual(["2026-09-19", null]);
      // …but late for his date ITSELF it pays the day after (above), and EARLY for it, it is his date's own (decision
      // 76): Oct 1, nearer Oct 11 than Sep 11, pays it — its second charge nothing, a payment ahead is not read ahead
      const earlyForHis = [pay("2026-08-11"), twice("2026-10-01")];
      expect(graded(earlyForHis, hisDate("2026-10-11"), ahead).map(([, p]) => p)).toEqual(["2026-10-01", null]);
    });

    /*
     * ⚖️ default built, not asked (2026-10-23) — on time or early for its own day, a payment of two pays no day AFTER
     * it, whatever lies behind: it is not read ahead, so it takes no day still to come out of Upcoming or the forecast.
     * 🔴 Nothing pinned it with the day behind paid (review of 8348349): read as "late or on time", every test passed,
     * and Aug 11 paid, then -$715.16 on Sep 12 drew Oct 11 "paid early by Sep 12" and left Upcoming and October's
     * forecast without it.
     */
    test("…on time or early for its own day, the day behind paid, it pays no day after: Oct 11 still to come", () => {
      for (const on of ["2026-09-12", "2026-09-09", "2026-09-05"]) {
        expect(graded(rows(twice(on)), PREMIUM, days).map(([, p]) => p)).toEqual(["2026-08-11", on, null, null]);
        expect(paymentFor(rows(twice(on)), "2026-10-11", ahead)).toBeUndefined();
      }
    });

    test("…two due days at most, one of a single charge one — whatever the shape", () => {
      const year = ["2026-05-11", ...days, "2026-12-11", "2027-01-11"];
      const shapes: Payment[][] = [
        [twice("2026-09-19")],
        [pay("2026-06-11"), twice("2026-08-20"), twice("2026-09-19")],
        [twice("2026-07-20"), pay("2026-08-11"), twice("2026-10-20")],
        [pay("2026-06-11"), twice("2026-09-28"), twice("2026-10-20")],
        [twice("2026-06-20"), twice("2026-07-20"), twice("2026-08-20"), pay("2026-10-11")],
        [pay("2026-07-11"), twice("2026-08-03"), pay("2026-09-11"), twice("2026-10-12"), pay("2026-11-30")],
      ];
      for (const shape of shapes) {
        const paid = year.map((d) => paymentFor(shape, d, PREMIUM)).filter((p) => p !== undefined);
        for (const p of shape) expect(paid.filter((q) => q === p).length).toBeLessThanOrEqual(p.coveredMore ? 2 : 1);
      }
    });

    test("…and asked with no day after it, Oct 11 is still Sep 19's — as the readers that look ahead ask", () => {
      expect(paymentFor(rows(twice("2026-09-19")), "2026-10-11", ahead)?.postedOn).toBe("2026-09-19");
      expect(paymentFor(rows(pay("2026-09-19")), "2026-10-11", ahead)).toBeUndefined();
      // …and still to come where the day behind its own is unpaid: Aug 11 missed, or Sep 11 missed before Oct 20
      expect(paymentFor(augMissed(twice("2026-09-19")), "2026-10-11", ahead)).toBeUndefined();
      expect(paymentFor(rows(twice("2026-10-20")), "2026-11-11", ahead)).toBeUndefined();
      // …the day behind read as the calendar reads it, its own late payment too: Aug 20 pays Aug 11, so Oct 11 is paid
      const lateAug = [...["2026-06-11", "2026-07-11", "2026-08-20"].map(pay), twice("2026-09-19")];
      const lateAugPaid = ["2026-08-20", "2026-09-19", "2026-09-19", null];
      expect(graded(lateAug, PREMIUM, days).map(([, p]) => p)).toEqual(lateAugPaid);
      expect(paymentFor(lateAug, "2026-10-11", ahead)?.postedOn).toBe("2026-09-19");
    });
  });
});
