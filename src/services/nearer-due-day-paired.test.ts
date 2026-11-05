import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { seriesEndInput, seriesEndLines } from "@/components/recurring/end-radius";
import { unsettledWords } from "@/components/recurring/labels";
import { arrearsSentence } from "@/lib/committed";
import { formatCents } from "@/lib/money";
import { arrearsThisMonth } from "./arrears";
import { billingCarriers } from "./billing-carriers";
import { budgetOverdue, budgetTail } from "./budgets";
import { predictCategory } from "./category-forecast";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { dashboardData } from "./dashboard";
import { forecastForMonth } from "./forecast";
import {
  bill,
  closeLedger,
  coming,
  labelsIn,
  marks,
  MEAL,
  openLedger,
  owed,
  pay,
  RENT,
  rentWith,
  seriesWith,
  unpaid,
  UTIL,
} from "./nearer-due-day-fixture";
import { nextStillToCome, stillToComeReader, type StillToCome } from "./payday-settlement";
import { listSeries, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * ⚖️ default (B), built, not asked (2026-10-30) — each day of what the rent carries PAIRS with the rent's own day of
 * that period (`pairingOf`): each rent payment pays exactly that month's utilities, and a day of theirs falls due on
 * the later of its own day and the rent's day it pairs with (`fallsDueOn`). The describe nearer-due-day-carried.test.ts
 * opens, continued here — split by subject (review of 68c837ce, L14); his decision 76 itself is nearer-due-day.test.ts.
 */

let bundle: DbBundle;
let categoryId: string;
beforeEach(() => {
  ({ bundle, categoryId } = openLedger());
});
afterEach(closeLedger);

describe("⛔ …and what a carrier carries opens where the carrier's schedule opens — his date on the rent", () => {
  const detailsIn = (month: string, today: string) =>
    forecastForMonth(bundle.db, month, today)!.components.map((c) => c.detail ?? "");

  /*
   * ⚖️ default (B), built, not asked (2026-10-30) — each day of what the rent carries PAIRS with the rent's own day of
   * that period (`pairingOf`): the day of theirs that falls due with the rent's first day pairs with it, each later one
   * with the rent's day the same number of steps on, and a day of theirs is paid by whatever pays the rent's day it
   * pairs with, by the rent's own test (decision 76, the catch-up). The owner question 46f19f15 left (latent: on his
   * ledger both fall due on the 1st): with the rent typed about half a month from their 1st, each LATER day of theirs
   * was graded by the rent payment nearest it — the rent typed Nov 16, paid Nov 16 then Dec 17, a day past the
   * midpoint: on Dec 20 December drew their Dec 1 missed, owed $182.21 beside a rent paid on time ("came due Dec 1 and
   * has not posted" in December's forecast, "Already due" on their page), and January their Jan 1 "paid early by Dec
   * 17". On his ledger copy 2026-10-29b with that what-if (Wells Fargo read through Dec 26) the runway read "A further
   * $1,349.70 came due earlier this month: $877.25 has not posted, and no statement has covered the other $472.45 yet."
   * Now Dec 17 pays the rent's Dec 16 and so their Dec 1, and their Jan 1 comes with the rent's Jan 16.
   */
  test("⚖️ (B) the rent typed Nov 16, paid Nov 16 then Dec 17: Dec 17 pays their Dec 1 — Jan 1 still comes", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-17",
    );
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    // each drawn on the rent's day it falls due with — their Nov 1 on its Nov 16, Dec 1 on Dec 16, Jan 1 on Jan 16
    // (their own 1st until the review of aa05a56d)
    const theirs = (key: string, day: string) => marks(key, day, DEC20).filter(([id]) => id === UTIL);
    expect(theirs("2026-11", "2026-11-16")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-16", early: false }],
    ]);
    expect(theirs("2026-12", "2026-12-16")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-17", early: false }],
    ]);
    expect(theirs("2027-01", "2027-01-16")).toEqual([[UTIL, "upcoming", null]]);
    // nothing owed: the arrears, the runway's "A further …", /budgets' row, their page, December's forecast
    expect(owed(DEC20)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, DEC20))).toBeNull();
    expect(budgetOverdue(bundle.db, categoryId, "2026-12-01", DEC20).series).toEqual([]);
    expect(seriesDetail(bundle.db, UTIL, DEC20)!.overdue).toBeNull();
    expect(detailsIn("2026-12", DEC20).filter((d) => d.includes("came due"))).toEqual([]);
    // …and their Jan 1 comes with the rent's Jan 16: Upcoming, January's forecast, their page's list, the All tab's
    // Next — the sentence's editor on their own Jan 1
    expect(coming(DEC20, UTIL)[0]).toBe("2027-01-16");
    expect(coming(DEC20, RENT)[0]).toBe("2027-01-16");
    expect(labelsIn("2027-01", DEC20)).toEqual(expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]));
    const page = seriesDetail(bundle.db, UTIL, DEC20)!;
    expect([page.nextExpectedOn, page.nextExpected.map((o) => o.date)]).toEqual([
      "2027-01-01",
      ["2027-01-16", "2027-02-16", "2027-03-16"],
    ]);
    // …the sentence saying the day it falls due beside its own Jan 1: "due with the rent on the 16th"
    expect(page.nextFallsDueOn).toBe("2027-01-16");
    expect(listSeries(bundle.db, DEC20).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-16");
  });

  /*
   * ⚖️ (B) …and a day of theirs falls due on the later of its own day and the rent's day it pairs with: owed, or drawn
   * missed, only once that rent day is — never before — and until then still to come, on every reader that looks
   * ahead (default built, not asked, 2026-10-30). 46f19f15's own known gap: the rent typed Nov 16, nothing of November
   * posted, read through Nov 9 — on Nov 10 November drew their Nov 1 missed and the runway read "A further $182.21 came
   * due earlier this month and has not posted." six days before the rent's Nov 16 came. Now their Nov 1 comes with the
   * rent's Nov 16 — Upcoming, November's forecast, /budgets' tail, their page and the All tab hold it, and no reader
   * leaves its $182.21 out — and from Nov 17 it is owed with it (nearer-due-day-carried.test.ts, "…not yet paid").
   */
  test("⚖️ (B) …nothing of November posted: on Nov 10 their Nov 1 still comes with the rent's Nov 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV10 = "2026-11-10";
    // drawn upcoming on the day it falls due, the rent's Nov 16 — never on its own Nov 1, a day already past
    expect(marks("2026-11", "2026-11-01", NOV10)).toEqual([]);
    expect(marks("2026-11", "2026-11-16", NOV10)).toEqual([
      [UTIL, "upcoming", null],
      [RENT, "upcoming", null],
    ]);
    expect(owed(NOV10)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, NOV10))).toBeNull();
    expect(budgetOverdue(bundle.db, categoryId, "2026-11-01", NOV10).series).toEqual([]);
    // …still to come with the rent's Nov 16 — and their Dec 1 with its Dec 16 — and named by those days: Upcoming,
    // November's forecast, /budgets' tail, their page's list and the All tab's Next
    expect(coming(NOV10, UTIL)).toEqual(["2026-11-16", "2026-12-16"]);
    expect(coming(NOV10, RENT)).toEqual(["2026-11-16", "2026-12-16"]);
    expect(labelsIn("2026-11", NOV10)).toEqual(expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]));
    expect(detailsIn("2026-11", NOV10)).toContain("1 × -$182.21 (monthly), next Nov 16");
    expect(budgetTail(bundle.db, categoryId, "2026-11-30", NOV10).series.map((s) => [s.id, s.nextDate])).toEqual([
      [UTIL, "2026-11-16"],
      [RENT, "2026-11-16"],
    ]);
    const page = seriesDetail(bundle.db, UTIL, NOV10)!;
    expect([page.nextExpected.map((o) => o.date), page.overdue]).toEqual([
      ["2026-11-16", "2026-12-16", "2027-01-16"],
      null,
    ]);
    expect(listSeries(bundle.db, NOV10).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-11-16");
    // ⛔ …and the sentence's editor opens on their OWN Nov 1, still to come: what its Save writes as their date. On
    // the rent's Nov 16 a Save with nothing changed would retype them onto the 16th.
    expect(page.nextExpectedOn).toBe("2026-11-01");
    // …so the sentence says, beside it, the day it falls due — the day its list and the All tab name. 🔴 Review of
    // a456a6fc: it read "around the 1st" alone over Nov 16 · Dec 16 · Jan 16 (his ledger copy 2026-10-29b)
    expect(page.nextFallsDueOn).toBe("2026-11-16");
  });

  /*
   * ⚖️ (B) …and the readers that look ahead ask the rent's day a day of theirs pairs with in full, late payments too:
   * the rent typed Nov 16 and paid Nov 21, five days late, opens them on their Dec 1, the rent's Nov 16 — so on Nov 25
   * their Dec 1, still ahead by its own day, is paid, and Upcoming and the All tab name their Jan 1. Asked with nothing
   * late (`nothingLateFrom`'s day from today on, read for the rent's past Nov 16), Nov 21 would pay no day of theirs.
   */
  test("⚖️ (B) …the rent paid Nov 21, late: on Nov 25 their Dec 1 is paid — Upcoming names their Jan 1", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-21",
    );
    checkedThrough(bundle.db, "acct", "2026-11-24");
    const NOV25 = "2026-11-25";
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-21", dueDaysPast: 0 });
    expect(marks("2026-12", "2026-12-01", NOV25)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-21", early: true }],
    ]);
    expect(coming(NOV25, UTIL)[0]).toBe("2027-01-01");
    expect(listSeries(bundle.db, NOV25).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-01");
  });

  /**
   * The All tab's Next for a series — `nextStillToCome` over the predicate `listSeries` builds (`stillToComeReader`) —
   * and each own day its walk asked, stopped should it ask one twice: a walk that does never ends.
   */
  const walkOf = (id: string, today: string): [string | null, string[]] => {
    const row = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;
    const series = { ...row, billedWith: billingCarriers(bundle.db).get(id) ?? null };
    const reader = stillToComeReader(bundle.db, [series], today);
    const asked: string[] = [];
    const toCome: StillToCome = (seriesId, ownDate) => {
      if (asked.includes(ownDate)) throw new Error(`the walk asked ${ownDate} again, after ${asked.join(", ")}`);
      asked.push(ownDate);
      return reader(seriesId, ownDate);
    };
    return [nextStillToCome(toCome, series, today), asked];
  };

  /*
   * ⛔ …and the All tab's Next steps past a day of theirs already paid to the walk's NEXT own day (`walkDayAfter`) —
   * never back to the day it just asked. A day of theirs falls due with the rent's day it pairs with, so the first day
   * falling due from the day after a paid one (`rollForwardNextExpected`'s `firstStepFallingDue`) can be that same
   * paid day: the rent typed Nov 16 and paid early on Nov 5 opens them on their Nov 1, the rent's Nov 16, paid by it —
   * and on Nov 10, asked from Nov 2, their Nov 1 still falls due on or after it (Nov 16). 🔴 Nothing pinned it (review
   * of a456a6fc): stepped as before aa05a56d, `rollForwardNextExpected(eff, addDays(next, 1))`, the walk asked Nov 1
   * again for good — 4,585 tests passed (the review's run) while `listSeries`, and so the /recurring render, would
   * hang. The walk here is bounded by the predicate it asks (`walkOf`); the same shape later in the year below.
   */
  test("⛔ …the rent paid early Nov 5 pays their Nov 1: on Nov 10 the All tab steps past it once, to Dec 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-05",
    );
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV10 = "2026-11-10";
    // Nov 5 pays the rent's Nov 16 early, its own day's payment: their Nov 1, nearest it, opens them, paired with it
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-05", dueDaysPast: 0 });
    // each own day asked once — their Nov 1, paid, then Dec 1 — named by the day Dec 1 falls due, the rent's Dec 16
    expect(walkOf(UTIL, NOV10)).toEqual(["2026-12-16", ["2026-11-01", "2026-12-01"]]);
    expect(walkOf(RENT, NOV10)).toEqual(["2026-12-16", ["2026-11-16", "2026-12-16"]]);
    // …the day every reader that looks ahead names: the All tab, Upcoming, their page's list — nothing owed
    const next = listSeries(bundle.db, NOV10);
    expect([UTIL, RENT].map((id) => next.find((s) => s.id === id)!.nextExpectedOn)).toEqual([
      "2026-12-16",
      "2026-12-16",
    ]);
    expect(coming(NOV10, UTIL)).toEqual(["2026-12-16"]);
    expect(coming(NOV10, RENT)).toEqual(["2026-12-16"]);
    expect(seriesDetail(bundle.db, UTIL, NOV10)!.nextExpected.map((o) => o.date)).toEqual([
      "2026-12-16",
      "2027-01-16",
      "2027-02-16",
    ]);
    expect(owed(NOV10)).toEqual([]);
  });

  /*
   * ⚖️ (B) …and the calendar names the payment the rent's day was paid by, on time for THAT day (`dayPaidAs`): what it
   * carries on the 5th, the rent typed Nov 2 — their Dec 5 is the rent's Dec 2 — and two rows on time for Dec 5, Dec 2
   * and Dec 5. Dec 2 pays the rent's Dec 2 and so their Dec 5; Dec 5, a day already paid on time, pays nothing (default
   * (a)) — named on time for their own Dec 5, it would be the row that paid no day.
   */
  test("⚖️ (B) …the calendar names the rent's payment of the day theirs pairs with — never one that paid none", () => {
    rentWith(
      { rentOn: "2026-11-02", typed: true, utilOn: "2026-09-05", noneOfTwo: true },
      "2026-07-02",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-02",
      "2026-12-02",
      "2026-12-05",
    );
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    expect(marks("2026-12", "2026-12-05", DEC20).filter(([id]) => id === UTIL)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-02", early: false }],
    ]);
    expect(owed(DEC20)).toEqual([]);
  });

  /*
   * ⚖️ (B) …only for what falls due on the rent's own step: a series carried on another cadence keeps the payment
   * nearest each day of its own (A), on the safe side — never an annual day paired with a monthly one, which would
   * hand next year's day to next month's rent payment.
   */
  test("⚖️ (B) …on the rent's step only: an annual item it carries owes next year's day to no rent payment", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-17",
    );
    bundle.db
      .insert(recurringSeries)
      .values({
        ...bill("ins", "Renter's insurance", -12000, "2026-11-01"),
        cadence: "annual",
        intervalDaysAvg: 365,
        userBilledWithSeriesId: RENT,
      })
      .run();
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    const insurance = upcomingOccurrences(bundle.db, DEC20, 400).filter((o) => o.seriesId === "ins");
    expect(insurance.map((o) => o.date)).toEqual(["2027-11-01"]);
  });

  /*
   * ⚖️ (B) …and a row of their OWN is read by their own days, as a bill on its own is — never as the rent's payment of
   * the day theirs pairs with: their own -$182.21 on Dec 18, nearer their Jan 1, pays Jan 1 early; their Dec 1 is the
   * rent's Dec 16, which nothing paid, and owed with it.
   */
  test("⚖️ (B) …a row of their own pays by their own days, never the rent's: their Dec 1 owed with its Dec 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    pay("t-util-dec18", UTIL, "2026-12-18", -18221);
    checkedThrough(bundle.db, "acct", "2026-12-26");
    const DEC27 = "2026-12-27";
    // owed, and drawn, on the rent's day each falls due with (their own 1st until the review of aa05a56d)
    expect(owed(DEC27)).toEqual([
      [UTIL, "2026-12-16", 18221],
      [RENT, "2026-12-16", 229121],
    ]);
    expect(marks("2027-01", "2027-01-16", DEC27).filter(([id]) => id === UTIL)).toEqual([
      [UTIL, "paid", { carrier: null, postedOn: "2026-12-18", early: true }],
    ]);
  });

  /*
   * ⚖️ (B) …and a day of theirs is HELD, NAMED AND DRAWN on the day it falls due — the later of its own day and the
   * rent's day it pairs with (`fallsDueOn`) — by every reader: an occurrence's `date` IS that day (`projectOccurrences`),
   * and its own day (`ownDate`) is only what a grader asks paid (`paymentFor`). 🔴 At aa05a56d the windows held it by
   * that day while `date` stayed its own (review of aa05a56d), so every reader that re-read `date` read another day:
   * the category forecast re-filtered it out of the month it fell due in and never counted it, the dashboard counted
   * it due before a paycheck that comes first, and every sentence, list and grid named or drew its own day.
   */
  test("⚖️ (B) …on the 25th, the rent typed Nov 1: November's category forecast counts their Oct 25 with it", () => {
    rentWith(
      { rentOn: "2026-11-01", typed: true, utilOn: "2026-09-25", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-10-29");
    const OCT30 = "2026-10-30";
    // 🔴 at aa05a56d $2,291.21, "1 expected recurring charge": their Oct 25, held in November, re-filtered out by day
    const predicted = predictCategory(bundle.db, categoryId, "Housing", OCT30).forecast;
    expect([predicted.recurringCents, predicted.parts[0]!.basis]).toEqual([
      229121 + 18221,
      "2 expected recurring charges",
    ]);
    // …the month /recurring's forecast holds it in, named by the day it falls due — never "next Oct 25"
    expect(detailsIn("2026-11", OCT30)).toContain("1 × -$182.21 (monthly), next Nov 1");
  });

  test("⚖️ (B) …the rent typed Nov 16: due by the Nov 12 paycheck leaves out their Nov 1, due with its Nov 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    bundle.db
      .insert(recurringSeries)
      .values({
        ...bill("pay", "Weekly pay", 114192, "2026-11-12"),
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7,
        anchorDay: null,
      })
      .run();
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV10 = "2026-11-10";
    const { upcoming } = dashboardData(bundle.db, NOV10);
    // 🔴 at aa05a56d -$182.21: their Nov 1 compared by its own day, before a paycheck their Nov 16 comes after
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-11-12", cents: 0 });
    // …and the strip lists it on the rent's Nov 16, beside the rent — never "Rent utilities & fees Nov 1" first
    expect(
      upcoming.items.filter((i) => i.seriesId === UTIL || i.seriesId === RENT).map((i) => [i.seriesId, i.date]),
    ).toEqual([
      [UTIL, "2026-11-16"],
      [RENT, "2026-11-16"],
    ]);
  });

  test("⚖️ (B) …paid Nov 16, December unpaid: on Dec 10 their Dec 1 is next Dec 16, on Dec 20 it came due Dec 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    checkedThrough(bundle.db, "acct", "2026-12-09");
    // 🔴 at aa05a56d "next Dec 1" on Dec 10 — a day already past — and "came due Dec 1 and has not posted" on Dec 20
    expect(detailsIn("2026-12", "2026-12-10")).toContain("1 × -$182.21 (monthly), next Dec 16");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    expect(detailsIn("2026-12", DEC20)).toContain("1 × -$182.21 (monthly), came due Dec 16 and has not posted");
    expect(owed(DEC20)).toEqual([
      [UTIL, "2026-12-16", 18221],
      [RENT, "2026-12-16", 229121],
    ]);
    expect(seriesDetail(bundle.db, UTIL, DEC20)!.overdue!.date).toBe("2026-12-16");
    // …and the calendar draws it missed on that day, beside the rent — nothing of theirs on their own Dec 1
    expect(marks("2026-12", "2026-12-01", DEC20)).toEqual([]);
    expect(unpaid("2026-12", "2026-12-16", DEC20).sort()).toEqual([RENT, UTIL]);
  });

  /*
   * ⛔ …and a row of their OWN sitting unattached is matched to a day of theirs as one attached is graded — by their own
   * days (`paymentFor`, "…a row of their own pays by their own days" above), the days the import links one on
   * (`projectOwnDays`) — never by the rent's day that day falls due with: the one rule (`lib/unattached-match`) on the
   * runway, their page and the calendar alike (`readDueDays`, the calendar's `asked`). The rent typed Nov 16 and paid
   * Nov 16, December unpaid, read Dec 20: their own −$182.21 of Dec 1 sits on the account unattached — on time for
   * their Dec 1, which falls due with the rent's Dec 16 — and is named; their Dec 1 is still owed. 🔴 Merged with 8b's
   * rule as its code read at b86f4e88, the day asked was the occurrence's `date` — since 933b29e2 the day it falls due,
   * Dec 16, fifteen days from the row — so the runway read "A further $2,473.42 came due earlier this month and has not
   * posted." and December drew a ✕ on Dec 16 beside the row.
   */
  test("⛔ (B) …their own unattached −$182.21 of Dec 1 is named by their own Dec 1 — never 'has not posted'", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    pay("t-util-own-dec1", null, "2026-12-01", -18221);
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    // still owed, on the day it fell due: the row names it, and pays nothing
    expect(owed(DEC20)).toEqual([
      [UTIL, "2026-12-16", 18221],
      [RENT, "2026-12-16", 229121],
    ]);
    const util = arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), DEC20).series.find((s) => s.id === UTIL)!;
    expect(util.unattached.map((m) => [m.date, m.row.postedOn, m.row.amountCents])).toEqual([
      ["2026-12-01", "2026-12-01", -18221],
    ]);
    expect(seriesDetail(bundle.db, UTIL, DEC20)!.overdue!.unattached!.map((m) => m.row.postedOn)).toEqual([
      "2026-12-01",
    ]);
    // …its row "not attached to them", the bills the runway sums (`billsPronoun`, review of ffb1b2d3)
    expect(arrearsSentence(committedBook(bundle.db, DEC20))).toBe(
      "A further $2,473.42 came due earlier this month and $182.21 is matched to the cent by a row of $182.21 " +
        "on Dec 1 that is not attached to them, and $2,291.21 has not posted.",
    );
    // …and December draws it "?" on the rent's Dec 16 it falls due with, naming the row — never a ✕ beside it
    const mark = recurringCalendar(bundle.db, "2026-12", DEC20).entriesByDay["2026-12-16"]!.find(
      (e) => e.seriesId === UTIL,
    )!;
    expect([mark.state, mark.unsettledReason, mark.unattached?.row.postedOn]).toEqual([
      "unsettled",
      "matched_unattached",
      "2026-12-01",
    ]);
    // …and the mark on Dec 16 says the row answers their OWN Dec 1 — 🔴 review of 95cdf198 (L81): it named "a row of
    // $182.21 on Dec 1" in a cell of Dec 16, fifteen days apart, and nothing said why
    expect(unsettledWords(mark)).toBe(
      "its own Dec 1 is matched to the cent by a row of $182.21 on Dec 1 that is not attached to it",
    );
    // the rent's mark, on its own day, reads as every mark billed on its own does
    const rentMark = recurringCalendar(bundle.db, "2026-12", DEC20).entriesByDay["2026-12-16"]!.find(
      (e) => e.seriesId === RENT,
    )!;
    expect(rentMark.ownDate).toBeUndefined();
  });

  /*
   * ⛔ …and a day of theirs gone past is GRADED on the day it falls due, the day it is drawn on
   * (`SeriesOccurrence.date`), once the month's days are all in hand (the calendar's `past`): whether the ledger has
   * read it, with its grace, is asked of the rent's Nov 16 — never of their own Nov 1. The rent typed Nov 16, nothing
   * of November posted, read through Nov 9: on Nov 20 the runway says no statement has covered either yet, and
   * November draws both "?" on Nov 16 — no ✕ beside them. 🔴 Graded on their own day — a mutation of the merge of
   * 933b29e2 into b8bc8444's deferred grading (2026-10-30), which no test caught — their Nov 1 and its 3 days of
   * grace, read through Nov 9, drew a ✕ "missed" on Nov 16 beside a runway that said no statement had covered it.
   */
  test("⛔ (B) …read through Nov 9, on Nov 20 their Nov 1 is graded on the rent's Nov 16: no statement, no ✕", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV20 = "2026-11-20";
    expect(owed(NOV20)).toEqual([
      [UTIL, "2026-11-16", 18221],
      [RENT, "2026-11-16", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBe(
      "A further $2,473.42 came due earlier this month and no statement has covered it yet.",
    );
    const nov16 = recurringCalendar(bundle.db, "2026-11", NOV20).entriesByDay["2026-11-16"]!;
    expect(nov16.map((e) => [e.seriesId, e.state, e.unsettledReason])).toEqual([
      [UTIL, "unsettled", "not_imported"],
      [RENT, "unsettled", "not_imported"],
    ]);
  });

  /*
   * ⛔ …and the one rule is asked of a day of theirs only once the day it FELL DUE is read — the arrears' read days
   * (`readDueDays`, by `occurrenceDates`) — and only then looks on their OWN day for a row (`occurrenceOwnDates`, the
   * Dec 1 test above). The rent typed Nov 16, nothing of November posted, read through Nov 9, a Meal Kit −$125.00 due
   * the 3rd unpaid, and a −$182.21 of their own Nov 1 sitting unattached: on Nov 20 their Nov 1 falls due with the
   * rent's Nov 16, which no statement has covered, so the row is named for no day of theirs — the Meal Kit's $125.00 is
   * what has not posted. 🔴 Filtered by their own Nov 1 — a mutation of the merge of 933b29e2 no test caught (review
   * of 06abaf61: 457 files, 10,190 tests passed) — the runway read "A further $2,598.42 came due earlier this month:
   * $125.00 is matched to the cent by a row of $182.21 on Nov 1 that is not attached to it, and no statement has
   * covered the other $2,473.42 yet.", and their page carried the row (`overdue.unattached`) for a day no statement
   * has covered.
   */
  test("⛔ (B) …read through Nov 9, their own −$182.21 of Nov 1 unattached: on Nov 20 no row is named for it", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    seriesWith(MEAL, "Meal Kit", -12500, "2026-09-03", ["2026-09-03", -12500], ["2026-10-03", -12500]);
    pay("t-util-own-nov1", null, "2026-11-01", -18221);
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV20 = "2026-11-20";
    expect(owed(NOV20)).toEqual([
      [MEAL, "2026-11-03", 12500],
      [UTIL, "2026-11-16", 18221],
      [RENT, "2026-11-16", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBe(
      "A further $2,598.42 came due earlier this month: $125.00 has not posted, and no statement has covered the " +
        "other $2,473.42 yet.",
    );
    const late = arrearsThisMonth(bundle.db, new Set([RENT, UTIL, MEAL]), NOV20).series;
    expect(late.map((s) => [s.id, s.unattached])).toEqual([
      [MEAL, []],
      [UTIL, []],
      [RENT, []],
    ]);
    expect(seriesDetail(bundle.db, UTIL, NOV20)!.overdue!.unattached).toEqual([]);
  });

  /*
   * ⛔ …and the calendar asks the one rule of exactly those days — each read on the day it falls due
   * (`asksForUnattachedMatch` on `date`) — so a row the runway gives one bill is never spent on a day of theirs no
   * statement has covered. The same shape, with a Water −$182.21 due the 2nd (three postings) unpaid and one −$182.21
   * row of Nov 1 unattached: their Nov 1 falls due with the rent's unread Nov 16, so the row is Water's Nov 2 — named
   * on the runway and Water's page, and drawn "?" naming it. 🔴 Asked on their own Nov 1 — a mutation no test caught
   * (review of 06abaf61: 73 files, 2,782 tests passed) — their unread Nov 1 took the row in the calendar's matching,
   * and November drew Water's Nov 2 a red ✕ "missed" beside a runway naming the row for it. Filtered by their own day
   * in the arrears (above), the row was theirs there, and Water's page read "Already due, and not posted" beside it.
   */
  test("⛔ (B) …and a Water −$182.21 due Nov 2: their Nov 1's row is Water's, on the runway and the calendar", () => {
    const WATER = "water";
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    const water: [string, number][] = [
      ["2026-08-02", -18221],
      ["2026-09-02", -18221],
      ["2026-10-02", -18221],
    ];
    seriesWith(WATER, "Water", -18221, "2026-08-02", ...water);
    pay("t-row-nov1", null, "2026-11-01", -18221);
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV20 = "2026-11-20";
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBe(
      "A further $2,655.63 came due earlier this month: $182.21 is matched to the cent by a row of $182.21 on Nov 1 " +
        "that is not attached to them, and no statement has covered the other $2,473.42 yet.",
    );
    const late = arrearsThisMonth(bundle.db, new Set([RENT, UTIL, WATER]), NOV20).series;
    expect(late.map((s) => [s.id, s.nextDate, s.unattached.map((m) => [m.date, m.row.postedOn])])).toEqual([
      [WATER, "2026-11-02", [["2026-11-02", "2026-11-01"]]],
      [UTIL, "2026-11-16", []],
      [RENT, "2026-11-16", []],
    ]);
    expect(seriesDetail(bundle.db, WATER, NOV20)!.overdue!.unattached!.map((m) => m.row.postedOn)).toEqual([
      "2026-11-01",
    ]);
    // …and November draws Water's Nov 2 "?" naming that row — never a ✕ — and theirs and the rent's "?" on Nov 16
    const november = recurringCalendar(bundle.db, "2026-11", NOV20).entriesByDay;
    const drawn = (day: string) =>
      (november[day] ?? []).map((e) => [e.seriesId, e.state, e.unsettledReason, e.unattached?.row.postedOn ?? null]);
    expect(drawn("2026-11-02")).toEqual([[WATER, "unsettled", "matched_unattached", "2026-11-01"]]);
    expect(drawn("2026-11-16")).toEqual([
      [UTIL, "unsettled", "not_imported", null],
      [RENT, "unsettled", "not_imported", null],
    ]);
  });

  /*
   * ⚖️ (B) …and "paid early" is measured against the day the grid draws it on, the day it falls due: the rent typed Nov
   * 16 and paid Nov 16, then Dec 5 — nearer its Dec 16 (decision 76), so early for it — pays their Dec 1, which falls
   * due with that Dec 16: drawn there "paid early with the rent's payment of Dec 5". Measured against their own Dec 1 it
   * would read as paid on its day, four days after it. ⛔ …and the All tab steps past that paid Dec 1 once, to their
   * Jan 1 — on Dec 10, asked from Dec 2, it still falls due on or after it (the rent's Dec 16): a day of theirs paid
   * early past the first period, where the walk's step back (above, "…paid early Nov 5") reaches it again too.
   */
  test("⚖️ (B) …the rent's Dec 5, early for its Dec 16: their Dec 1 is drawn on Dec 16, paid early by it", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-05",
    );
    checkedThrough(bundle.db, "acct", "2026-12-09");
    const DEC10 = "2026-12-10";
    expect(marks("2026-12", "2026-12-16", DEC10)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-05", early: true }],
    ]);
    expect(owed(DEC10)).toEqual([]);
    expect(coming(DEC10, UTIL)[0]).toBe("2027-01-16");
    expect(walkOf(UTIL, DEC10)).toEqual(["2027-01-16", ["2026-12-01", "2027-01-01"]]);
    expect(listSeries(bundle.db, DEC10).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-16");
  });

  test("⚖️ (B) …on the 25th, the rent typed Sep 1: each day of theirs is drawn, forecast and owed on the rent's 1st", () => {
    rentWith(
      { rentOn: "2026-09-01", typed: true, utilOn: "2026-10-25", utilTyped: true, noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-10-28");
    const OCT29 = "2026-10-29";
    // 🔴 at aa05a56d October drew their Oct 25 "upcoming" and counted it in its Expected, beside a card holding none —
    // their Oct 25 falls due with the rent's Nov 1, and nothing of theirs before it is projected (their date opens them)
    const october = recurringCalendar(bundle.db, "2026-10", OCT29);
    expect(Object.values(october.entriesByDay).flat().filter((e) => e.seriesId === UTIL)).toEqual([]);
    expect(october.upcomingNetCents).toBe(0);
    expect(labelsIn("2026-10", OCT29)).not.toContain("Rent utilities & fees");
    // …and November draws, forecasts and names their Oct 25 on the rent's Nov 1
    expect(marks("2026-11", "2026-11-01", OCT29)).toEqual([
      [UTIL, "upcoming", null],
      [RENT, "upcoming", null],
    ]);
    expect(detailsIn("2026-11", OCT29)).toContain("1 × -$182.21 (monthly), next Nov 1");
    // …and, nothing of November posted, it came due Nov 1 with the rent — never "came due Oct 25"
    checkedThrough(bundle.db, "acct", "2026-11-04");
    const NOV5 = "2026-11-05";
    expect(owed(NOV5)).toEqual([
      [UTIL, "2026-11-01", 18221],
      [RENT, "2026-11-01", 229121],
    ]);
    expect(detailsIn("2026-11", NOV5)).toContain("1 × -$182.21 (monthly), came due Nov 1 and has not posted");
  });

  /*
   * ⛔ …and whether its schedule has ENDED is asked of the days a projection walks (`scheduleHasEnded`): from where its
   * carrier opens it, each day falling due with the carrier's day it pairs with — ONE day for every reader. 🔴 Asked of
   * its own schedule alone (review of 46f19f15, L57), the utilities detected Sep 1 and ending Oct 15, the rent typed
   * Nov 1: on Sep 20 nothing projected them — their Nov 1 lies past the end — while the forecast's predicate called them
   * live: the subscriptions card counted them, and their page and the All tab read "~$0.00/yr" (his ledger copy
   * 2026-11-04, the same what-if). 🔴 …and the other way, the rent typed Nov 16 and paid Nov 16, theirs ending Dec 10:
   * from Dec 2 their own Dec 1 was past and the page read "nothing expected", no Next on the All tab, while Upcoming
   * and the calendar still held it on the rent's Dec 16 (review of 933b29e2, L74).
   */
  test("⛔ …ending before the rent's date opens them: on Sep 20 nothing projects them, and they have ended", () => {
    rentWith({ rentOn: "2026-11-01", typed: true, utilOn: "2026-09-01", noneOfTwo: true }, "2026-07-01", "2026-08-02");
    bundle.db.update(recurringSeries).set({ userEndsOn: "2026-10-15" }).where(eq(recurringSeries.id, UTIL)).run();
    const SEP20 = "2026-09-20";
    const page = seriesDetail(bundle.db, UTIL, SEP20)!;
    expect([page.evidence, page.nextExpected, page.annualizedCents]).toEqual(["schedule-ended", [], null]);
    expect(listSeries(bundle.db, SEP20).find((s) => s.id === UTIL)!.annualizedCents).toBeNull();
    // the rent's Nov 1 is still to come: of the two, only what it carries has ended
    expect(subscriptionsCard(bundle.db, SEP20)!.endedCount).toBe(1);
  });

  test("⛔ …ending Dec 10, their Dec 1 still comes with the rent's Dec 16: on Dec 2 their page names it", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    bundle.db.update(recurringSeries).set({ userEndsOn: "2026-12-10" }).where(eq(recurringSeries.id, UTIL)).run();
    const DEC2 = "2026-12-02";
    expect(coming(DEC2, UTIL)).toEqual(["2026-12-16"]);
    const page = seriesDetail(bundle.db, UTIL, DEC2)!;
    expect([page.evidence, page.nextExpected.map((o) => o.date)]).toEqual(["active", ["2026-12-16"]]);
    expect(listSeries(bundle.db, DEC2).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-12-16");
    // …and once the rent's Dec 16 has come, nothing of theirs is left inside the end
    expect(seriesDetail(bundle.db, UTIL, "2026-12-17")!.evidence).toBe("schedule-ended");
  });

  /*
   * ⛔ …and the End dialog's span runs FORWARD: from the day its list names first to its end — or, past the end, to the
   * day its last charge inside the end falls due on (`SeriesDetail.lastFallsDueOn`). 🔴 Review of 933b29e2 (L74): the
   * rent typed Nov 16 and paid Nov 16, theirs ending Dec 10 — on Nov 20 their dialog read "Upcoming charges off the
   * calendar: every charge from Dec 16, 2026 to Dec 10, 2026" (his ledger copy 2026-11-04, the same what-if).
   */
  test("⛔ …ending Dec 10, their End dialog's span runs from the rent's Dec 16 to it — never back to Dec 10", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    const NOV20 = "2026-11-20";
    const upcomingOn = (endsOn: string) => {
      bundle.db.update(recurringSeries).set({ userEndsOn: endsOn }).where(eq(recurringSeries.id, UTIL)).run();
      const lines = seriesEndLines(seriesEndInput(seriesDetail(bundle.db, UTIL, NOV20)!), formatCents);
      return lines.find((l) => l.label === "Upcoming charges off the calendar")!.value;
    };
    expect(upcomingOn("2026-12-10")).toBe("every charge from Dec 16, 2026 to Dec 16, 2026");
    // their Jan 1, inside a Jan 10 end, falls due with the rent's Jan 16
    expect(upcomingOn("2027-01-10")).toBe("every charge from Dec 16, 2026 to Jan 16, 2027");
    // …and past the day their last charge falls due, the end itself, as one billed on its own reads
    expect(upcomingOn("2027-01-20")).toBe("every charge from Dec 16, 2026 to Jan 20, 2027");
  });
});
