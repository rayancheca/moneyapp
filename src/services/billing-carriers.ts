import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import type { BillingCarrier } from "@/lib/billed-with";
import { compareDates, diffDays } from "@/lib/dates";
import { resolveMergeTarget } from "./recurring";

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
 * ⚖️ …else EARLY or LATE by THE NEARER DUE DAY, his decision 76 (2026-10-14, his answer, refines 73): a payment between
 * two due days — past the earlier's tolerance and short of the later's (`DueDays.before`, `DueDays.after`) — pays the
 * one it lies NEARER, a tie the earlier (`liesNearerTheLater`). One nearer the later day pays it EARLY only when
 * nothing paid that day on time; otherwise it is the earlier day's, LATE — or pays nothing, if that day is already
 * paid. One nearer the earlier day is that day's, LATE — or pays nothing, once that day is paid: never the later day
 * early. The redirect runs ONE WAY. Of several for one day, the earliest, asked early before late. The grace is the
 * days a payment has to post before anything may say "not posted" (his decision 60, 2026-10-08); a payment past them
 * is still a day's. The cost he accepted: one nearer the next day pays it even when the day before is unpaid — FPL
 * paid only Jul 28 owes Jul 8 where it owed Aug 8, one month owed either way.
 *
 * What a payment LEFT OVER pays — one nearer a day another payment already pays — his answer does not say. The option
 * he chose for 76 reads, word for word: "A payment between two due days pays the one it's nearer to (a tie goes to the
 * earlier one), unless the nearer one is already paid on time." It stops there: silent on what that payment pays then,
 * and on a nearer day paid EARLY. Its examples were Sep 2 → Sep 15, an Oct 1 payment → Oct 15, FPL's 28th drafts →
 * the next 8th and Car insurance's Sep 3 → Sep 11, none of them left over. As built it pays NOTHING, both ways:
 * (a) ⚖️ default built, not asked (2026-10-21) — the nearer day paid ON TIME by another: it pays nothing. A lease paid
 *     on time Oct 15, then $695.04 more Oct 22, still has Nov 15 coming on Oct 23, in November's forecast at −$695.04
 *     — counted again — and "has not posted" once read past it, drawn missed. 🔴 This takes back decision 73 for that
 *     shape: run against 7aca8e5's paymentFor, Oct 22 paid Nov 15 early. What it keeps: a rent split Oct 1 −$2,000.00
 *     + Oct 9 −$291.21 keeps Nov 1 coming, with November's −$2,109.00 rent and −$182.21 utilities (73 paid it early
 *     with the $291.21 — its 🔴, below), and FPL's Jul 12 (Jul 8 paid Jul 10) pays no Aug 8. Paying the other day
 *     early instead would read the split's $291.21 as November paid and silently drop Nov 1's $2,291.21 from
 *     Upcoming and the forecast; this default's error shows on screen instead, and lasts one month.
 * (b) ⚖️ default built, not asked (2026-10-21) — the nearer day paid EARLY by another: it pays nothing too. A lease
 *     paid Sep 2 (Sep 15's, early) then Sep 30 — the 15/15 tie, Sep 15's — owes Oct 15 $695.04, as 73 did; after Sep
 *     2 + Oct 1, Oct 30 leaves Nov 15 coming where Oct 31 pays it. For a bill due the 15th, a pay on the 30th, a Feb
 *     28 or a Mar 1 outside a leap year lands this way; one on the 31st or the 1st does not. Paying the other day here
 *     would run on: after the known gap's stray half (Jun 17 paying Jul 1 early, below) the late rents Jul 8, Aug 5,
 *     Sep 6, Oct 7 would each pay the month AFTER their own, and Nov 1 leave Upcoming with Oct 7.
 * He said no more questions (2026-10-21), so neither was asked. Each pin names its default (nearer-due-day.test.ts,
 * billing-carriers.test.ts). Measured on what-if copies of his ledger 2026-10-21, with that day's four statements
 * read: the split, the Oct 22 prepay, Sep 30, and Oct 30 against Oct 31 each read as above. Sep 30's Oct 15 is all
 * unread there, because Wells Fargo is read through Sep 24. On the ledger itself no live bill's posting is left over
 * (9 with postings of their own) and no day moves: the lease has posted once, Sep 2 −$695.04.
 *
 * 🔴 Late paid nothing (review of 44eb3e7): the rent paid Oct 5, four days past its Oct 1 and its 3 days, was drawn
 * beside a red ✕ on Oct 1, the runway said "A further $2,291.21 came due earlier this month and never posted.", and
 * /budgets counted it in what was spent AND in what came due — $4,599.86 projected for one month's rent. His July rent
 * posted Jul 8, nearer Jul 1 than Aug 1. 🔴 Early paid nothing (until his decision 73, 2026-10-13): FPL, due the 8th
 * with 3 days' grace, posted Jul 10 −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8 — and with a
 * draft around every 28th, every statement's newest 8th would have read "not posted" until the following one.
 *
 * 🔴 Decision 73 paid a day early only once the day before was paid by ANOTHER payment (review of 844e484, measured on
 * his ledger copy 2026-10-13): the Car lease's Sep 2 −$695.04, 13 days before Sep 15, read as Aug 15's late payment
 * and left Sep 15 unpaid — a web pay around every 1st would read as the month before's, and every newest 15th "not
 * posted" once Wells Fargo is read past it; and a rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 paid Nov 1 early with
 * October's second half, so Nov 1 left Upcoming and the November forecast. Nearer, Sep 2 pays Sep 15, an Oct 1 web pay
 * Oct 15, Oct 9 nothing (Oct 1 is paid on time) — and FPL's draft on every 28th still pays each next 8th, Car
 * insurance's $1,000.00 of Sep 3 its Sep 11. His lease is anchored on Oct 15 (his date): no surface asks its Aug 15.
 *
 * ⛔ ONE PAYMENT PAYS ONE DUE DAY: on time it is in no gap; between two days it is asked for by one of them only — the
 * later early, or the earlier late — and a day takes one. Rows of one day are ONE payment: his card posted Jun 16's
 * rent as two (`occurrencesOf`). ⚠️ Two halves a day apart are two payments — Jun 16 + Jun 17 pay Jun 1 (the tie) and
 * Jul 1 (nearer it): a known gap neither 73 nor 76 catches.
 *
 * ⛔ Nothing is read back: a day's payment lies between the days either side of it, and whether the next is paid on
 * time — so no reader needs more than the postings one due day either side of its window (`billPaymentsBySeries`).
 */
export function paymentFor<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
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
  // late: nearer this day than the next — or nearer the next, when another payment paid that one on time
  const afterOnTime = onTimePayment(payments, after) !== undefined;
  return paymentDaysBetween(payments, dueOn, after).find((p) => afterOnTime || !liesNearerTheLater(p, dueOn, after));
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

/** A payment of a bill (`billPaymentsBySeries`): whose it is — its carrier's (§6A 59), or the series' own. */
export interface BillPayment extends Payment {
  readonly carried: boolean;
}

/** Every active posting of each series in `tolerance`, oldest first, each held to its series' tolerance. */
function postingsBySeries(
  db: AppDatabase,
  tolerance: ReadonlyMap<string, number>,
  carried: boolean,
): Map<string, BillPayment[]> {
  const out = new Map<string, BillPayment[]>();
  for (const row of db
    .select({ seriesId: transactions.recurringSeriesId, postedOn: transactions.postedOn })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), inArray(transactions.recurringSeriesId, [...tolerance.keys()])))
    .orderBy(asc(transactions.postedOn), asc(transactions.id))
    .all()) {
    if (row.seriesId === null) continue;
    const payment = { postedOn: row.postedOn, toleranceDays: tolerance.get(row.seriesId) ?? 0, carried };
    out.set(row.seriesId, [...(out.get(row.seriesId) ?? []), payment]);
  }
  return out;
}

/**
 * Every payment that may PAY each series' due days: its own postings, each judged by its own tolerance, and — billed
 * inside another — its carrier's, each by the carrier's (`carrierPaymentsBySeries`). Keyed by series id; read in one
 * pass for all of them.
 *
 * ⛔ What `paymentFor` is asked over by every grader that says a bill's day is paid or owed: the arrears
 * (`overdueForSeries`), every reader that looks ahead (`stillToComeReader`) and the calendar, which draws its own
 * postings and names a carrier's (`paidWith`, `BillPayment.carried`) — the same list, so the three cannot grade one
 * Oct 1 apart.
 *
 * ⛔ EVERY posting, never a window's: a day's payment may lie as far back as the due day before it, and a late one asks
 * whether the day after is paid on time (`paymentFor`, ⚖️ his decision 76, 2026-10-14) — a cycle either side of any
 * window. Each reader read from its own window's start less the widest grace until then, and FPL's Aug 8, paid early
 * by Jul 28, would read "not posted" to a reader of August from Jul 29 beside a calendar of the year saying "paid".
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
