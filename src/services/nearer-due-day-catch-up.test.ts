import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { arrearsSentence } from "@/lib/committed";
import { arrearsThisMonth } from "./arrears";
import { billPaymentsBySeries } from "./billing-carriers";
import { budgetTail } from "./budgets";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { forecastForMonth } from "./forecast";
import {
  bill,
  closeLedger,
  coming,
  FPL,
  marks,
  openLedger,
  owed,
  pay,
  seriesWith,
  unpaid,
} from "./nearer-due-day-fixture";
import { listSeries } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 76 (nearer-due-day.test.ts, which states it) for ONE PAYMENT OF TWO CHARGES: the catch-up — a
 * payment its posted average names as covering more than one pays two due days (`paymentFor`, default built, not
 * asked, 2026-10-23) — and the one rule that names it (`paidAheadDays`). Split out of nearer-due-day.test.ts by
 * subject (review of 68c837ce, L14). Jul 10 −$14.21 and Jul 28 −$56.22 are every FPL posting on his ledger, on Chase
 * Checking, read only through Aug 12 (his copy, re-read 2026-11-04): every other FPL payment below is a what-if.
 */

let bundle: DbBundle;
let categoryId: string;
beforeEach(() => {
  ({ bundle, categoryId } = openLedger());
});
afterEach(closeLedger);

/*
 * ⚖️ default built, not asked (2026-10-23) — A LATE CATCH-UP PAYS BOTH DUE DAYS IT COVERED: a premium of -$357.58 due
 * the 11th, paid Jun 11, Jul 11 and Aug 11, Sep 11 missed, then ONE -$715.16 that holds Sep 11's and Oct 11's — the
 * payment its posted average names, "covered more than one month" (`paidAheadDays`) — pays the day it lies nearer
 * (⚖️ his decision 76) and the unpaid day on its other side (`paymentFor`'s catch-up), on every grader: the calendar,
 * the arrears (the runway, the bill's "Already due"), and the readers that look ahead (Upcoming, the forecast). 🔴 At
 * 66daebd one payment paid one due day, and wherever it posted one day it paid was drawn unpaid (review of 66daebd).
 * Measured on his ledger copy 2026-10-23 with this premium added on Venture X (read through Oct 14): Sep 19 left Oct 11
 * missed, the runway reading "A further $3,877.56 came due earlier this month: $357.58 has not posted, and no
 * statement has covered the other $3,519.98 yet." and the series page "Already due, and not posted" beside "posted avg
 * -$446.98 · Sep 19's -$715.16 covered more than one month"; Sep 28 drew Sep 11 missed and owed it $357.58 on Sep 30,
 * two days after it was paid; Oct 12 drew Sep 11 missed. Latent: no bill of his has a catch-up — Car insurance's Sep 3
 * -$1,000.00 posted before Sep 11 was due, and his own date starts its schedule at Dec 11.
 */
describe("⚖️ a late catch-up — two premiums in one payment after a missed month — pays both due days", () => {
  const PREMIUM = "premium";
  const TODAY = "2026-10-23";
  const owedPremium = (today: string) =>
    arrearsThisMonth(bundle.db, new Set([PREMIUM]), today).series.map((s) => [
      s.nextDate,
      s.amountCents,
      s.unreadCents,
    ]);
  /** paid Jun 11, Jul 11 and Aug 11, Sep 11 missed — its account read through Oct 22 */
  const missedSep11 = (): void => {
    const paid: [string, number][] = ["2026-06-11", "2026-07-11", "2026-08-11"].map((d) => [d, -35758]);
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-09-11", ...paid);
    checkedThrough(bundle.db, "acct", "2026-10-22");
  };
  /** …then -$715.16 on `on` */
  const catchUpOn = (on: string): void => {
    missedSep11();
    pay(`t-${PREMIUM}-${on}`, PREMIUM, on, -71516);
  };

  test("Sep 28, nearer Oct 11: it pays Oct 11 early AND Sep 11 late — nothing owed on Sep 30", () => {
    catchUpOn("2026-09-28");
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-28", early: true }],
    ]);
    // the Sep 28 row stands for Sep 11 in September, a different amount
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-28", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    expect(owedPremium("2026-09-30")).toEqual([]);
    expect(owedPremium(TODAY)).toEqual([]);
  });

  test("Sep 19, nearer Sep 11: it pays Sep 11 late AND Oct 11 early — no runway sentence, nothing already due", () => {
    catchUpOn("2026-09-19");
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-19", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-19", early: true }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    // …on the page that says it covered more than one month
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect(page.overdue).toBeNull();
    expect(page.paidAhead.map((o) => [o.postedOn, o.amountCents])).toEqual([["2026-09-19", -71516]]);
    // …and on Sep 25 Oct 11 is no longer coming: Upcoming and October's forecast read Sep 19 as its payment
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-11-11"]);
    expect(forecastForMonth(bundle.db, "2026-10", "2026-09-25")!.components.map((c) => c.label)).not.toContain(
      "Premium (what-if)",
    );
  });

  /*
   * ⚖️ default built, not asked (2026-10-29) — …and two premiums of which an instalment plan rounded one down a cent are
   * two (`paidAhead`, to `AT_THE_RATE_CENTS`): -$715.15 pays both days, as -$715.16 does. 🔴 At fc4444b2 it was one
   * premium (review of b6e11a76; his ledger copy 2026-10-29, this premium on Venture X): nothing was named, October drew
   * Oct 11 ✕, the arrears owed $357.58, the runway read "A further $3,877.56 came due earlier this month: $357.58 has
   * not posted, and no statement has covered the other $3,519.98 yet." and the page showed Oct 11 Already due.
   */
  test("Sep 19's -$715.15, two premiums one rounded down a cent: it pays Sep 11 and Oct 11 as -$715.16 does", () => {
    missedSep11();
    pay(`t-${PREMIUM}-sep19`, PREMIUM, "2026-09-19", -71515);
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-19", early: true }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect(page.overdue).toBeNull();
    expect(page.paidAhead.map((o) => [o.postedOn, o.amountCents])).toEqual([["2026-09-19", -71515]]);
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-11-11"]);
    // …but two cents short it is one premium: nothing named, and Oct 11 owed once it is past
    bundle.db.update(transactions).set({ amountCents: -71514 }).where(eq(transactions.id, `t-${PREMIUM}-sep19`)).run();
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });

  /*
   * ⚖️ default built, not asked (2026-10-29) — …and money back after it is what it RETURNED: a payment of two that got
   * one premium back covered one, and pays one day (`paidAhead`). 🔴 At fc4444b2 any money back after it was what it
   * left (review of 2f827fc): his Car insurance with Sep 3's -$1,000.00 returned on Sep 8 still read "Sep 3's
   * -$1,000.00 covered more than one month" beside "posted avg -$119.19" (his ledger copy 2026-10-29) — and every
   * grader paid two days with it.
   */
  test("…and +$357.58 back on Sep 25 returns one of Sep 19's two: Oct 11 is still to come, then owed", () => {
    catchUpOn("2026-09-19");
    pay(`t-${PREMIUM}-back`, PREMIUM, "2026-09-25", 35758);
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });

  /*
   * ⛔ …and money back is no PAYMENT: a day whose rows net the other way, or to nothing, pays no due day — on time,
   * early or late (`daysThatPaid`, his decision 75's unit, the day, read onto a bill's days; ⚖️ default built, not
   * asked, 2026-10-29). 🔴 At 4d6ec2ac every active row was a payment to every grader, credits and all (review of
   * 4d6ec2ac): the test above holds only because Sep 25 lies nearer Sep 11, paid already. On his ledger copy 2026-10-29
   * with this premium on Venture X, +$357.58 back on Sep 28 — nearer Oct 11 — drew Oct 11 "paid early by its payment
   * of Sep 28", the credit; on Oct 1 Upcoming listed Nov 11 alone and October's forecast left the premium out; on Oct
   * 29 nothing was owed, the runway reading "A further $3,519.98 came due earlier this month and no statement has
   * covered it yet." — one premium paid, net, and Oct 11 hidden. Sep 19 returned in full on Sep 28 drew the same Oct
   * 11; a +$12.50 credit on Oct 2 after it stood for Oct 11; a +$357.58 credit on Sep 9 stood for Sep 11, on time.
   */
  test("…and +$357.58 back on Sep 28, nearer Oct 11, pays no Oct 11: still to come on Oct 1, then owed", () => {
    catchUpOn("2026-09-19");
    pay(`t-${PREMIUM}-back`, PREMIUM, "2026-09-28", 35758);
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(coming("2026-10-01", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", "2026-10-01")).toEqual([-35758]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $357.58 came due earlier this month and has not posted.",
    );
    // …and returned in FULL on Sep 28 the same: the refund pays no Oct 11. ⚠️ Sep 19 still pays Sep 11 — money back
    // on a day of its own is never taken off a day its payment paid, as his decision 75 reads a payroll returned later
    bundle.db.update(transactions).set({ amountCents: 71516 }).where(eq(transactions.id, `t-${PREMIUM}-back`)).run();
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
  });

  test("…a +$12.50 credit on Oct 2 after Sep 19's two exactly unnames it and pays no Oct 11: Oct 11 owed", () => {
    catchUpOn("2026-09-19");
    pay(`t-${PREMIUM}-credit`, PREMIUM, "2026-10-02", 1250);
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });

  test("…and money back inside a day's grace is not its payment: +$357.58 on Sep 9 leaves Sep 11 owed", () => {
    missedSep11();
    pay(`t-${PREMIUM}-sep9`, PREMIUM, "2026-09-09", 35758);
    expect(unpaid("2026-09", "2026-09-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium("2026-09-30")).toEqual([["2026-09-11", 35758, 0]]);
    /*
     * …and the calendar draws the credit as what it is — toward no due day, graded against nothing — and so does its
     * page's Amount history: 🔴 review of d7a5485c (L16), September drew Sep 9 "paid (amount changed)" +$357.58
     * "expected -$357.58" beside Sep 11's mark (his ledger copy 2026-10-29 with this premium on Venture X).
     */
    const drawn = (day: string) =>
      (recurringCalendar(bundle.db, "2026-09", TODAY).entriesByDay[day] ?? [])
        .filter((e) => e.seriesId === PREMIUM && e.transactionId !== null)
        .map((e) => [e.state, e.expectedAmountCents, e.towardNoDueDay ?? false]);
    expect(drawn("2026-09-09")).toEqual([["paid", null, true]]);
    const history = seriesDetail(bundle.db, PREMIUM, TODAY)!.amountHistory;
    expect(history.map((p) => [p.date, p.expectedCents, p.towardNoDueDay ?? false])).toEqual([
      ["2026-06-11", -35758, false],
      ["2026-07-11", -35758, false],
      ["2026-08-11", -35758, false],
      ["2026-09-09", null, true],
    ]);
    // …nor is a charge and its same-day reversal, a day that netted to nothing (`occurrencesOf`)
    pay(`t-${PREMIUM}-sep11`, PREMIUM, "2026-09-11", -35758);
    pay(`t-${PREMIUM}-sep11r`, PREMIUM, "2026-09-11", 35758);
    expect(owedPremium("2026-09-30")).toEqual([["2026-09-11", 35758, 0]]);
    // both of its rows drawn toward no due day — the charge too: its day paid nothing
    expect(drawn("2026-09-11")).toEqual([
      ["paid", null, true],
      ["paid", null, true],
    ]);
  });

  test("Oct 12, inside Oct 11's grace: it pays Oct 11 on time AND Sep 11 late — owed on Sep 30, before it came", () => {
    missedSep11();
    expect(owedPremium("2026-09-30")).toEqual([["2026-09-11", 35758, 0]]);
    pay(`t-${PREMIUM}-oct12`, PREMIUM, "2026-10-12", -71516);
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-10-12", early: false }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    // …and Nov 11, a day still to come, is no day it paid
    expect(coming(TODAY, PREMIUM)[0]).toBe("2026-11-11");
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and after TWO missed charges IN A ROW a late one pays both of them,
   * never a day still to come: late for its own day, its second charge pays the unpaid day behind it first
   * (`paymentFor`'s catch-up). ⚠️ Not with a paid one between them — a known gap (billing-carriers.test.ts; his ledger
   * copy 2026-10-29, this premium): Aug 11 missed, Sep 11 paid, Oct 11 missed, then Oct 20 draws Nov 11 "paid early by
   * its payment of Oct 20", Upcoming lists Dec 11 alone and November's forecast leaves it out, beside August's ✕.
   * 🔴 At 67b3b79 it paid the day after, early, whatever lay behind (review of 67b3b79; his ledger copy
   * 2026-10-23 with this premium added on Venture X, read through Oct 14): Aug 11 and Sep 11 missed, then Sep 19 — on
   * Sep 25 Upcoming listed Nov 11 alone and October's forecast left Oct 11 out, on Oct 23 the runway read only "A
   * further $3,519.98 came due earlier this month and no statement has covered it yet." (his own bills), and August
   * stayed ✕; Sep 11 and Oct 11 missed, then Oct 20 — November drew Nov 11 "paid early by its payment of Oct 20, 2026",
   * Upcoming listed Dec 11 alone, November's forecast left the premium out, the All tab and the page named Dec 11
   * next, and September stayed ✕ beside "Oct 20's -$715.16 covered more than one month".
   */
  const premiumIn = (month: string, today: string) =>
    forecastForMonth(bundle.db, month, today)!
      .components.filter((c) => c.label === "Premium (what-if)")
      .map((c) => c.cents);

  test("Aug 11 and Sep 11 missed, then Sep 19: it pays both, late — Oct 11 still comes, and is owed unposted", () => {
    const paid: [string, number][] = ["2026-06-11", "2026-07-11"].map((d) => [d, -35758]);
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-08-11", ...paid, ["2026-09-19", -71516]);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    expect(marks("2026-08", "2026-08-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-19", early: false }],
    ]);
    // the Sep 19 row stands for Sep 11, a different amount
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-19", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    // on Sep 25 Oct 11 is still to come: Upcoming and October's forecast count it
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", "2026-09-25")).toEqual([-35758]);
    // …and on Oct 23, never posted, it is owed: the calendar, the arrears, the runway and the page
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $357.58 came due earlier this month and has not posted.",
    );
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect([page.overdue?.date, page.overdue?.amountCents]).toEqual(["2026-10-11", -35758]);
    expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-19"]);
  });

  test("Sep 11 and Oct 11 missed, then Oct 20: it pays both, late — Nov 11 is still to come, and next", () => {
    catchUpOn("2026-10-20");
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-10-20", early: false }],
    ]);
    // the Oct 20 row stands for Oct 11, a different amount
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([]);
    expect(marks("2026-10", "2026-10-20", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    expect(marks("2026-11", "2026-11-11", TODAY)).toEqual([[PREMIUM, "upcoming", null]]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    // Upcoming, November's forecast, the All tab's Next and the page's next charges all count Nov 11
    expect(coming(TODAY, PREMIUM)).toEqual(["2026-11-11", "2026-12-11"]);
    expect(premiumIn("2026-11", TODAY)).toEqual([-35758]);
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-11-11");
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.nextExpected.map((o) => o.date)[0]).toBe("2026-11-11");
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and of two late payments of two in a row, two due days apart, each pays
   * its own day and the next: a day the one before paid early is paid (adjacent ones do not — the known gap, below).
   * 🔴 At 8348349 the second paid its own day alone (review of 8348349; his ledger copy 2026-10-23 with this premium
   * added on Venture X, read through Oct 14, anchored Oct 11 — the step detection lays down after Sep 20 — or Jul 11,
   * both reading the same): on Sep 25 Upcoming listed Oct 11 and October's forecast held -$357.58; on Oct 23 October
   * drew Oct 11 missed, the arrears owed $357.58, the runway read "A further $3,877.56 came due earlier this month:
   * $357.58 has not posted, and no statement has covered the other $3,519.98 yet." and the series page showed Oct 11
   * overdue beside "Jul 20's -$715.16 and Sep 20's -$715.16 each covered more than one month" — five charges paid,
   * four days.
   */
  test("Jul 20 and Sep 20, each late with two premiums: Sep 20 pays Oct 11 early — nothing owed, none coming", () => {
    const rows: [string, number][] = [
      ["2026-06-11", -35758],
      ["2026-07-20", -71516],
      ["2026-09-20", -71516],
    ];
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-10-11", ...rows);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    for (const anchor of ["2026-10-11", "2026-07-11"]) {
      bundle.db.update(recurringSeries).set({ nextExpectedOn: anchor }).where(eq(recurringSeries.id, PREMIUM)).run();
      expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
        [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-20", early: true }],
      ]);
      expect(owedPremium(TODAY)).toEqual([]);
      expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
      const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
      expect(page.overdue).toBeNull();
      expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-07-20", "2026-09-20"]);
      // on Sep 25, Oct 11 is no longer coming: Upcoming and October's forecast read Sep 20 as its payment
      expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-11-11"]);
      expect(premiumIn("2026-10", "2026-09-25")).toEqual([]);
    }
    // …anchored Jul 11, August draws its Aug 11 paid early by Jul 20, the first one's second day
    expect(marks("2026-08", "2026-08-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-07-20", early: true }],
    ]);
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and a schedule that opens on a late payment of two spends its second
   * charge on the day after: a day before the schedule opens — before his date, or before detection's anchor and every
   * payment of it — is no charge. 🔴 At 8348349 it paid the day before it, Jul 11, which no surface shows (review of
   * 8348349; his ledger copy 2026-10-23, this premium on Venture X started Aug 11 by his date, Aug 20 -$715.16 then Oct
   * 11 -$357.58): September drew Sep 11 unsettled; on Sep 25 the arrears owed it $357.58, the runway read "A further
   * $522.45 came due earlier this month: $357.58 has not posted, and no statement has covered the other $164.87 yet.",
   * September's forecast held -$357.58, and the page showed it overdue beside "Aug 20's -$715.16 covered more than one
   * month" — and so with Jun 11 -$357.58 paid before his date too.
   */
  test("started Aug 11 by his date, Aug 20's two premiums pay Aug 11 and Sep 11 — Sep 25 owes nothing", () => {
    const started = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-11-11"), userNextExpectedOn: "2026-08-11" };
    bundle.db.insert(recurringSeries).values({ ...started, lastMatchedOn: "2026-10-11" }).run();
    // Oct 11's row, at the rate, is what names Aug 20 as covering more than one month (`paidAhead`) — read on Sep 25
    // as the review read it
    pay(`t-${PREMIUM}-aug20`, PREMIUM, "2026-08-20", -71516);
    pay(`t-${PREMIUM}-oct11`, PREMIUM, "2026-10-11", -35758);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    const SEP25 = "2026-09-25";
    expect(marks("2026-09", "2026-09-11", SEP25)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(owedPremium(SEP25)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, SEP25))).toBeNull();
    expect(premiumIn("2026-09", SEP25)).toEqual([]);
    const page = seriesDetail(bundle.db, PREMIUM, SEP25)!;
    expect(page.overdue).toBeNull();
    expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-08-20"]);
    // …and July draws nothing: no surface asks a day before his date
    expect(marks("2026-07", "2026-07-11", TODAY)).toEqual([]);
    // on Oct 23, September still draws Sep 11 paid by Aug 20; Oct 11 posted on its day, nothing is owed, Nov 11 next
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(coming(TODAY, PREMIUM)).toEqual(["2026-11-11", "2026-12-11"]);
    // …and with Jun 11 paid before his date it reads the same: his date is the schedule, July no charge of it
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    expect(marks("2026-09", "2026-09-11", SEP25)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(owedPremium(SEP25)).toEqual([]);
    expect(seriesDetail(bundle.db, PREMIUM, SEP25)!.overdue).toBeNull();
  });

  /*
   * ⛔ …and every reader that looks ahead reads his date as his (`stillToComeReader`, `dueDaysOf`'s series), as the
   * calendar and the arrears do. 🔴 Nothing pinned it (review of b6e11a76): read there with `userNextExpectedOn: null`,
   * every grader test passed, and on his ledger copy 2026-10-29 with this premium on Venture X — started Aug 11 by his
   * date, Jun 11 paid before it, Aug 20 -$715.16 — on Sep 1 the calendar drew Sep 11 "paid early by its payment of Aug
   * 20, 2026" while Upcoming listed Sep 11 and Oct 11, September's forecast held -$357.58, the All tab and the page
   * named Sep 11 next, and /budgets' Car tail held Sep 11's $357.58: read as detection's, Jul 11 was a charge (Jun 11
   * posted before it), unpaid, and Aug 20 paid it.
   */
  test("started Aug 11 by his date, Jun 11 paid before it: on Sep 1 no reader that looks ahead lists Sep 11", () => {
    const started = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-09-11"), userNextExpectedOn: "2026-08-11" };
    bundle.db.insert(recurringSeries).values({ ...started, lastMatchedOn: "2026-08-20" }).run();
    // Jun 11's row, at the rate, is what names Aug 20 as covering more than one month (`paidAhead`)
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    pay(`t-${PREMIUM}-aug20`, PREMIUM, "2026-08-20", -71516);
    const SEP1 = "2026-09-01";
    expect(marks("2026-09", "2026-09-11", SEP1)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(seriesDetail(bundle.db, PREMIUM, SEP1)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-08-20"]);
    // Upcoming, September's forecast, the All tab's Next, the page's next charges and the budget's tail
    expect(coming(SEP1, PREMIUM)).toEqual(["2026-10-11"]);
    expect(premiumIn("2026-09", SEP1)).toEqual([]);
    expect(listSeries(bundle.db, SEP1).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-10-11");
    expect(seriesDetail(bundle.db, PREMIUM, SEP1)!.nextExpected.map((o) => o.date)[0]).toBe("2026-10-11");
    expect(budgetTail(bundle.db, categoryId, "2026-09-30", SEP1).series.map((s) => [s.id, s.nextDate])).toEqual([]);
  });

  /*
   * ⚖️ default built, not asked (2026-10-29) — …and a payment of two LATE FOR A DAY BEFORE HIS DATE pays nothing on his
   * schedule: that day is no charge, so it catches nothing up and pays no day of his early (`paidAheadFromTheDayBefore`
   * in billing-carriers). 🔴 At b6e11a76 it paid his date early (review of b6e11a76; his ledger copy 2026-10-29, this
   * premium added on Venture X, read through Oct 14): Jun 11 and Jul 11 paid, Aug 11 and Sep 11 missed, Sep 19
   * -$715.16, then he typed Oct 11 (the toast read "Next expected 2026-10-11") — October drew Oct 11 "paid early by its
   * payment of Sep 19, 2026"; on Sep 25 Upcoming listed Nov 11 alone, October's forecast left it out, and the All tab
   * and the page named Nov 11 next; on Oct 29 nothing was owed, /budgets' Car pace had no overdue line, and the runway
   * read "A further $3,519.98 came due earlier this month and no statement has covered it yet." — his own bills, round
   * 2's two-missed defect back for his own date. At 8348349 Oct 11 was still to come on Sep 25 and owed on Oct 23, as
   * detection's own Oct 11 reads it.
   */
  test("he typed Oct 11 after Sep 19's two premiums, late for Sep 11: Oct 11 still comes, and is owed unposted", () => {
    const typed = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-10-11"), userNextExpectedOn: "2026-10-11" };
    bundle.db.insert(recurringSeries).values({ ...typed, lastMatchedOn: "2026-09-19" }).run();
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    pay(`t-${PREMIUM}-jul11`, PREMIUM, "2026-07-11", -35758);
    pay(`t-${PREMIUM}-sep19`, PREMIUM, "2026-09-19", -71516);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    // on Sep 25 Oct 11 is still to come: Upcoming, October's forecast, the All tab's Next and the page's next charges
    const SEP25 = "2026-09-25";
    expect(coming(SEP25, PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", SEP25)).toEqual([-35758]);
    expect(listSeries(bundle.db, SEP25).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-10-11");
    expect(seriesDetail(bundle.db, PREMIUM, SEP25)!.nextExpected.map((o) => o.date)[0]).toBe("2026-10-11");
    // …and on Oct 23, never posted, it is owed: the calendar, the arrears, the runway and the page
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([[PREMIUM, "missed", null]]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $357.58 came due earlier this month and has not posted.",
    );
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect([page.overdue?.date, page.overdue?.amountCents]).toEqual(["2026-10-11", -35758]);
    expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-19"]);
  });

  /*
   * ⛔ …and none settles the day behind from a day before his date either (`dayBehindIsSettled`, the same his-date test
   * `paidAheadFromTheDayBefore` asks): a payment of two late for a day before his date pays nothing of his, so the day
   * behind a later one's own stays unpaid and its second charge pays that day, never the day after it. 🔴 Nothing
   * pinned it (review of 4d6ec2ac): with the test asked only where the catch-up asks for itself, the whole suite passed
   * (449 files, 9,774 tests), and on his ledger copy 2026-10-29 with this premium on Venture X — started Sep 11 by his
   * date, Jun 11 at the rate, Aug 20 and Oct 20 each -$715.16 — Oct 20 paid Sep 11, Oct 11 AND Nov 11: November drew
   * Nov 11 "paid early by its payment of Oct 20", Upcoming listed Dec 11 alone, November's forecast left the premium
   * out, and the All tab and the page named Dec 11 next. 🔴 …but with Jul 11 unpaid here, the day two before his date,
   * a run read without his date stopped there too — a charge to it, Jun 11 having posted, and unpaid — so with the day
   * behind read without it the whole suite passed again (review of d7a5485c; 449 files, 9,784 tests, the review's run).
   * With Jul 11 at the rate too, on the same copy on Oct 23 and Oct 29, Aug 20 read as settling Sep 11 and Oct 20 paid
   * three days, as above.
   */
  test("started Sep 11 by his date, Aug 20 and Oct 20 each two premiums: Oct 20 pays two — Nov 11 still comes", () => {
    const started = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-09-11"), userNextExpectedOn: "2026-09-11" };
    bundle.db.insert(recurringSeries).values({ ...started, lastMatchedOn: "2026-10-20" }).run();
    // Jun 11's row, at the rate, is what names Aug 20 and Oct 20 as covering more than one month (`paidAhead`)
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    pay(`t-${PREMIUM}-aug20`, PREMIUM, "2026-08-20", -71516);
    pay(`t-${PREMIUM}-oct20`, PREMIUM, "2026-10-20", -71516);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    const paysTwoNov11StillComes = (): void => {
      expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual([
        "2026-08-20",
        "2026-10-20",
      ]);
      // Sep 11 late by Oct 20's second charge, Oct 11 late by its first — the Oct 20 row stands for it
      expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
        [PREMIUM, "paid", { carrier: null, postedOn: "2026-10-20", early: false }],
      ]);
      expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([]);
      expect(owedPremium(TODAY)).toEqual([]);
      // …and Nov 11 is still to come: the calendar, Upcoming, November's forecast, the All tab's Next and the page's
      expect(marks("2026-11", "2026-11-11", TODAY)).toEqual([[PREMIUM, "upcoming", null]]);
      expect(coming(TODAY, PREMIUM)).toEqual(["2026-11-11", "2026-12-11"]);
      expect(premiumIn("2026-11", TODAY)).toEqual([-35758]);
      expect(listSeries(bundle.db, TODAY).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-11-11");
      expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.nextExpected.map((o) => o.date)[0]).toBe("2026-11-11");
    };
    paysTwoNov11StillComes();
    // …and with Jul 11 paid too, the day two before his date, the same: Aug 20 is late for Aug 11, no charge of his,
    // so it settles no day behind Oct 20's own
    pay(`t-${PREMIUM}-jul11`, PREMIUM, "2026-07-11", -35758);
    paysTwoNov11StillComes();
  });

  /*
   * ⚠️ …but only two due days apart — THE KNOWN GAP (review of b6e11a76; his ledger copy 2026-10-29 with this premium
   * added on Venture X, read through Oct 14, anchored Sep 11 — detection's step — or Jul 11, both reading the same):
   * of two ADJACENT late payments of two, the later is asked first for its own late day, the day the earlier one's
   * second charge paid ahead, so that charge pays no day. Jun 11, then Jul 20 and Aug 20 each -$715.16: Jul 11 is Jul
   * 20's, Aug 11 and Sep 11 Aug 20's, and on Oct 29 October draws Oct 11 missed, the arrears owe $357.58, the runway
   * reads "A further $3,877.56 came due earlier this month: $357.58 has not posted, and no statement has covered the
   * other $3,519.98 yet." and the page shows Oct 11 overdue beside "Jul 20's -$715.16 and Aug 20's -$715.16 each
   * covered more than one month" — five charges, four days. Not built (an owner's call, 2026-10-29): it shows a paid
   * day owed, the safe direction. Paying it reads the run as one allocation, each payment pushing the next a day ahead.
   */
  test("⚠️ known gap: Jul 20 and Aug 20, adjacent, each two premiums — Oct 11 is owed beside both named", () => {
    const rows: [string, number][] = [
      ["2026-06-11", -35758],
      ["2026-07-20", -71516],
      ["2026-08-20", -71516],
    ];
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-09-11", ...rows);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    for (const anchor of ["2026-09-11", "2026-07-11"]) {
      bundle.db.update(recurringSeries).set({ nextExpectedOn: anchor }).where(eq(recurringSeries.id, PREMIUM)).run();
      expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
        [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
      ]);
      expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([[PREMIUM, "missed", null]]);
      expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
      expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
        "A further $357.58 came due earlier this month and has not posted.",
      );
      const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
      expect([page.overdue?.date, page.overdue?.amountCents]).toEqual(["2026-10-11", -35758]);
      expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-07-20", "2026-08-20"]);
    }
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and ON TIME for its own day, the day behind paid, a payment of two pays
   * no day after it: it is not read ahead, so nothing still to come leaves Upcoming or the forecast. 🔴 Nothing pinned
   * it (review of 8348349): read as "late or on time", every test passed, and Aug 11 paid, then -$715.16 on Sep 12
   * drew Oct 11 "paid early by Sep 12" and took it out of Upcoming and October's forecast on Sep 25.
   */
  test("Sep 12, on time with two premiums after a paid Aug 11: it pays no Oct 11 — still to come, then owed", () => {
    const paid: [string, number][] = ["2026-06-11", "2026-07-11", "2026-08-11"].map((d) => [d, -35758]);
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-10-11", ...paid, ["2026-09-12", -71516]);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    // on Sep 25 Oct 11 is still to come: Upcoming and October's forecast count it
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", "2026-09-25")).toEqual([-35758]);
    // …and on Oct 23, never posted, it is owed — drawn unpaid, on the arrears
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });
});

/*
 * ⛔ ONE RULE: a grader pays a second due day only with a payment the series' posted average NAMES as covering more
 * than one charge (`paidAheadDays`, read onto every grader's payments as `BillPayment.coveredMore`) — never with the
 * bare multiple of the rate. 🔴 Nothing pinned it (review of 67b3b79): with `PaymentDays.coveredMore` (then
 * `coveredMoreDays`) reading |amount| ≥ 2 × |rate| instead, every unit test still passed, and on his ledger copy
 * 2026-10-23 a what-if FPL on Venture X — the
 * -$58.87 he set, Jul 10 -$14.21, Jul 28 -$56.22, then one -$125.00 bill Sep 28 (2.12×) — drew Sep 8 paid by Sep 28
 * beside an All tab, a series page and a popover that name nothing. Sep 28 pays Oct 8 early, its own, and only that.
 */
describe("⛔ a second due day is paid only by a payment its posted average names (`paidAheadDays`)", () => {
  const TODAY = "2026-10-23";
  const P = -35758;
  const fplWith125 = (): void => {
    const july: [string, number][] = [
      ["2026-07-10", -1421],
      ["2026-07-28", -5622],
    ];
    seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ...july, ["2026-09-28", -12500]);
  };

  test("FPL's one high bill, Sep 28 -$125.00, names nothing and pays one day: Sep 8 stays owed", () => {
    fplWith125();
    checkedThrough(bundle.db, "acct", "2026-10-22");
    // the average names nothing: the series page, and the All tab
    expect(seriesDetail(bundle.db, FPL, TODAY)!.paidAhead).toEqual([]);
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === FPL)!.paidAhead).toEqual([]);
    // …so Sep 28 pays Oct 8 early, its own, and nothing behind it: September draws Sep 8 unpaid, owed on Sep 30
    expect(marks("2026-10", "2026-10-08", TODAY)).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-09-28", early: true }],
    ]);
    expect(unpaid("2026-09", "2026-09-08", TODAY)).toEqual([FPL]);
    expect(owed("2026-09-30")).toEqual([[FPL, "2026-09-08", 5887]]);
  });

  test("the payments every grader reads as covering two charges are the ones the average names, and no other", () => {
    // FPL's -$125.00, and a bill varying after its one high month, name nothing; a catch-up, and Car insurance's
    // Sep 3 with Nov 11's $72.74 remainder after it, are named
    fplWith125();
    const varying: [string, number][] = [
      ["2026-06-08", -6000],
      ["2026-07-08", -13000],
      ["2026-08-08", -5500],
      ["2026-09-08", -4000],
      ["2026-10-08", -5800],
    ];
    seriesWith("varying", "Varying (what-if)", -6000, "2026-06-08", ...varying);
    const premiums: [string, number][] = ["2026-06-11", "2026-07-11", "2026-08-11"].map((d) => [d, P]);
    seriesWith("premium", "Premium (what-if)", P, "2026-09-11", ...premiums, ["2026-09-19", 2 * P]);
    const car: [string, number][] = [
      ["2026-08-12", P],
      ["2026-09-03", -100000],
      ["2026-11-11", -7274],
    ];
    seriesWith("car", "Car insurance", P, "2026-12-11", ...car);
    const ids = [FPL, "varying", "premium", "car"];
    const payments = billPaymentsBySeries(
      bundle.db,
      bundle.db
        .select()
        .from(recurringSeries)
        .all()
        .map((s) => ({ id: s.id, toleranceDays: s.toleranceDays, billedWith: null })),
    );
    const read = ids.map((id) => [
      id,
      (payments.get(id) ?? []).filter((p) => p.coveredMore).map((p) => p.postedOn),
      seriesDetail(bundle.db, id, TODAY)!.paidAhead.map((o) => o.postedOn),
    ]);
    expect(read).toEqual([
      [FPL, [], []],
      ["varying", [], []],
      ["premium", ["2026-09-19"], ["2026-09-19"]],
      ["car", ["2026-09-03"], ["2026-09-03"]],
    ]);
  });
});
