import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { addDays, compareDates } from "@/lib/dates";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { closeLedger, coming, openLedger, RENT, rentWith, UTIL } from "./nearer-due-day-fixture";

/**
 * ⛔ The runway's two legs hold a day of what the rent carries by ONE day, the day it FALLS DUE (`SeriesOccurrence.date`:
 * the later of its own day and the rent's day it pairs with, ⚖️ default (B), built, not asked, 2026-10-30) — the twelve
 * months from today (`scheduledOccurrences`) until that day, the arrears (`arrearsThisMonth`) from the day after — so
 * the two abut on today for it too: no day of it in both, and none in neither. On the temp ledger decision 76's pins
 * grade on (`nearer-due-day-fixture`), the what-ifs below laid on it. Latent on his ledger: the rent typed Sep 1 and the
 * utilities detected Sep 1, every day of theirs falls due on its own 1st (his ledger copy 2026-11-05).
 *
 * 🔴 The twelve months held its OWN days (review of cd58b3d1, L139): between the last own day of what the rent carries
 * and the day it falls due with the rent's, that charge was in neither leg — still owed, and hidden from the runway.
 * Measured on his ledger copy 2026-11-05 at 73890338, the what-ifs below: the rent retyped Nov 16, paid Nov 16 and Dec
 * 16, Wells Fargo read through Dec 19, the utilities' end typed Feb 10, 2027 — the twelve months held $38,634.83 on Feb
 * 1 and $38,452.62 from Feb 2 to Feb 16, their Feb 16 $182.21 neither still to come nor owed; the utilities as one
 * charge on Nov 1, the rent retyped Nov 16, read through Nov 9 — $39,422.73 on Oct 30 and Nov 1, $39,240.52 from Nov 2
 * to Nov 10.
 */
let bundle: DbBundle;
beforeEach(() => {
  ({ bundle } = openLedger());
});
afterEach(closeLedger);

const endOn = (day: string) =>
  bundle.db.update(recurringSeries).set({ userEndsOn: day }).where(eq(recurringSeries.id, UTIL)).run();
/** the rent's day of the month as detection proved it (`anchor_day`), beside a next date stored clamped */
const rentAnchoredOn = (anchorDay: number) =>
  bundle.db.update(recurringSeries).set({ anchorDay }).where(eq(recurringSeries.id, RENT)).run();
/** a month-end rent's rows, each on the 31st or its month's last day — what proves the 31st (`deriveAnchorDay`) */
const MONTH_END_ROWS = ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"];
/** the utilities in the runway's book on `today`: [their payments in its twelve months, what of them it owes] */
const legsOn = (today: string): [number, number] => {
  const line = committedBook(bundle.db, today).lines.find((l) => l.seriesId === UTIL);
  return [line?.occurrences ?? 0, line?.overdueCents ?? 0];
};
/** what the runway's twelve months hold on `today` */
const totalOn = (today: string): number => committedBook(bundle.db, today).totalCents;
/** every day from `from` to `to`, inclusive */
function daysFrom(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; compareDates(day, to) <= 0; day = addDays(day, 1)) days.push(day);
  return days;
}

describe("⛔ what the rent carries is in ONE leg of the runway's book every day — by the day it falls due", () => {
  test("⛔ ending Feb 10, their Feb 1 due with the rent's Feb 16: in the twelve months to Feb 16, owed from Feb 17", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-16",
    );
    endOn("2027-02-10");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    // the same twelve months on Feb 1, Feb 11 and Feb 16 — and every day between: their last charge is in them until
    // the day it falls due, the rent's Feb 16
    const feb1 = totalOn("2027-02-01");
    for (const day of daysFrom("2027-02-01", "2027-02-16")) {
      expect(totalOn(day), day).toBe(feb1);
      expect(legsOn(day), day).toEqual([1, 0]);
    }
    // …and from the day after, owed — in the arrears, and out of the twelve months
    for (const day of ["2027-02-17", "2027-02-20", "2027-02-28"]) expect(legsOn(day), day).toEqual([0, 18_221]);
    expect(totalOn("2027-02-17")).toBe(feb1 - 18_221);
    // ⛔ …and on Jan 12 both of theirs still to come are in them: their Jan 1 and Feb 1, due Jan 16 and Feb 16
    expect(coming("2027-01-12", UTIL)).toEqual(["2027-01-16", "2027-02-16"]);
    expect(legsOn("2027-01-12")).toEqual([2, 0]);
  });

  test("⛔ once on Nov 1, due with the rent's Nov 16: in the twelve months from Oct 30 to Nov 16, owed from Nov 17", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-11-01", utilTyped: true, noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    endOn("2026-11-01");
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const oct30 = totalOn("2026-10-30");
    for (const day of daysFrom("2026-10-30", "2026-11-16")) {
      expect(totalOn(day), day).toBe(oct30);
      expect(legsOn(day), day).toEqual([1, 0]);
    }
    for (const day of ["2026-11-17", "2026-11-20"]) expect(legsOn(day), day).toEqual([0, 18_221]);
  });
});

/*
 * ⛔ …and held by the day it falls due, a day of it is admitted to whole calendar months by the day of the month THAT day
 * is billed on (`SeriesOccurrence.anchorDayOfMonth`, `fallsDueDayOfMonth`): on the rent's later day the rent's, on its
 * own its own, on one day both share the later of the two — so an open-ended one is billed as often as the rent it is
 * billed with, N payments in N months, whatever day either falls on and whatever day you ask. Asked of its own day's
 * (the 1st) a horizon opening on Nov 15 would take in the rent's Nov 16 a year on, thirteen of their charges in twelve
 * months; of the date alone, a six-month one opening Aug 30 their Feb 28 the rent's 31st clamps to, seven in six.
 * ⛔ The rent's day of the month is its walk's (`CarrierPairing.carrierDayOfMonth`, `walkDayOfMonth`): the day its rows
 * proved (`anchor_day`) where its next date is stored clamped — a month-end rent detected, its Nov 30 is its 31st's.
 * 🔴 The shapes below once all typed the rent, and his date clears that day (`effectiveSchedule`): read off the stored
 * date alone, the 30th, every test still passed (review of 59374295) — and asked on Dec 31, their Dec 31 a year on was
 * in the twelve months and the rent's was not, thirteen of theirs to its twelve, seven to its six (the temp ledger).
 */
describe("⛔ …and an open-ended one is billed as often as the rent it is billed with — N payments in N months", () => {
  test.each([
    // [the rent's date, theirs, the first day of theirs to fall due — and, the rent's date detected, not his, the day
    // of the month its rows proved (`anchor_day`): his date clears it (`effectiveSchedule`)]
    ["2026-11-16", "2026-11-01", "2026-11-16"], // their 1st falls due with the rent's 16th: the rent's 16th
    ["2026-08-31", "2026-08-25", "2026-08-31"], // their 25th with the rent's 31st, Feb 28 in February: the rent's 31st
    ["2026-11-01", "2026-11-05", "2026-11-05"], // their 5th falls due on itself, after the rent's 1st: their own 5th
    ["2026-10-31", "2026-11-01", "2026-11-01"], // their 1st falls due on itself, after the rent's 31st: their own 1st
    ["2026-08-30", "2026-08-31", "2026-08-31"], // their 31st and the rent's 30th share Sep 30 and Feb 28: the 31st
    ["2026-08-31", "2026-08-28", "2026-08-31"], // their 28th and the rent's 31st share Feb 28: the 31st
    // their 25th with a rent detected on the 31st, its next date stored clamped to Nov 30: the rent's 31st, read off
    // its anchor day, not its date's 30th
    ["2026-11-30", "2026-11-25", "2026-11-30", 31],
  ])("the rent on %s, theirs on %s — first due %s", (rentOn, utilOn, firstDue, anchorDay?: number) => {
    if (anchorDay === undefined) {
      rentWith({ rentOn, typed: true, utilOn, utilTyped: true, noneOfTwo: true }, "2026-07-01", "2026-08-02");
    } else {
      rentWith({ rentOn, typed: false, utilOn, utilTyped: true, noneOfTwo: true }, ...MONTH_END_ROWS);
      rentAnchoredOn(anchorDay);
      // ⛔ …and each of theirs due on the rent's day, stepped by the day its rows proved: Dec 31, not a Dec 30
      expect(coming(addDays(rentOn, -1), UTIL)).toEqual(coming(addDays(rentOn, -1), RENT));
    }
    expect(coming(addDays(rentOn, -1), UTIL)[0]).toBe(firstDue);
    for (const months of [6, 12]) {
      for (const day of daysFrom(addDays(rentOn, -1), addDays(rentOn, 33))) {
        const book = committedBook(bundle.db, day, months);
        const payments = (id: string) => book.lines.find((l) => l.seriesId === id)?.occurrences;
        expect([payments(UTIL), payments(RENT)], `${day}, ${months} months`).toEqual([months, months]);
      }
    }
  });
});
