import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import type { BillingCarrier } from "@/lib/billed-with";
import { addDays, compareDates, diffDays } from "@/lib/dates";
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
 * The payment that pays a due day — the nearest within its own tolerance of it, the earlier of two as near — or
 * undefined. ⛔ The one test of "did a posting cover this occurrence" for every grader of a bill: the arrears
 * (`overdueForSeries`) and the calendar (a posting of its own, or its carrier's), so the two cannot grade one Oct 1
 * apart — given the same postings: each grader reads its window widened by the tolerance either side.
 *
 * 🔴 The calendar read a bill's own postings inside the month alone (review of 1a1b753): with the rent paid Sep 30,
 * October drew its Oct 1 "missed" beside the utilities "paid with the rent's payment of Sep 30", and the arrears owed
 * neither.
 */
export function paymentFor<P extends Payment>(payments: readonly P[], dueOn: string): P | undefined {
  let best: P | undefined;
  for (const p of payments) {
    const gap = Math.abs(diffDays(p.postedOn, dueOn));
    if (gap > p.toleranceDays) continue;
    const bestGap = best === undefined ? Infinity : Math.abs(diffDays(best.postedOn, dueOn));
    if (gap < bestGap || (gap === bestGap && compareDates(p.postedOn, best!.postedOn) < 0)) best = p;
  }
  return best;
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
 * `[from, to]` is the window of due days asked about — `to` null for no end — and postings are read the carrier's
 * tolerance either side of it. Nothing is asked of a ledger with no link.
 */
export function carrierPaymentsBySeries(
  db: AppDatabase,
  rows: readonly { id: string; billedWith: BillingCarrier | null }[],
  from: string,
  to: string | null,
): ReadonlyMap<string, readonly Payment[]> {
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
  const widest = Math.max(0, ...tolerance.values());
  const byCarrier = new Map<string, Payment[]>();
  for (const row of db
    .select({ seriesId: transactions.recurringSeriesId, postedOn: transactions.postedOn })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        inArray(transactions.recurringSeriesId, carrierIds),
        gte(transactions.postedOn, addDays(from, -widest)),
        to === null ? undefined : lte(transactions.postedOn, addDays(to, widest)),
      ),
    )
    .all()) {
    if (row.seriesId === null) continue;
    const payment = { postedOn: row.postedOn, toleranceDays: tolerance.get(row.seriesId) ?? 0 };
    byCarrier.set(row.seriesId, [...(byCarrier.get(row.seriesId) ?? []), payment]);
  }
  return new Map(carried.map((r) => [r.id, byCarrier.get(r.billedWith.id) ?? []] as const));
}

/**
 * Every payment that may PAY each series' occurrences due inside `[from, to]` (`to` null for no end): its own postings,
 * each judged by its own tolerance, and — billed inside another — its carrier's, each by the carrier's
 * (`carrierPaymentsBySeries`). Keyed by series id; read in one pass for all of them. Postings are read the widest
 * tolerance either side of the window.
 *
 * ⛔ What `paymentFor` is asked over by every grader that says a bill's day is paid or owed: the arrears
 * (`overdueForSeries`) and every reader that looks ahead (`stillToComeReader`). The calendar reads the same two halves
 * apart — it draws its own postings and names a carrier's (`paidWith`) — over the same window rule, so the three cannot
 * grade one Oct 1 apart.
 *
 * 🔴 The readers that look ahead never asked (review of 50020a2): with the rent paid Sep 30, the calendar drew its Oct
 * 1 paid while the forecast card, the Upcoming tab, the dashboard strip and the rent's page still listed it coming.
 */
export function billPaymentsBySeries(
  db: AppDatabase,
  rows: readonly { id: string; toleranceDays: number; billedWith: BillingCarrier | null }[],
  from: string,
  to: string | null,
): ReadonlyMap<string, readonly Payment[]> {
  if (rows.length === 0) return new Map();
  const tolerance = new Map(rows.map((r) => [r.id, r.toleranceDays] as const));
  const widest = Math.max(0, ...tolerance.values());
  const own = new Map<string, Payment[]>();
  for (const row of db
    .select({ seriesId: transactions.recurringSeriesId, postedOn: transactions.postedOn })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        inArray(transactions.recurringSeriesId, [...tolerance.keys()]),
        gte(transactions.postedOn, addDays(from, -widest)),
        to === null ? undefined : lte(transactions.postedOn, addDays(to, widest)),
      ),
    )
    .all()) {
    if (row.seriesId === null) continue;
    const payment = { postedOn: row.postedOn, toleranceDays: tolerance.get(row.seriesId) ?? 0 };
    own.set(row.seriesId, [...(own.get(row.seriesId) ?? []), payment]);
  }
  const carried = carrierPaymentsBySeries(db, rows, from, to);
  return new Map(rows.map((r) => [r.id, [...(own.get(r.id) ?? []), ...(carried.get(r.id) ?? [])]] as const));
}
