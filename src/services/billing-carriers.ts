import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import type { BillingCarrier } from "@/lib/billed-with";
import { compareDates, diffDays } from "@/lib/dates";
import { occurrencesOf, paidAheadDays, readsPerOccurrence } from "@/lib/posted-average";
import { effectiveSeries, resolveMergeTarget } from "./recurring";

/**
 * ⚖️ Each series billed INSIDE another, and the carrier it is billed with (owner decision 2026-10-08, §6A 59) — keyed
 * by the CARRIED series' id. The one place the link column is read; `lib/billed-with` is what it means.
 *
 * The carrier is the LIVE series the link names, followed through any merge (`resolveMergeTarget`, detection's own
 * forward map). 🔴 It lent the named series' own `last_matched_on`, and a merge ends the source without touching it:
 * the rent merged into detection's series of the Wells Fargo rows kept posting under the target while the utilities
 * read the ended rent's Sep 2 — and 93 days on they lapsed out of the forecast, the committed book, the arrears and
 * the card's live figure, with nothing on screen to say why. His link stays as he wrote it; the READING follows the
 * merge. A carrier merged INTO the series it carries lends nothing: its postings are that series' own now.
 *
 * ⚖️ …and so do the WORDS: the carrier is named by the live series' own name (`carrierWord`) on every surface — merged
 * into detection's "Flamingo South Beach", "billed with Flamingo South Beach"; named "… (rent)", "billed with the
 * rent" again — never the ended rent's word on one surface and the live series' on another (review of §6A 59,
 * resolved 2026-10-13; pinned in billed-with.test.ts, "after the merge every surface names…").
 *
 * Two small queries rather than a self-join: `aliasedTable` breaks drizzle's row inference (see `seriesHues`), and on
 * a ledger with no link the second is never asked. The second reads every series, as detection's merge map does — a
 * merge chain can pass through any of them.
 */
export function billingCarriers(db: AppDatabase): ReadonlyMap<string, BillingCarrier> {
  const carried = db
    .select({ id: recurringSeries.id, carrierId: recurringSeries.userBilledWithSeriesId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userBilledWithSeriesId))
    .all();
  if (carried.length === 0) return new Map();
  const series = db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      lastMatchedOn: recurringSeries.lastMatchedOn,
      mergedIntoId: recurringSeries.mergedIntoId,
    })
    .from(recurringSeries)
    .all();
  const byId = new Map(series.map((s) => [s.id, s] as const));
  const mergedById = new Map(series.map((s) => [s.id, s.mergedIntoId] as const));
  const carriers: (readonly [string, BillingCarrier])[] = [];
  for (const c of carried) {
    const liveId = resolveMergeTarget(c.carrierId!, mergedById);
    if (liveId === c.id) continue;
    // the column REFERENCES the table and a merge names a series in it, so every carrier is there
    const { id, name, lastMatchedOn } = byId.get(liveId)!;
    carriers.push([c.id, { id, name, lastMatchedOn }]);
  }
  return new Map(carriers);
}

/**
 * ⚖️ The other way round: per CARRIER, the names of the series billed inside its payments (§6A 59) — keyed by the LIVE
 * carrier (`billingCarriers`, through any merge), names in order. A carrier's posted average holds their money too, and
 * the line naming it says so (`carriesPhrase`). Nothing is asked of a ledger with no link.
 */
export function carriedNamesBySeries(db: AppDatabase): ReadonlyMap<string, readonly string[]> {
  const carriers = billingCarriers(db);
  if (carriers.size === 0) return new Map();
  const names = new Map(
    db
      .select({ id: recurringSeries.id, name: recurringSeries.name })
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, [...carriers.keys()]))
      .all()
      .map((s) => [s.id, s.name] as const),
  );
  const out = new Map<string, string[]>();
  for (const [carriedId, carrier] of carriers) {
    out.set(carrier.id, [...(out.get(carrier.id) ?? []), names.get(carriedId)!].sort((a, b) => a.localeCompare(b)));
  }
  return out;
}

/**
 * The rows, each with the carrier it is billed with (`billedWith`, null when billed on its own) — how a series row
 * reaches an evidence reader (`seriesStaleness`, `seriesEvidence`, `hasStoppedForecasting`…), which REQUIRE it.
 */
export function withBillingCarriers<T extends { id: string }>(
  db: AppDatabase,
  rows: readonly T[],
): (T & { billedWith: BillingCarrier | null })[] {
  const carriers = billingCarriers(db);
  return rows.map((r) => ({ ...r, billedWith: carriers.get(r.id) ?? null }));
}

/** A posting that may pay a due day: the day it posted, and how many days either side of a due day it may land. */
export interface Payment {
  readonly postedOn: string;
  readonly toleranceDays: number;
  /**
   * ⚖️ It covered more than one charge (`paidAheadDays`) — in the rate era in force now, the payment its series'
   * posted average names; in an earlier one, a payment its own era's rate reads so, which no average names (the
   * average holds today's era only, `atTodaysRate` — latent: only his pay has a rate history) — and so pays a second
   * due day (`paymentFor`'s catch-up). Every grader's are read with it (`BillPayment`); absent, one charge.
   */
  readonly coveredMore?: boolean;
}

/**
 * A bill's due days either side of one — its schedule's steps from its anchor, its end and its anchor disregarded
 * (`dueDaysOf`): the days a payment between two of them is measured against, to pay the one it lies nearer (⚖️ his
 * decision 76, `paymentFor`). Every grader of a bill's day passes the series' own, so each reads the same days.
 */
export interface DueDays {
  /** the due day after `day`, or null — which asks nothing late (`stillToComeReader`) */
  readonly after: (day: string) => string | null;
  /** the due day before `day`, or null — which leaves nothing to pay `day` early */
  readonly before: (day: string) => string | null;
  /**
   * ⚖️ the day its schedule opens — its anchor, where every reader's projection of a bill starts (`projectOccurrences`)
   * — or null with no schedule: a due day before it and before every payment is no charge, so no payment of two
   * catches it up (`paymentFor`'s catch-up, `couldHaveCharged`; default built, not asked, 2026-10-23)
   */
  readonly opensOn: string | null;
  /**
   * ⚖️ …and whether that day is HIS (`userNextExpectedOn`): his date IS the schedule, so no day before it was a charge,
   * whatever posted before it (default built, not asked, 2026-10-23), nor one a payment of two catches up from
   * (`liesBeforeHisDate`, 2026-10-29). ⛔ Every grader passes the series' own row (`dueDaysOf`), the readers that look
   * ahead too: pinned in nearer-due-day.test.ts ("…on Sep 1 no reader that looks ahead lists Sep 11").
   */
  readonly opensOnHisDate: boolean;
}

/**
 * The payment that pays a due day, or undefined — ON TIME, the nearest within its own tolerance of it, the earlier of
 * two as near; else EARLY or LATE (below). ⛔ The one test of "did a posting cover this occurrence" for every grader of
 * a bill: the arrears (`overdueForSeries`), the calendar (a posting of its own, or its carrier's) and every reader that
 * looks ahead (`stillToComeReader`), so none can grade one Oct 1 apart from another — given the same postings: each
 * reads all of a series' (`billPaymentsBySeries`).
 *
 * 🔴 The calendar read a bill's own postings inside the month alone (review of 1a1b753): with the rent paid Sep 30,
 * October drew its Oct 1 "missed" beside the utilities "paid with the rent's payment of Sep 30", and the arrears owed
 * neither.
 *
 * ⚖️ …else EARLY or LATE by THE NEARER DUE DAY, his decision 76 (2026-10-14, his answer, refines 73). The option he
 * chose reads, word for word: "A payment between two due days pays the one it's nearer to (a tie goes to the earlier
 * one), unless the nearer one is already paid on time." Its description went on with examples written for him, not
 * his words: Sep 2 → Sep 15, an Oct 1 payment → Oct 15, "FPL's 28th drafts" → the next 8th, Car insurance's Sep 3 →
 * Sep 11. 🔴 The third is no shape of his: FPL has posted twice, Jul 10 −$14.21 and Jul 28 −$56.22 (his ledger copy,
 * 2026-10-21), and Jul 28 pays Aug 8. So a payment between two due days — past the earlier's tolerance and short of
 * the later's (`DueDays.before`, `DueDays.after`) — pays the one it lies NEARER, a tie the earlier
 * (`liesNearerTheLater`): the later EARLY, only when nothing paid that day on time; the earlier LATE. Of several for
 * one day, the earliest, asked early before late. The grace is the days a payment has to post before anything may say
 * "not posted" (his decision 60, 2026-10-08); a payment past them is still a day's. The cost he accepted: one nearer
 * the next day pays it even when the day before is unpaid — FPL paid only Jul 28 owes Jul 8 where it owed Aug 8, one
 * month owed either way.
 *
 * What a payment LEFT OVER pays — one nearer a day another payment already pays — his answer does not say: it stops at
 * "unless", and never reaches a nearer day paid EARLY. The three answers below came with the build (f8b5320, from a
 * brief that read "→ the other day" — a paraphrase of his answer, not his words — built one way only); he said no more
 * questions (2026-10-21), so none was asked, and each is written as a default:
 * (a) ⚖️ default built, not asked (2026-10-21) — nearer the EARLIER day, paid ON TIME by another: it pays nothing,
 *     never the later day early. A lease paid on time Oct 15, then $695.04 more Oct 22, still has Nov 15 coming on
 *     Oct 23, in November's forecast at −$695.04 — counted again — and "has not posted" once read past it, drawn
 *     "?" (not yet known: two postings prove no schedule, `scheduleIsProven`), ✕ missed once three do. 🔴 This takes
 *     back decision 73 for that shape: run against 7aca8e5's paymentFor, Oct 22 paid Nov 15 early. What it keeps: a
 *     rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 keeps Nov 1 coming, with November's −$2,109.00 rent and −$182.21
 *     utilities (73 paid it early with the $291.21 — its 🔴, below), and FPL's Jul 12 (Jul 8 paid Jul 10) pays no Aug
 *     8. Paying the other day early instead would read the split's $291.21 as November paid and silently drop Nov 1's
 *     $2,291.21 from Upcoming and the forecast; this default's error shows on screen instead, and lasts one month.
 * (b) ⚖️ default built, not asked (2026-10-21) — nearer a day paid EARLY by another, either side: it pays nothing too.
 *     A lease paid Sep 2 (Sep 15's, early) then Sep 30 — the 15/15 tie, Sep 15's — owes Oct 15 $695.04, as 73 did;
 *     after Sep 2 + Oct 1, Oct 30 leaves Nov 15 coming where Oct 31 pays it. For a bill due the 15th, a pay on the
 *     30th, a Feb 28 or 29, or a Mar 1 outside a leap year lands this way; one on the 31st or the 1st does not.
 *     Paying the other day here would run on: after the known gap's stray half (Jun 17 paying Jul 1 early, below) the
 *     late rents Jul 8, Aug 5, Sep 6, Oct 7 would each pay the month AFTER their own, and Nov 1 leave Upcoming with
 *     Oct 7. The other side: Oct 5, after Oct 1 paid Oct 15 early, lies nearer Oct 15 too — it pays no Sep 15 late.
 * (c) ⚖️ default built, not asked (2026-10-21) — nearer the LATER day, paid ON TIME by another: it is the EARLIER
 *     day's, LATE — or pays nothing, once that day is paid. The redirect runs ONE WAY. It is the LATE default
 *     (2026-10-12, not asked either — a payment past a day's grace, short of the next day's window, is that day's)
 *     still reading the payment once his "unless" rules the later day out; 73 read it so too. It pays only a day
 *     behind the payment, so it never takes a day still to come out of Upcoming or the forecast, as (a)'s other way
 *     would. FPL's Jul 28 pays Jul 8 when Aug 8 is paid on Aug 8 — and nothing beside Jul 10's on-time Jul 8.
 *     Measured on a what-if copy of his ledger 2026-10-21, his September rent moved from Sep 2 to Sep 20 (−$2,291.21,
 *     11 days before Oct 1): alone, it pays Oct 1 early and September draws Sep 1 missed — the cost above; beside an
 *     on-time Oct 1 rent it is Sep 1's, late, and September draws the utilities paid with it. Paying nothing there
 *     (measured with the redirect turned off) leaves Sep 1's rent and utilities missed beside the $2,291.21 that paid
 *     them; the arrears and Upcoming read the same either way.
 * Each pin names its default (nearer-due-day.test.ts, billing-carriers.test.ts). Measured on what-if copies of his
 * ledger 2026-10-21, with that day's four statements read: the split, the Oct 22 prepay, Sep 30, Oct 30 against Oct
 * 31 and Sep 20 each read as above. Sep 30's Oct 15 is all unread there, because Wells Fargo is read through Sep 24.
 * On the ledger itself no live bill's posting is left over or redirected (9 with postings of their own) and no day
 * moves: the lease has posted once, Sep 2 −$695.04.
 *
 * 🔴 Late paid nothing (review of 44eb3e7): the rent paid Oct 5, four days past its Oct 1 and its 3 days, was drawn
 * beside a red ✕ on Oct 1, the runway said "A further $2,291.21 came due earlier this month and never posted.", and
 * /budgets counted it in what was spent AND in what came due — $4,599.86 projected for one month's rent. His July rent
 * posted Jul 8, nearer Jul 1 than Aug 1. 🔴 Early paid nothing (until his decision 73, 2026-10-13): FPL, due the 8th
 * with 3 days' grace, posted Jul 10 −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8 — and Jul 28
 * paid no due day. A bill drafted around every 28th (a what-if: FPL has posted only these two) would have read every
 * statement's newest 8th "not posted" until the following one.
 *
 * 🔴 Decision 73 paid a day early only once the day before was paid by ANOTHER payment (review of 844e484, measured on
 * his ledger copy 2026-10-13): the Car lease's Sep 2 −$695.04, 13 days before Sep 15, read as Aug 15's late payment
 * and left Sep 15 unpaid — a web pay around every 1st would read as the month before's, and every newest 15th "not
 * posted" once Wells Fargo is read past it; and a rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 paid Nov 1 early with
 * October's second half, so Nov 1 left Upcoming and the November forecast. Nearer, Sep 2 pays Sep 15, an Oct 1 web pay
 * Oct 15, Oct 9 nothing (Oct 1 is paid on time) — and FPL's Jul 28 still pays its Aug 8, Car insurance's $1,000.00
 * of Sep 3 its Sep 11. His lease is anchored on Oct 15 (his date): no surface asks its Aug 15.
 *
 * ⛔ ONE PAYMENT PAYS ONE DUE DAY: on time it is in no gap; between two days it is asked for by one of them only — the
 * later early, or the earlier late — and a day takes one. Rows of one day are ONE payment: his card posted Jun 16's
 * rent as two (`occurrencesOf`). ⚠️ Two halves a day apart are two payments — Jun 16 + Jun 17 pay Jun 1 (the tie) and
 * Jul 1 (nearer it): a known gap neither 73 nor 76 catches.
 *
 * ⚖️ …but ONE PAYMENT OF TWO CHARGES PAYS TWO DAYS — default built, not asked (2026-10-23): one its posted average
 * names as covering more than one charge (`Payment.coveredMore`, `paidAheadDays`: `paidAhead`'s one rule) pays the day
 * the rules above give it, and then ONE more (`catchUpPayment`): the due day BEHIND that one, late, when it is a charge
 * (`couldHaveCharged`) no other payment paid, whatever the payment's timing there; else — LATE for its own day, the
 * day behind it settled (`dayBehindIsSettled`) — the day after, early. A premium due the 11th, Sep 11 missed, then one
 * -$715.16: Sep 19 pays Sep 11 late and Oct 11 early (on Sep 25, Oct 11 is no longer coming), Sep 28 Oct 11 early and
 * Sep 11 late, Oct 12 Oct 11 on time and Sep 11 late. Never a third day, and never the day after one it pays early or
 * on time: a payment AHEAD of its own day is not read, so it takes no day still to come out of Upcoming or the forecast
 * — Car insurance's Sep 3 -$1,000.00 pays Sep 11 early and no Oct 11 (his own date starts its schedule at Dec 11, so
 * neither is asked), and after a paid Aug 11 a -$715.16 on Sep 12 pays no Oct 11. 🔴 At 66daebd one payment paid
 * one day, and the other day a catch-up paid was drawn unpaid beside "covered more than one month": Sep 19 left Oct 11
 * owed — the runway's "A further $3,877.56 came due earlier this month: $357.58 has not posted, …" and the series
 * page's "Already due, and not posted" — and with Sep 28 the arrears owed Sep 11 $357.58 on Sep 30 (review of 66daebd;
 * his ledger copy 2026-10-23 with that premium added on Venture X). 🔴 At 67b3b79 a late one paid the day after
 * whatever lay behind its own day, so after TWO missed charges it paid one of them and a day still to come (review of
 * 67b3b79, the same copy): Aug 11 and Sep 11 missed, Sep 19 took Oct 11 out of Upcoming and October's forecast on Sep
 * 25, and on Oct 23 the runway read only "A further $3,519.98 came due earlier this month and no statement has covered
 * it yet." — his own bills — beside August's ✕; Sep 11 and Oct 11 missed, Oct 20 drew Nov 11 "paid early by its
 * payment of Oct 20, 2026", took it out of Upcoming and November's forecast, named Dec 11 next on the All tab and the
 * page, and left Sep 11 ✕. Now Sep 19 pays Aug 11 and Sep 11, and Oct 20 Sep 11 and Oct 11: a biller puts a payment of
 * two against the two arrears, and an error that shows — a day still listed — beats one that hides, as (a) holds.
 * 🔴 At 8348349 the day behind counted as settled only when paid by its OWN payment (review of 8348349, the same
 * copy): of two late payments of two in a row the second paid one day — Jun 11 paid, Jul 20 and Sep 20 each -$715.16,
 * and on Oct 23 October drew Oct 11 missed, the runway read "A further $3,877.56 came due earlier this month: $357.58
 * has not posted, …" and the page showed it overdue beside both named as covering more than one month — and a
 * schedule opening on a late payment of two paid the day BEFORE it: started Aug 11 by his date, Aug 20 -$715.16 paid
 * Jul 11, which no surface shows, and on Sep 25 the arrears owed Sep 11 $357.58 beside "Aug 20's -$715.16 covered
 * more than one month". Now a day the payment of two before it paid early is settled, so Sep 20 pays Oct 11; and a day
 * before the schedule opens (`DueDays.opensOn`) — before his date, whatever posted before it, or before detection's
 * anchor and every payment of it, as before the ledger's first statement — is no charge, so Aug 20 pays Sep 11: no
 * reader projects it, no payment was its. 🔴 At b6e11a76 a payment late for a day BEFORE his date, no charge either,
 * still paid his date early — the day behind its own read as settled for lying there too (review of b6e11a76; his
 * ledger copy 2026-10-29, the same premium): Jun 11 and Jul 11 paid, Sep 19 -$715.16, then he typed Oct 11 — October
 * drew Oct 11 "paid early by its payment of Sep 19, 2026", on Sep 25 Upcoming listed Nov 11 alone and October's
 * forecast left it out, and on Oct 29 nothing was owed. Now none catches up from a day before his date (⚖️ default
 * built, not asked, 2026-10-29 — `paidAheadFromTheDayBefore`): Oct 11 is still to come on Sep 25 and owed once read
 * past, as at 8348349 — and so with only Sep 11 missed (67b3b79 to b6e11a76 paid Oct 11 with Sep 19 there): his
 * date says Oct 11 is to come. ⚠️ The day behind its own is the only one a catch-up pays — a known gap:
 * with Aug 11 missed, Sep 11 paid and Oct 11 missed, Oct 20 still pays Nov 11 early (at 66daebd Nov 11 was still
 * coming). Reaching further back for an unpaid day reads a bill's whole past, where an unread statement or a payment
 * left over reads as a charge owed, and would keep a catch-up after ONE missed charge from paying the day it paid
 * ahead; settling the day behind reads back only along a run of late payments of two, each one's second day. The cost
 * read into his decision 76 above — one month owed either way, this note's words, not his — is a payment of one
 * charge's; a payment of two owes none, and his words are silent on it, as on (a)–(c). Latent: no bill of his has a
 * catch-up.
 *
 * ⚠️ …and a run settles only two due days apart — a known gap too (review of b6e11a76): of two ADJACENT late payments
 * of two, the later is asked first for its own late day (`nearerDaysPayment`, before `catchUpPayment`), the day the
 * earlier one's second charge would pay ahead, so that charge pays no day. Jun 11, then Jul 20 and Aug 20 each
 * -$715.16: Jul 11 is Jul 20's, Aug 11 and Sep 11 Aug 20's, and Oct 11 owed beside both named as covering more than
 * one month — five charges, four days; with Sep 20 a third, seven and five. Paying every one reads the run as one
 * allocation, each payment pushing the next a day further ahead, onto days still to come — not built, an owner's call
 * (2026-10-29): its error shows a paid day owed, the safe direction. Pinned in billing-carriers.test.ts and
 * nearer-due-day.test.ts.
 *
 * ⛔ Nothing is read back but that run: a day's payment lies between the days either side of it — a catch-up, between
 * the day either side and the one past it — and whether the day after is paid on time; and the day behind one a late
 * payment of two pays is settled by its own days, or by the late payment of two before it, two due days back a link
 * (`dayBehindIsSettled`). So no reader needs more than the postings back to the start of such a run — three due days
 * behind its window without one — and two ahead (`billPaymentsBySeries` reads every one).
 */
export function paymentFor<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  return nearerDaysPayment(payments, dueOn, dueDays) ?? catchUpPayment(payments, dueOn, dueDays);
}

/** The payment of a due day by its own days — on time, else early or late by the nearer day (`paymentFor`). */
function nearerDaysPayment<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  const onTime = onTimePayment(payments, dueOn);
  if (onTime !== undefined) return onTime;
  const before = dueDays.before(dueOn);
  if (before !== null) {
    // early: nearer this day than the one before — nothing paid this day on time (above); never one nearer the day
    // before, whether that day was paid on time or early (⚖️ defaults (a) and (b), built, not asked — above)
    const early = paymentDaysBetween(payments, before, dueOn).find((p) => liesNearerTheLater(p, before, dueOn));
    if (early !== undefined) return early;
  }
  const after = dueDays.after(dueOn);
  if (after === null) return undefined;
  // late: nearer this day than the next — or nearer the next, when another payment paid that one on time (⚖️ default
  // (c), built, not asked — above)
  const afterOnTime = onTimePayment(payments, after) !== undefined;
  return paymentDaysBetween(payments, dueOn, after).find((p) => afterOnTime || !liesNearerTheLater(p, dueOn, after));
}

/**
 * ⚖️ default built, not asked (2026-10-23): the payment of two charges that pays an unpaid due day from the day either
 * side of it (`paymentFor`) — the day before's, LATE there, once the day behind THAT one is settled
 * (`paidAheadFromTheDayBefore`), else it paid that one; or the day after's, whatever its timing there, this day being
 * a charge (`couldHaveCharged`) and the unpaid one behind it. Each read by its own days and the run of late payments
 * of two before them, so no payment pays a third. ⛔ …and never the day before's when that day lies before HIS date
 * (`liesBeforeHisDate`, 2026-10-29): no charge, so the payment catches nothing up and pays neither this day nor the one
 * behind — he typed Oct 11 after Sep 19's -$715.16, Jun 11 and Jul 11 paid, Aug 11 and Sep 11 missed: Oct 11 is owed.
 * 🔴 Unsaid here at fc4444b2: read as written, Sep 19 paid his Oct 11 once the day behind was settled, as at b6e11a76
 * it did (review of b6e11a76).
 */
function catchUpPayment<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  const ahead = paidAheadFromTheDayBefore(payments, dueOn, dueDays);
  if (ahead !== undefined) return ahead;
  const after = dueDays.after(dueOn);
  if (after === null || !couldHaveCharged(payments, dueOn, dueDays)) return undefined;
  // early, on time or late for the day after, it lies past this day's grace — inside it, it would have paid this day
  // on time — and this day is the one behind it: late there, it pays this day before any day still to come
  const paidAfter = nearerDaysPayment(payments, after, dueDays);
  return paidAfter?.coveredMore === true ? paidAfter : undefined;
}

/**
 * The payment of two LATE for the due day before `dueOn` that pays `dueOn` early, its second charge — once the day
 * behind its own is settled (`dayBehindIsSettled`). ⛔ Never one on time or early there: a payment ahead of its own
 * day is not read ahead (⚖️ default built, not asked, 2026-10-23 — `paymentFor`). ⛔ …and never one late for a day
 * before HIS date (`liesBeforeHisDate`): that day is no charge, so the payment has nothing of his to catch up, and its
 * second charge pays no day of his (⚖️ default built, not asked, 2026-10-29). 🔴 At b6e11a76 that day was asked as its
 * own, and the day behind it read as settled for lying before his date too, so a payment late for the day before his
 * date paid his date early (review of b6e11a76): Jun 11 and Jul 11 paid, Sep 19 -$715.16, then he typed Oct 11 — Oct
 * 11 drawn "paid early by its payment of Sep 19, 2026", and out of Upcoming and October's forecast on Sep 25.
 */
function paidAheadFromTheDayBefore<P extends Payment>(
  payments: readonly P[],
  dueOn: string,
  dueDays: DueDays,
): P | undefined {
  const before = dueDays.before(dueOn);
  if (before === null || liesBeforeHisDate(before, dueDays)) return undefined;
  // the day after the day before is this one — `stillToComeReader` asks no day after a day from today on
  const days = withDayAfter(dueDays, before, dueOn);
  const paidBefore = nearerDaysPayment(payments, before, days);
  if (paidBefore?.coveredMore !== true || !paysLate(paidBefore, before)) return undefined;
  return dayBehindIsSettled(payments, before, days) ? paidBefore : undefined;
}

/**
 * Whether the due day behind `day` is settled for the late payment of two that pays `day` — no charge
 * (`couldHaveCharged`), or paid by its own days or by the late payment of two before IT (`paidAheadFromTheDayBefore`),
 * each read with the day after it as the calendar steps them, though a reader that looks ahead asks no day after any
 * (`stillToComeReader`). ⛔ Never `paymentFor`: the catch-up from `day`'s side is the very payment asking, and would
 * pay a third day. 🔴 Its own days alone (8348349): a day the payment of two before it paid early read as unpaid.
 */
function dayBehindIsSettled(payments: readonly Payment[], day: string, dueDays: DueDays): boolean {
  const behind = dueDays.before(day);
  if (behind === null || !couldHaveCharged(payments, behind, dueDays)) return true;
  const days = withDayAfter(dueDays, behind, day);
  return (
    nearerDaysPayment(payments, behind, days) !== undefined ||
    paidAheadFromTheDayBefore(payments, behind, days) !== undefined
  );
}

/**
 * ⚖️ default built, not asked (2026-10-23): whether a due day is one the bill could have charged — on or after the
 * day its schedule opens (`DueDays.opensOn`); before his date, never — his date IS the schedule (`effectiveSchedule`),
 * whatever posted before it; before detection's anchor, once a payment of it has posted. Before them no reader
 * projects it and no payment was its: the days before his date, or before the ledger's first statement. So no payment
 * of two catches it up, and a late one there pays the day after instead (`paymentFor`). 🔴 At 8348349 one did:
 * started Aug 11 by his date, Aug 20 -$715.16 paid Jul 11, and Sep 11 was owed beside "Aug 20's -$715.16 covered more
 * than one month" — and so with Jun 11 paid before his date, the other month it covered drawn nowhere.
 */
function couldHaveCharged(payments: readonly Payment[], day: string, dueDays: DueDays): boolean {
  if (dueDays.opensOn !== null && compareDates(day, dueDays.opensOn) >= 0) return true;
  if (liesBeforeHisDate(day, dueDays)) return false;
  return payments.some((p) => compareDates(p.postedOn, day) <= 0);
}

/**
 * ⚖️ default built, not asked (2026-10-23): whether a due day lies before HIS date (`DueDays.opensOnHisDate`) — his date
 * IS the schedule (`effectiveSchedule`), whatever posted before it: no day before it is a charge (`couldHaveCharged`),
 * nor one a payment of two catches up from (`paidAheadFromTheDayBefore`, 2026-10-29). ONE test for both.
 */
function liesBeforeHisDate(day: string, dueDays: DueDays): boolean {
  return dueDays.opensOnHisDate && dueDays.opensOn !== null && compareDates(day, dueDays.opensOn) < 0;
}

/** `dueDays` with `next` the due day after `day` — the step a reader that asks no day after still takes here. */
function withDayAfter(dueDays: DueDays, day: string, next: string): DueDays {
  return { ...dueDays, after: (d) => (d === day ? next : dueDays.after(d)) };
}

/** Whether a payment posted more than its own tolerance AFTER a due day — late for it, were it its payment. */
function paysLate(payment: Payment, dueOn: string): boolean {
  return diffDays(dueOn, payment.postedOn) > payment.toleranceDays;
}

/** Whether a payment between two due days lies nearer the later — a tie is the earlier's (⚖️ decision 76). */
function liesNearerTheLater(payment: Payment, earlier: string, later: string): boolean {
  return diffDays(payment.postedOn, later) < diffDays(earlier, payment.postedOn);
}

/** Whether a payment of a due day is EARLY (`paymentFor`): more than its own tolerance before the day. */
export function paysEarly(payment: Payment, dueOn: string): boolean {
  return diffDays(payment.postedOn, dueOn) > payment.toleranceDays;
}

/** Whether a payment of a due day is ON TIME (`paymentFor`): within its own tolerance either side of the day. */
export function paysOnTime(payment: Payment, dueOn: string): boolean {
  return Math.abs(diffDays(payment.postedOn, dueOn)) <= payment.toleranceDays;
}

/** The payment within its own tolerance of a due day — the nearest, the earlier of two as near — or undefined. */
export function onTimePayment<P extends Payment>(payments: readonly P[], dueOn: string): P | undefined {
  let best: P | undefined;
  for (const p of payments) {
    if (!paysOnTime(p, dueOn)) continue;
    const gap = Math.abs(diffDays(p.postedOn, dueOn));
    const bestGap = best === undefined ? Infinity : Math.abs(diffDays(best.postedOn, dueOn));
    if (gap < bestGap || (gap === bestGap && compareDates(p.postedOn, best!.postedOn) < 0)) best = p;
  }
  return best;
}

/**
 * The payments past `from`'s tolerance and short of `to`'s — each by its own series' days — one a day, oldest first:
 * late for `from`, or early for `to`. ⚖️ Rows of one day are one payment (`occurrencesOf`); the first is named.
 */
function paymentDaysBetween<P extends Payment>(payments: readonly P[], from: string, to: string): P[] {
  const between = payments
    .filter((p) => diffDays(from, p.postedOn) > p.toleranceDays && diffDays(p.postedOn, to) > p.toleranceDays)
    .sort((a, b) => compareDates(a.postedOn, b.postedOn));
  return between.filter((p, i) => i === 0 || between[i - 1]!.postedOn !== p.postedOn);
}

/**
 * ⚖️ What PAYS each series billed inside another: its carrier's payments, each judged by the CARRIER's tolerance —
 * keyed by the carried series' id. Implied by his decision 59 (2026-10-08, recorded by the orchestrator): the
 * utilities' money is inside the rent's payment, so an occurrence of theirs is paid once the rent's payment for that
 * period has posted — the posting that pays the rent's own occurrence, by the rent's own test (`paymentFor`).
 *
 * 🔴 Without it the evidence followed the carrier (`lastSeenOn`) and the settlement did not: on a copy of his ledger
 * with the link set (2026-10-08) September drew Sep 1 "not yet known" beside the rent's Sep 2 $2,291.21 ($2,109.00 +
 * $182.21), and once the rent's account is read past a 1st the rent paid, the runway, the month forecast, /budgets,
 * the bill's page and the calendar's ✕ would all have said its $182.21 "came due and has not posted" — every month.
 *
 * ⚠️ "The same period" is the carried occurrence's own day: a series billed inside another falls due with it (his
 * utilities and his rent are both due on the 1st), so the carrier's occurrence of that period is the one on that day.
 *
 * ⛔ Amounts are not asked: the carrier's payment pays what is billed inside it whatever it adds up to — as a covering
 * posting pays the bill it covers (`overdueForSeries`). Its money is on the carrier's row, counted there, once.
 *
 * Every one of the carrier's postings, as its own are read (`billPaymentsBySeries`). Nothing is asked of a ledger with
 * no link.
 */
function carrierPaymentsBySeries(
  db: AppDatabase,
  rows: readonly { id: string; billedWith: BillingCarrier | null }[],
): ReadonlyMap<string, readonly BillPayment[]> {
  const carried = rows.filter((r): r is typeof r & { billedWith: BillingCarrier } => r.billedWith !== null);
  if (carried.length === 0) return new Map();
  const carrierIds = [...new Set(carried.map((r) => r.billedWith.id))];
  const tolerance = new Map(
    db
      .select({ id: recurringSeries.id, toleranceDays: recurringSeries.toleranceDays })
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, carrierIds))
      .all()
      .map((s) => [s.id, s.toleranceDays] as const),
  );
  const byCarrier = postingsBySeries(db, tolerance, true);
  return new Map(carried.map((r) => [r.id, byCarrier.get(r.billedWith.id) ?? []] as const));
}

/**
 * A payment of a bill (`billPaymentsBySeries`): whose it is — its carrier's (§6A 59), or the series' own — and whether
 * it covered more than one charge of the series that posted it, its carrier's for a carried one (`coveredMoreDays`):
 * a carrier's payment of two pays two days of what it carries, as two of its own (pinned in nearer-due-day.test.ts).
 * ⚠️ His rent cannot reach it — a known gap (review of b6e11a76): its payments carry the utilities, each above its
 * -$2,109.00 and none at it, so its average names none. On his ledger copy 2026-10-29 with -$4,582.42 added on Oct 20
 * (October's unposted), the rent's page names only what its payments carry, November draws Nov 1 paid early by Oct 20
 * for the rent and the utilities alike, and Oct 1 stays owed for both, $2,109.00 and $182.21 — drawn "?", Wells Fargo
 * read through Sep 24, inside the runway's "A further $3,519.98 came due earlier this month and no statement has
 * covered it yet." — a paid month shown owed, the safe direction. Set to what a month posts (-$2,291.21), it still
 * names none: Jun 16's -$2,434.80 lies above it.
 */
export interface BillPayment extends Payment {
  readonly carried: boolean;
  readonly coveredMore: boolean;
}

/** Every active posting of each series in `tolerance`, oldest first, each held to its series' tolerance. */
function postingsBySeries(
  db: AppDatabase,
  tolerance: ReadonlyMap<string, number>,
  carried: boolean,
): Map<string, BillPayment[]> {
  const rows = db
    .select({
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), inArray(transactions.recurringSeriesId, [...tolerance.keys()])))
    .orderBy(asc(transactions.postedOn), asc(transactions.id))
    .all();
  const coveredMore = coveredMoreDays(db, rows);
  const out = new Map<string, BillPayment[]>();
  for (const row of rows) {
    if (row.seriesId === null) continue;
    const payment = {
      postedOn: row.postedOn,
      toleranceDays: tolerance.get(row.seriesId) ?? 0,
      carried,
      coveredMore: coveredMore.get(row.seriesId)?.has(row.postedOn) ?? false,
    };
    out.set(row.seriesId, [...(out.get(row.seriesId) ?? []), payment]);
  }
  return out;
}

/**
 * ⚖️ default built, not asked (2026-10-23): per series, the days whose payment covered more than one charge — the
 * ones its posted average names (`paidAheadDays`, read as the average reads its rows: per occurrence, every active
 * row, each era at its own rate), so a grader pays a second day only with a payment the page says covered more than
 * one (`paymentFor`'s catch-up) — of the rate era in force now: an earlier era's, held to its own rate, the page names
 * nowhere, its average holding today's era alone (`atTodaysRate`; latent, only his pay has a rate history). Car
 * insurance's Sep 3 alone on his ledger copy 2026-10-23, and 2026-10-29. 🔴 Nothing pinned that a grader reads THIS,
 * not the bare multiple (review of 67b3b79): read as |amount| ≥ 2 × |rate|, every unit test passed, and a what-if FPL
 * on Venture X (the -$58.87 he set; Jul 10 -$14.21, Jul 28 -$56.22, Sep 28 -$125.00) drew Sep 8 paid by Sep 28 beside
 * an average naming nothing. nearer-due-day.test.ts pins Sep 8 owed, and these days as paidAhead's.
 */
function coveredMoreDays(
  db: AppDatabase,
  rows: readonly { seriesId: string | null; postedOn: string; amountCents: number }[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const bySeries = new Map<string, { postedOn: string; amountCents: number }[]>();
  for (const r of rows) {
    if (r.seriesId === null) continue;
    const list = bySeries.get(r.seriesId);
    if (list) list.push(r);
    else bySeries.set(r.seriesId, [r]);
  }
  if (bySeries.size === 0) return new Map();
  return new Map(
    db
      .select()
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, [...bySeries.keys()]))
      .all()
      .filter(readsPerOccurrence)
      .map((s) => {
        const days = paidAheadDays(occurrencesOf(bySeries.get(s.id) ?? []), effectiveSeries(s), s.kind);
        return [s.id, days] as const;
      }),
  );
}

/**
 * Every payment that may PAY each series' due days: its own postings, each judged by its own tolerance, and — billed
 * inside another — its carrier's, each by the carrier's (`carrierPaymentsBySeries`); each marked when it covered more
 * than one charge (`coveredMoreDays`, ⚖️ default built, not asked, 2026-10-23). Keyed by series id; read in one pass
 * for all of them.
 *
 * ⛔ What `paymentFor` is asked over by every grader that says a bill's day is paid or owed: the arrears
 * (`overdueForSeries`), every reader that looks ahead (`stillToComeReader`) and the calendar, which draws its own
 * postings and names a carrier's (`paidWith`, `BillPayment.carried`) — the same list, so the three cannot grade one
 * Oct 1 apart.
 *
 * ⛔ EVERY posting, never a window's: a day's payment may lie as far back as the due day before it (`paymentFor`, ⚖️ his
 * decision 76, 2026-10-14), and a late one asks whether the day after is paid on time (⚖️ default (c), built, not
 * asked) — a cycle either side of any window, for a catch-up's two ahead and back along a run of late payments of two
 * (`dayBehindIsSettled`); whether a day could have been charged is read off the first (`couldHaveCharged`); and
 * whether a payment covered more than one charge is read off all of its series' (`coveredMoreDays`). Each reader read
 * from its own window's start less the widest grace until then, and FPL's Aug 8, paid early by Jul 28, would read "not
 * posted" to a reader of August from Jul 29 beside a calendar of the year saying "paid".
 *
 * 🔴 The readers that look ahead never asked (review of 50020a2): with the rent paid Sep 30, the calendar drew its Oct
 * 1 paid while the forecast card, the Upcoming tab, the dashboard strip and the rent's page still listed it coming.
 */
export function billPaymentsBySeries(
  db: AppDatabase,
  rows: readonly { id: string; toleranceDays: number; billedWith: BillingCarrier | null }[],
): ReadonlyMap<string, readonly BillPayment[]> {
  if (rows.length === 0) return new Map();
  const own = postingsBySeries(db, new Map(rows.map((r) => [r.id, r.toleranceDays] as const)), false);
  const carried = carrierPaymentsBySeries(db, rows);
  return new Map(rows.map((r) => [r.id, [...(own.get(r.id) ?? []), ...(carried.get(r.id) ?? [])]] as const));
}
