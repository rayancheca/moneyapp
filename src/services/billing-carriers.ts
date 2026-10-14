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
 * (`dueDaysOf`): where a payment past one day's grace stops being late for it, and how far back one more than a day's
 * grace early may lie. Every grader of a bill's day passes the series' own, so each reads the same days.
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
 * ⚖️ …LATE, the earliest posted past a day's tolerance and before the next due day's own tolerance opens
 * (`DueDays.after`), when nothing pays the day on time or early. The grace is the days a payment has to post before
 * anything may say "not posted" (his decision 60, 2026-10-08); a payment that comes after them is still the payment of
 * that day. 🔴 It paid nothing (review of 44eb3e7): the rent paid Oct 5, four days past its Oct 1 and its 3 days, was
 * drawn beside a red ✕ on Oct 1, the runway said "A further $2,291.21 came due earlier this month and never posted.",
 * and /budgets counted it in what was spent AND in what came due — $4,599.86 projected for one month's rent. His July
 * rent posted Jul 8, and his own next date (Sep 1) holds the rent's walk, so an import never moves a late day off it.
 *
 * ⚖️ …EARLY, his decision 73 (2026-10-13, either/or, recommended): a payment that posts MORE than its grace days before
 * the day, after the day before it (`DueDays.before`) and its grace, when that day is already paid by ANOTHER payment
 * (`paidByThen`), PAYS THE DAY EARLY — the earliest such the day before did not take. Asked before late: a payment
 * comes before the days after it, so drafted every 28th each draft pays the next 8th, and the newest 8th is paid by the
 * newest draft. When the day before is unpaid, the late rule keeps that payment for it, as before. 🔴 Measured on his
 * ledger copy 2026-10-13: FPL (electricity), due the 8th with 3 days' grace, posted Jul 10 −$14.21 (Jul 8's, on time)
 * and Jul 28 −$56.22, 11 days before Aug 8 — and Jul 28 paid no due day. No surface asks his Aug 8 (his own next date,
 * Sep 8, opens FPL's walk), but with a draft around every 28th the next Chase statement would have read Sep 8 paid late
 * by Sep 28 and Oct 8 "not posted" — every statement's newest 8th, until the following one. Car insurance's $1,000.00
 * of Sep 3 pays its Sep 11 the same way (before his Dec 11, so asked by none either).
 *
 * ⛔ ONE PAYMENT PAYS ONE DUE DAY: on time it is in no other day's reach; early, the day before took the first of its
 * gap late only when nothing else paid it, and this day takes the next; late, it is in the next day's gap only, ahead
 * of what that day may take early. And rows of one day are ONE payment — his card posted Jun 16's rent as two
 * (`occurrencesOf`) — or the second half of one payment would pay the next month early.
 */
export function paymentFor<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  const onTime = onTimePayment(payments, dueOn);
  if (onTime !== undefined) return onTime;
  const before = dueDays.before(dueOn);
  if (before !== null) {
    // the day before took the first of these late, unless another payment had paid it by then
    const early = paymentDaysBetween(payments, before, dueOn)[paidByThen(payments, before, dueDays) ? 0 : 1];
    if (early !== undefined) return early;
  }
  const after = dueDays.after(dueOn);
  return after === null ? undefined : paymentDaysBetween(payments, dueOn, after)[0];
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
 * Whether `day` is paid ON TIME or EARLY — so that it takes no payment after its grace, late. Early when the day before
 * it was paid by then and one payment lies between them, or when two do (the day before takes the first late); so the
 * answer is read back through days with exactly one between, to a day that settles it.
 *
 * ⛔ It ends: every day read back has a payment of its own between it and the next, and no payment is between two
 * pairs of days — so at most one day per payment. The count bounds a schedule that would not step back.
 */
function paidByThen(payments: readonly Payment[], day: string, dueDays: DueDays): boolean {
  let d = day;
  for (let read = 0; read <= payments.length; read++) {
    if (onTimePayment(payments, d) !== undefined) return true;
    const before = dueDays.before(d);
    if (before === null) return false;
    const between = paymentDaysBetween(payments, before, d).length;
    if (between !== 1) return between > 1;
    d = before;
  }
  return false;
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
 * ⛔ EVERY posting, never a window's: a payment pays a day early only once the day before it is paid by another
 * (`paymentFor`, ⚖️ his decision 73, 2026-10-13), which is read back as far as the payments go. Each reader read from
 * its own window's start less the widest grace until then, and with a draft every 28th his FPL's Oct 8 is paid early
 * by Sep 28 only because Sep 8 was by Aug 28, Aug 8 by Jul 28 and Jul 8 by Jul 10 — a reader of October alone would
 * have said "not posted" beside a calendar of the year saying "paid".
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
