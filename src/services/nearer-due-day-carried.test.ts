import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { arrearsSentence } from "@/lib/committed";
import { billingCarriers } from "./billing-carriers";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import {
  bill,
  closeLedger,
  coming,
  labelsIn,
  marks,
  openLedger,
  owed,
  pay,
  RENT,
  rentWith,
  unpaid,
  UTIL,
} from "./nearer-due-day-fixture";
import { listSeries } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 76 (nearer-due-day.test.ts, which states it) on a bill billed INSIDE another (§6A 59, the utilities
 * billed with the rent): paid by its carrier's payments, each by the carrier's own test, and opening where the
 * carrier's schedule opens — split out of nearer-due-day.test.ts by subject (review of 68c837ce, L14). The last
 * describe goes on in nearer-due-day-paired.test.ts: each day of what the rent carries paired with the rent's own day
 * of that period (default (B), built, not asked, 2026-10-30).
 */

let bundle: DbBundle;
beforeEach(() => {
  ({ bundle } = openLedger());
});
afterEach(closeLedger);

/*
 * ⚖️ What is billed inside the rent is paid by the rent's payments (§6A 59 as recorded: "paid when the rent's payment of
 * the period posts", implied), each read by the rent's own test — unaffected: his rent posted Jul 8, Aug 4 and Sep 2,
 * each its own month's (Jul 8 a week late, nearer Jul 1 than Aug 1).
 */
describe("the utilities carried by the rent are paid with each month's rent payment, as before", () => {
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-07-01"), lastMatchedOn: "2026-09-02" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-07-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    pay("t-rent-jul", RENT, "2026-07-08", -228570);
    pay("t-rent-aug", RENT, "2026-08-04", -223711);
    pay("t-rent-sep", RENT, "2026-09-02", -229121);
  });

  test("Jul 1 late by Jul 8, Aug 1 by Aug 4, Sep 1 by Sep 2 — none early, nothing owed, Oct 1 still to come", () => {
    const TODAY = "2026-09-20";
    checkedThrough(bundle.db, "acct", "2026-09-19");
    expect(marks("2026-07", "2026-07-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-07-08", early: false }],
    ]);
    expect(marks("2026-08", "2026-08-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-08-04", early: false }],
    ]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-02", early: false }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming(TODAY, RENT)[0]).toBe("2026-10-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-10-01");
  });
});

/*
 * ⚖️ default built, not asked (2026-10-23) — …and a carrier's payment of TWO pays two of what it carries, as it pays
 * two of its own (`paymentFor`'s catch-up): a carried series' payments are the carrier's, each covering more than one
 * charge where the carrier's posted average names it (`BillPayment.coveredMore`, `carrierPaymentsBySeries`). 🔴 Nothing
 * pinned it (review of b6e11a76): read with every carried payment as one charge, the whole suite passed. ⚠️ His rent
 * cannot reach it — its payments carry the utilities, each above its -$2,109.00 and none at it, so its average names
 * none (a known gap, posted-average.test.ts): a what-if rent here, its rate what each month posts, utilities and all.
 */
describe("⚖️ a carrier's payment of two pays two days of what it carries, as two of its own", () => {
  const TODAY = "2026-10-23";
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "What-if (rent)", -229121, "2026-07-01"), lastMatchedOn: "2026-09-20" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-07-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    // Jul 1 and Aug 1 paid on time, Sep 1 missed, then two months at once
    pay("t-rent-jul", RENT, "2026-07-01", -229121);
    pay("t-rent-aug", RENT, "2026-08-02", -229121);
    pay("t-rent-sep20", RENT, "2026-09-20", -458242);
    checkedThrough(bundle.db, "acct", "2026-10-22");
  });

  test("Sep 20's -$4,582.42 pays the utilities' Sep 1 late and Oct 1 early, as the rent's: nothing owed", () => {
    expect(seriesDetail(bundle.db, RENT, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-20"]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-20", early: false }],
    ]);
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-20", early: true }],
      [RENT, "paid", { carrier: null, postedOn: "2026-09-20", early: true }],
    ]);
    expect(owed("2026-09-30")).toEqual([]);
    expect(owed(TODAY)).toEqual([]);
    // …and on Sep 25 neither is coming on Oct 1: the readers that look ahead read Sep 20 as its payment
    expect(coming("2026-09-25", RENT)[0]).toBe("2026-11-01");
    expect(coming("2026-09-25", UTIL)[0]).toBe("2026-11-01");
  });
});

/*
 * ⛔ …and where a carried series' schedule OPENS is its carrier's — on the day of its own the carrier's opening day
 * falls due with, the one the carrier's payment of it pays: on the carrier's date he typed, that day; on detection's,
 * the earlier of that day and its own (`openingOf`; the days apart, below). His date on the rent: a day of the rent's
 * before it is no charge, nor a day of what it carries before the day of its own that falls due with it — a day that
 * may lie before the rent's date itself: their Nov 1 for the rent's Nov 2, a charge (below) — so no payment of the
 * rent's catches one up, none is projected (below), and one payment pays the same days of the rent and of what it
 * carries. ⚖️ default built, not asked (2026-10-29), read off §6A 59 as recorded, "paid when the rent's payment of the
 * period posts" (implied). 🔴 At 4d6ec2ac the his-date guard read the carried series' own row (review of 4d6ec2ac): a
 * what-if rent at -$2,291.21 typed Oct 1, the utilities carried on detection's Oct 1 — his ledger's shape, the rent
 * typed Sep 1 and the utilities detected Sep 1 — Jul 1 and Aug 2 paid, then Sep 10 -$4,582.42: October drew the rent's
 * Oct 1 missed beside "Rent utilities & fees paid … with the rent's payment of Sep 10 (early)", the arrears owed the
 * rent $2,291.21 and not the utilities, the runway read "A further $2,291.21 came due earlier this month and has not
 * posted.", and on Sep 25 Upcoming listed the rent's Oct 1 and Nov 1 but the utilities' Nov 1 alone, October's
 * forecast the rent without them. And through `couldHaveCharged`, at 32aeb3a9 too: Oct 10's two months, late for his
 * Oct 1 itself, drew the rent's Nov 1 "paid early by Oct 10" while the utilities' Nov 1 stayed upcoming. Latent: his
 * rent names no payment of two (the known gap above). 🔴 This note said no day of what the rent carries before the
 * rent's date is a charge or projected — 0ac5d059's rule, untrue since (review of 46f19f15, L59).
 */
describe("⛔ …and what a carrier carries opens where the carrier's schedule opens — his date on the rent", () => {
  const TODAY = "2026-10-23";
  /** neither Oct 1 paid by Sep 10: both still to come on Sep 25, and both owed on Oct 23, never posted */
  const bothOct1sComeThenAreOwed = (): void => {
    // on Sep 25 both Oct 1s are still to come: Upcoming and October's forecast count the rent AND what it carries
    expect(coming("2026-09-25", RENT)).toEqual(["2026-10-01", "2026-11-01"]);
    expect(coming("2026-09-25", UTIL)).toEqual(["2026-10-01", "2026-11-01"]);
    expect(labelsIn("2026-10", "2026-09-25")).toEqual(
      expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]),
    );
    // …and on Oct 23, never posted, both are owed: the calendar, the arrears and the runway
    expect(unpaid("2026-10", "2026-10-01", TODAY).sort()).toEqual([RENT, UTIL]);
    expect(owed(TODAY)).toEqual([
      [UTIL, "2026-10-01", 18221],
      [RENT, "2026-10-01", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $2,473.42 came due earlier this month and has not posted.",
    );
  };

  test("he typed Oct 1, Sep 10 two months late for Sep 1: neither Oct 1 is paid — both coming, then both owed", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-10-01" }, "2026-07-01", "2026-08-02", "2026-09-10");
    expect(seriesDetail(bundle.db, RENT, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-10"]);
    bothOct1sComeThenAreOwed();
  });

  /*
   * ⛔ …and the carrier's opening is its DAY, not only whether that day is his. 🔴 Nothing pinned it (review of
   * d7a5485c): every pin here put the rent and what it carries on one date, so a builder keeping the utilities' own
   * opening, taking only "his" from the rent, passed the whole suite (449 files, 9,784 tests, the review's run). On his
   * ledger copy 2026-10-29 with this what-if added on Wells Fargo (read through Sep 24) — the rent typed Oct 1, the
   * utilities still on detection's Sep 1, his ledger's shape should he retype only the rent (it is typed Sep 1, they
   * are detected Sep 1) — October drew their Oct 1 "paid … with the rent's payment of Sep 10 (early)" beside the rent's
   * Oct 1 "?"; on Sep 25 Upcoming listed their Nov 1 alone and October's forecast held the rent without them; on Oct 29
   * the arrears owed the rent alone and the runway read "A further $5,811.19 came due earlier this month and no
   * statement has covered it yet." Now both Oct 1s are drawn "?" there, and it reads "A further $5,993.40 …".
   */
  test("…and what it carries still on detection's Sep 1 opens at his Oct 1 too: Sep 10 pays neither Oct 1", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-09-10");
    // no day of the rent's lies before Oct 1, nor of what it carries: their own Sep 1 is drawn nowhere (below)
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([]);
    bothOct1sComeThenAreOwed();
  });

  /*
   * ⚖️ …and no day of what it carries is PROJECTED before the day it opens on — its day falling due with the rent's
   * date, here their Oct 1 for the rent's Oct 1 (their Nov 1 for a rent typed Nov 2, below): where a carried series'
   * schedule opens, when that lies after its own anchor, is where every reader's projection of it starts
   * (`DueDays.opensOn`, `projectOccurrences`) — default built, not asked (2026-10-29), read off the default above: a day
   * no payment of the rent's can catch up is a day no reader draws, owes or lists. 🔴 At 68c837ce their own detected Sep
   * 1 still opened their projection (review of 68c837ce): projected, so graded as a charge, and no charge to the
   * catch-up. A payment of two on time for his Oct 1 — Oct 2 -$4,582.42, which the rent's page names as covering more
   * than one month — paid their Oct 1, and September drew their Sep 1 "missed", owed $182.21. On his ledger copy
   * 2026-10-29 with this what-if added on Wells Fargo (read through Oct 26), the runway on Sep 25 read "A further
   * $347.08 came due earlier this month: $182.21 has not posted, and no statement has covered the other $164.87 yet."
   * Now September draws nothing of theirs, and it reads "A further $164.87 came due earlier this month and no statement
   * has covered it yet." — his own bills, as with the rent on detection's Oct 1 (the review's first control, below).
   * The rent's own reading of Oct 2 is unchanged: its Oct 1, and no day before his date. 🔴 "Before the rent's date"
   * was 0ac5d059's rule, untrue since (review of 46f19f15, L59).
   */
  test("…and Oct 2's two months, on time for his Oct 1: what it carries draws no Sep 1, missed or owed", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-10-02");
    expect(seriesDetail(bundle.db, RENT, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-10-02"]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([]);
    expect(owed("2026-09-25")).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, "2026-09-25"))).toBeNull();
    // …and Oct 2 pays both Oct 1s on time: nothing owed on Oct 23, Nov 1 next for both
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming(TODAY, RENT)[0]).toBe("2026-11-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-11-01");
  });

  /*
   * …and the review's two controls, the same rows. The rent on detection's Oct 1: a day before a date detection gave
   * is a charge once a payment has posted — Jul 1 here — so their own Sep 1 is one, where their projection starts, and
   * Oct 2's two months pay it, late, beside their Oct 1 on time.
   */
  test("…and the rent on detection's Oct 1: their own Sep 1 is a charge, paid with Oct 1 by Oct 2's two", () => {
    rentWith({ rentOn: "2026-10-01", typed: false, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-10-02");
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
    ]);
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
    ]);
    expect(owed("2026-09-25")).toEqual([]);
    expect(owed(TODAY)).toEqual([]);
  });

  /*
   * …and their own row read as the rent's (the second control, the carried series read off its own row as at
   * 4d6ec2ac): the rent typed on their own Sep 1 — his ledger's shape, the rent typed Sep 1 and the utilities detected
   * Sep 1 — so the two open on one day, and Oct 2's two months pay Sep 1, late, and Oct 1 of both.
   */
  test("…and the rent typed on their own Sep 1, his ledger's shape: Oct 2's two months pay Sep 1 of both", () => {
    rentWith({ rentOn: "2026-09-01", typed: true, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-10-02");
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
      [RENT, "paid", { carrier: null, postedOn: "2026-10-02", early: false }],
    ]);
    expect(owed("2026-09-25")).toEqual([]);
    expect(owed(TODAY)).toEqual([]);
  });

  /*
   * …and with no payment of two at all the same: what it carries opens at his Oct 1 on every reader, as the rent does.
   * 🔴 At 68c837ce their own Sep 1 opened them (review of 68c837ce). On his ledger copy 2026-10-29 with these rows added
   * on Wells Fargo, on Aug 25 Upcoming listed their Sep 1 without the rent, September's forecast held them at -$182.21
   * and the rent not at all, and their page and the All tab named Sep 1 next; on Sep 25 September drew it "?" and the
   * runway read "A further $347.08 came due earlier this month: $182.21 has not posted, and no statement has covered
   * the other $164.87 yet." Now every one opens at Oct 1 with the rent, and the runway reads "A further $164.87 …".
   */
  test("…and with no payment of two, what it carries on detection's Sep 1 opens at his Oct 1 on every reader", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-09-01", noneOfTwo: true }, "2026-07-01", "2026-08-02");
    // on Aug 25 the readers that look ahead list Oct 1 first for both — Upcoming, September's forecast, their page's
    // list and its sentence, and the All tab's Next
    expect(coming("2026-08-25", RENT)).toEqual(["2026-10-01"]);
    expect(coming("2026-08-25", UTIL)).toEqual(["2026-10-01"]);
    expect(labelsIn("2026-09", "2026-08-25")).not.toContain("Rent utilities & fees");
    const page = seriesDetail(bundle.db, UTIL, "2026-08-25")!;
    // …on one day with the rent's, so the sentence says no other it falls due on (`nextFallsDueOn`)
    expect([page.nextExpected[0]!.date, page.nextExpectedOn, page.nextFallsDueOn]).toEqual([
      "2026-10-01",
      "2026-10-01",
      null,
    ]);
    expect(listSeries(bundle.db, "2026-08-25").find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-10-01");
    // …and read past Sep 1, September draws nothing of theirs and owes nothing
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([]);
    expect(owed("2026-09-25")).toEqual([]);
  });

  test("…and the rent typed further on, Dec 1: their page lists three dates from Dec 1, as the rent's does", () => {
    rentWith({ rentOn: "2026-12-01", typed: true, utilOn: "2026-09-01", noneOfTwo: true }, "2026-07-01", "2026-08-02");
    const next = (id: string) => seriesDetail(bundle.db, id, "2026-08-25")!.nextExpected.map((o) => o.date);
    expect(next(UTIL)).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(next(UTIL)).toEqual(next(RENT));
  });

  test("…and Oct 10's two months, late for his Oct 1 itself, pay both Nov 1s early as they pay the rent's", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-10-01" }, "2026-07-01", "2026-08-02", "2026-10-10");
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-10", early: false }],
    ]);
    expect(marks("2026-11", "2026-11-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-10", early: true }],
      [RENT, "paid", { carrier: null, postedOn: "2026-10-10", early: true }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming(TODAY, RENT)[0]).toBe("2026-12-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-12-01");
  });

  test("…and HIS date on what it carries alone opens nothing of the rent's: Sep 10 pays both Oct 1s early", () => {
    // the rent on detection's Oct 1, Sep 1 a charge of its (Jul 1 and Aug 2 posted before it), the utilities typed
    rentWith(
      { rentOn: "2026-10-01", typed: false, utilOn: "2026-10-01", utilTyped: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-10",
    );
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-10", early: true }],
      [RENT, "paid", { carrier: null, postedOn: "2026-09-10", early: true }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming("2026-09-25", RENT)[0]).toBe("2026-11-01");
    expect(coming("2026-09-25", UTIL)[0]).toBe("2026-11-01");
  });

  /*
   * ⚖️ …and where it opens is a day of its OWN, the one that falls due with the rent's date: while no payment of that
   * date has posted — none has here, November unpaid — its due day nearest the date, a tie the earlier, as his decision
   * 76 reads a payment between two due days; once one has, the day that payment pays (below; `openingOf`, default
   * built, not asked, 2026-10-29) — so the rent's first month carries its first charge, whichever day of the month each
   * is on. 🔴 At 0ac5d059 the floor cut by DATE, not by period (review of 0ac5d059): the rent typed Nov 2, the day his
   * posts (Sep 2, Oct 2), the utilities on detection's Sep 1 — their Nov 1, the charge the rent's Nov 2 carries, lay
   * before Nov 2 and was drawn, owed and listed nowhere: on Oct 29 Upcoming listed their Dec 1 first beside the rent's
   * Nov 2, November's forecast left them out and their page and the All tab named Dec 1; on Nov 20 the arrears owed the
   * rent alone, "A further $2,291.21 came due earlier this month and has not posted." The forbidden direction: an owed
   * charge hidden. Pinned with the two on different days of the month; every pin before put them on one.
   */
  test("…and the rent typed Nov 2, what it carries on the 1st opens on Nov 1: listed, forecast, then owed", () => {
    rentWith(
      { rentOn: "2026-11-02", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    const OCT29 = "2026-10-29";
    // on Oct 29 the readers that look ahead name their Nov 1 with the rent's Nov 2 — the day it falls due (default (B),
    // 2026-10-30; their own Nov 1 until the review of aa05a56d): Upcoming, November's forecast, their page's list, the
    // All tab's Next — its sentence's editor their own Nov 1 — and a year of twelve charges, not eleven
    expect(coming(OCT29, UTIL)).toEqual(["2026-11-02", "2026-12-02"]);
    expect(coming(OCT29, RENT)).toEqual(["2026-11-02", "2026-12-02"]);
    expect(labelsIn("2026-11", OCT29)).toEqual(expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]));
    const page = seriesDetail(bundle.db, UTIL, OCT29)!;
    expect([page.nextExpectedOn, page.nextExpected.map((o) => o.date)]).toEqual([
      "2026-11-01",
      ["2026-11-02", "2026-12-02", "2027-01-02"],
    ]);
    // …and the sentence says the day it falls due beside its own 1st: "due with the rent on the 2nd" (review of
    // a456a6fc — it said the 1st alone over a list of 2nds)
    expect(page.nextFallsDueOn).toBe("2026-11-02");
    expect(page.annualizedCents).toBe(12 * 18221);
    expect(listSeries(bundle.db, OCT29).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-11-02");
    // …and on Nov 20, read through Nov 19 with neither posted, both are owed: the calendar, the arrears, the runway
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    expect(unpaid("2026-11", "2026-11-02", NOV20).sort()).toEqual([RENT, UTIL]);
    expect(owed(NOV20)).toEqual([
      [UTIL, "2026-11-02", 18221],
      [RENT, "2026-11-02", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBe(
      "A further $2,473.42 came due earlier this month and has not posted.",
    );
  });

  /*
   * …and the same root through the catch-up (`liesBeforeHisDate`), already at ae29cda4: November missed, Dec 10 two
   * months. 🔴 Their Nov 1 lay before the rent's Nov 2, so it was no charge and the day behind their Dec 1 read as
   * settled: Dec 10 paid their Dec 1 late and their Jan 1 early, beside the rent's Nov 2 and Dec 2 — on Dec 20 January
   * drew their Jan 1 "paid early by Dec 10" while the rent's Jan 2 stayed to come, Upcoming listed their Feb 1 next and
   * the All tab named it (ae29cda4 still drew their Nov 1 unpaid beside it, 0ac5d059 nowhere). Now Dec 10 pays the two
   * months it pays the rent: their Nov 1 and Dec 1, and their Jan 1 is still to come with the rent's Jan 2.
   */
  test("…and November missed, Dec 10's two months pay their Nov 1 and Dec 1 as the rent's: no Jan 1 early", () => {
    rentWith(
      { rentOn: "2026-11-02", typed: true, utilOn: "2026-09-01" },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-12-10",
    );
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    expect(seriesDetail(bundle.db, RENT, DEC20)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-12-10"]);
    // each drawn and named on the rent's day it falls due with (default (B); its own 1st until the review of aa05a56d)
    const theirs = (key: string, day: string) => marks(key, day, DEC20).filter(([id]) => id === UTIL);
    expect(theirs("2026-11", "2026-11-02")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-10", early: false }],
    ]);
    expect(theirs("2026-12", "2026-12-02")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-10", early: false }],
    ]);
    expect(theirs("2027-01", "2027-01-02")).toEqual([[UTIL, "upcoming", null]]);
    expect(owed(DEC20)).toEqual([]);
    expect(coming(DEC20, UTIL)[0]).toBe("2027-01-02");
    expect(coming(DEC20, RENT)[0]).toBe("2027-01-02");
    expect(listSeries(bundle.db, DEC20).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-02");
  });

  /*
   * ⚖️ …and the day of their own that falls due with the rent's date is the one the rent's PAYMENT of that date pays —
   * their due day nearest that payment, as his decision 76 reads one between two due days (the day behind it for a
   * payment of two that caught the rent's day up from its next: Dec 20's, below); only while none has posted, the one
   * nearest the date itself, a tie the earlier (`openingOf`, default built, not asked, 2026-10-29). 🔴 At
   * ec7fd198 it was read off the date alone (review of ec7fd198): the rent posts a day or more after its date (Sep 2,
   * Oct 2, Jul 8, Aug 4 on his ledger), and one a day past a date on the 15th or 16th lies nearer the NEXT 1st — the
   * rent typed Nov 16 (the tie) or Nov 15 (nearer Nov 1), paid Nov 17 on time, opened the utilities on Nov 1, which no
   * payment of the rent's pays: on Nov 20 November drew their Nov 1 missed, the arrears owed [util, Nov 1, $182.21] and
   * the runway read "A further $182.21 came due earlier this month and has not posted." beside a rent paid in full,
   * while December drew their Dec 1 paid early by Nov 17 — a month shown owed for good. 0ac5d059 read this shape so.
   */
  test.each([
    ["2026-11-16", "the tie"],
    ["2026-11-15", "nearer Nov 1"],
  ])("…and the rent typed %s (%s), paid Nov 17: what it carries opens on Dec 1, which Nov 17 pays", (rentOn) => {
    rentWith(
      { rentOn, typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-17",
    );
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    // Nov 17 paid the rent's first day, on time: its own day, that one
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-17", dueDaysPast: 0 });
    // November draws nothing of theirs and owes nothing: their Nov 1 lies before the day Nov 17 opens them on
    expect(marks("2026-11", "2026-11-01", NOV20)).toEqual([]);
    expect(owed(NOV20)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBeNull();
    // …and Nov 17 pays their Dec 1 early, as the rent's own first month: Jan 1 next, beside the rent's December day
    expect(marks("2026-12", "2026-12-01", NOV20)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-17", early: true }],
    ]);
    expect(coming(NOV20, UTIL)[0]).toBe("2027-01-01");
    expect(listSeries(bundle.db, NOV20).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-01");
  });

  /*
   * …and the review's control, the same rows: paid ON Nov 16, the tie's own day — 15 days after their Nov 1, 15
   * before Dec 1 — the payment pays Nov 1, late, so Nov 1 opens them, and Dec 1 still comes.
   */
  test("…and paid ON Nov 16: Nov 16 pays their Nov 1, late — they open there, Dec 1 still to come", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-16", dueDaysPast: 0 });
    // drawn on the rent's Nov 16 their Nov 1 falls due with, and Dec 1 next with its Dec 16 (default (B); their own
    // 1st until the review of aa05a56d)
    expect(marks("2026-11", "2026-11-01", NOV20)).toEqual([]);
    expect(marks("2026-11", "2026-11-16", NOV20).filter(([id]) => id === UTIL)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-16", early: false }],
    ]);
    expect(owed(NOV20)).toEqual([]);
    expect(coming(NOV20, UTIL)[0]).toBe("2026-12-16");
  });

  /*
   * ⛔ …and while no payment of the rent's Nov 16 has posted, their day nearest it opens them — the tie, the earlier
   * (ec7fd198's reading, kept): owed with the rent once read past, the safe side. The payment then says which day was
   * theirs. ⛔ Money back is no payment of it (`PaymentDays.paid`): +$2,291.21 back on Nov 17, a day past the tie, read
   * as one would open them on Dec 1 and take their Nov 1 out of what is owed beside the rent's.
   */
  test.each([
    ["nothing posted", null],
    ["+$2,291.21 back on Nov 17", 229121],
  ])("…and the rent's Nov 16 not yet paid (%s): the tie opens them on Nov 1, owed with it", (_, backCents) => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    if (backCents !== null) pay("t-rent-back", RENT, "2026-11-17", backCents);
    checkedThrough(bundle.db, "acct", "2026-11-22");
    const NOV23 = "2026-11-23";
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toBeNull();
    // owed, drawn and named on the rent's Nov 16 their Nov 1 falls due with (default (B); their own Nov 1 until the
    // review of aa05a56d)
    expect(unpaid("2026-11", "2026-11-01", NOV23)).toEqual([]);
    expect(unpaid("2026-11", "2026-11-16", NOV23).sort()).toEqual([RENT, UTIL]);
    expect(owed(NOV23)).toEqual([
      [UTIL, "2026-11-16", 18221],
      [RENT, "2026-11-16", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, NOV23))).toBe(
      "A further $2,473.42 came due earlier this month and has not posted.",
    );
  });

  /*
   * ⛔ …and what paid the rent's first day is read by the rent's own test, HIS date included: Oct 20's two months, late
   * for its Oct 16 — a day before his Nov 16, no charge, nothing a payment of two catches up from (`liesBeforeHisDate`)
   * — paid no day of his, so his Nov 16 is owed on Nov 23 and nothing is read off Oct 20 for what it carries. Read
   * without his date, Oct 20 would pay Nov 16 as its second charge, the day after its own Oct 16.
   */
  test("…and Oct 20's two months before his Nov 16 paid no day of his: nothing opens them off it", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01" },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-20",
    );
    checkedThrough(bundle.db, "acct", "2026-11-22");
    const NOV23 = "2026-11-23";
    expect(seriesDetail(bundle.db, RENT, NOV23)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-10-20"]);
    expect(owed(NOV23)).toContainEqual([RENT, "2026-11-16", 229121]);
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toBeNull();
  });

  /*
   * ⚖️ …and a payment of two that caught the rent's first day up from its next pairs their days the same way: Dec 20,
   * late for the rent's Dec 16 (nearer it), pays its Nov 16 too; nearer their Jan 1, it pays Jan 1 early and the day
   * behind it, Dec 1 — so Dec 1, the day behind the one nearest it, opens them, and their Nov 1 is no charge (default
   * built, not asked, 2026-10-29). 🔴 At ec7fd198 Nov 1 opened them, and November drew it missed beside the two months
   * Dec 20 paid; read off the payment's nearest day alone (Jan 1), their Dec 1 — the charge the rent's Nov 16 carries —
   * would be drawn, owed and listed nowhere.
   */
  test("…and November missed, Dec 20's two months open them on Dec 1: paid with Jan 1, no Nov 1 drawn", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01" },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-12-20",
    );
    checkedThrough(bundle.db, "acct", "2026-12-26");
    const DEC27 = "2026-12-27";
    expect(seriesDetail(bundle.db, RENT, DEC27)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-12-20"]);
    // Dec 20 paid the rent's Nov 16 as the day behind its own, Dec 16 — one of the rent's days past it
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-12-20", dueDaysPast: 1 });
    expect(marks("2026-11", "2026-11-01", DEC27)).toEqual([]);
    expect(marks("2026-12", "2026-12-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-20", early: false }],
    ]);
    expect(marks("2027-01", "2027-01-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-20", early: true }],
    ]);
    expect(owed(DEC27)).toEqual([]);
    expect(coming(DEC27, UTIL)[0]).toBe("2027-02-01");
    expect(coming(DEC27, RENT)[0]).toBe("2027-01-16");
  });

  /*
   * ⛔ …and the rent's date BEFORE their own still opens them there: every day of theirs from it on is a charge. 🔴
   * Nothing pinned it (review of 0ac5d059): every pin put the rent's date on or after theirs, so reading the LATER of
   * the two — their own Nov 1 — passed every test (430 files, 9,551 tests, the review's run), and a payment of two
   * caught nothing up and paid a day still to come: the rent typed Sep 1, their own Nov 1 — what a Save of their date
   * editor with nothing changed types, as it opens on Nov 1 (his ledger copy 2026-10-29) — Jul 1, Aug 2 and Sep 2 at
   * the rate, Oct 1 missed, Nov 10 two months: their Dec 1 read as paid early by Nov 10, and Upcoming listed their
   * Jan 1 first beside the rent's Dec 1. Their Oct 1 is a charge, as the rent's is, so Nov 10 pays it and their Nov 1,
   * and Dec 1 still comes for both.
   */
  test.each([
    ["he typed", true],
    ["detection's", false],
  ])("…and the rent typed Sep 1, what it carries on %s Nov 1: Nov 10's two months pay no Dec 1", (_, utilTyped) => {
    rentWith(
      { rentOn: "2026-09-01", typed: true, utilOn: "2026-11-01", utilTyped },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-11-10",
    );
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    expect(seriesDetail(bundle.db, RENT, NOV20)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-11-10"]);
    expect(marks("2026-11", "2026-11-01", NOV20)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-10", early: false }],
    ]);
    expect(marks("2026-12", "2026-12-01", NOV20)).toEqual([
      [UTIL, "upcoming", null],
      [RENT, "upcoming", null],
    ]);
    expect(owed(NOV20)).toEqual([]);
    expect(coming(NOV20, UTIL)).toEqual(["2026-12-01", "2027-01-01"]);
    expect(coming(NOV20, RENT)).toEqual(["2026-12-01", "2027-01-01"]);
  });

  /*
   * 🔴 …and what paid the rent's first day was read off its NEAREST rent day, not the branch of `paymentFor` that
   * found it (review of 46f19f15): a payment of ONE month, late for the rent's first day by default (c) — nearer its
   * next day, which another payment paid on time — read as one day past it, so the utilities opened a day of theirs
   * BEHIND the one it pays, on a day no payment pays. The rent typed Nov 25, Dec 12 then Dec 25 (rows of Jun 25 to Aug
   * 25 before his date): `opensPaidBy` read {Dec 12, 1}, and on Dec 27 November drew their Nov 1 missed beside the
   * rent's Nov 25 paid by Dec 12 — a ✕ that moved from the rent to the utilities once Dec 25 posted (ec7fd198 drew
   * nothing there). So too the rent typed Nov 18, Dec 4 then Dec 18, and the 16th, Dec 3 then Dec 16 — a month owed
   * for good beside a rent paid. With the rent's row before his date on Oct 26, their extra Nov 1 was drawn "paid …
   * Oct 26 (early)", a posting that paid no day of his. Now each opens them on their Dec 1, the day that payment pays,
   * and each rent payment pays one month of theirs (default (B), nearer-due-day-paired.test.ts).
   */
  // the rent's date, its rows before it, its late payment of that date, and its on-time payment of the next
  test.each([
    {
      rentOn: "2026-11-25",
      rows: "Jun 25 to Aug 25",
      before: ["2026-06-25", "2026-07-25", "2026-08-25"],
      late: "2026-12-12",
      next: "2026-12-25",
    },
    {
      rentOn: "2026-11-25",
      rows: "Jun 25, Jul 25 and Oct 26",
      before: ["2026-06-25", "2026-07-25", "2026-10-26"],
      late: "2026-12-12",
      next: "2026-12-25",
    },
    {
      rentOn: "2026-11-18",
      rows: "Jun 18 to Aug 18",
      before: ["2026-06-18", "2026-07-18", "2026-08-18"],
      late: "2026-12-04",
      next: "2026-12-18",
    },
    {
      rentOn: "2026-11-16",
      rows: "Jul 1 to Oct 2",
      before: ["2026-07-01", "2026-08-02", "2026-09-02", "2026-10-02"],
      late: "2026-12-03",
      next: "2026-12-16",
    },
  ])("…and the rent typed $rentOn ($rows before it), paid late by (c): their Dec 1 opens them", (shape) => {
    const { rentOn, before, late, next } = shape;
    rentWith({ rentOn, typed: true, utilOn: "2026-09-01", noneOfTwo: true }, ...before, late, next);
    checkedThrough(bundle.db, "acct", "2026-12-26");
    const DEC27 = "2026-12-27";
    // November draws nothing of theirs: no ✕ beside the rent paid late, no row before his date paying a day of theirs
    expect(marks("2026-11", "2026-11-01", DEC27)).toEqual([]);
    expect(recurringCalendar(bundle.db, "2026-11", DEC27).missedCount).toBe(0);
    // …the late payment was the rent's first day's own: its own day is that one
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: late, dueDaysPast: 0 });
    // …and each rent payment pays one month of theirs: the late one their Dec 1, the next their Jan 1, early
    expect(marks("2026-12", "2026-12-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: late, early: false }],
    ]);
    expect(marks("2027-01", "2027-01-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: next, early: true }],
    ]);
    expect(owed(DEC27)).toEqual([]);
    expect(coming(DEC27, UTIL)[0]).toBe("2027-02-01");
  });
});
