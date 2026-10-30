import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates } from "@/lib/dates";
import {
  unattachedMatchesAcross,
  type ExpectedDay,
  type SeriesAsk,
  type UnattachedMatch,
  type UnattachedRow,
} from "@/lib/unattached-match";
import { loadCategoryIndex, payDayRows, type CategoryIndex } from "./analytics";

/**
 * Per series, the rows that match the days a surface is about to call missed — paydays it would say passed "with no
 * deposit", "not banked yet" or "did not reach a bank" (every checked one no deposit paid in full), due days it would
 * say "has not posted" — to the cent, within the series' own tolerance, sitting unattached (`lib/unattached-match`, the
 * rule and its 🔴; the days asked, `asksForUnattachedMatch`). ⛔ ONE predicate, every caller: the arrears
 * (`arrearsInWindow`), the income mirror (`unbankedIncomeForSeries`), the pay readings (`cashEarningsReadings`) and the
 * recurring calendar (`recurringCalendar`, through `settledVerdict`) ask it here, and no surface matches a row of its own.
 *
 * A row is a candidate when it is ACTIVE, has NO series link and no transfer pairing (a transfer's leg is attached, to
 * its other leg), is dated on or before today (nothing after today has arrived), and sits on the series' account — or,
 * for a series with no account, on any account a row linked to it has ever been on (his Car lease names none, and its
 * payments posted from Wells Fargo). A series none of whose rows say where it posts has nowhere to look, and no match.
 *
 * ⚖️ …or, for a PAY series, a row ATTACHED to it that its settlement never reads: on a day no row of it is filed as his
 * pay (`payDayRows`) — an import's link files nothing — flagged `notFiledAsIncome`, and said as that. A bill's attached
 * row is a payment of it, whatever its filing, and a pay row on its pay day is a deposit settlement spends: neither is
 * ever a candidate. 🔴 Review of de31d22 (HIGH): the trial import of the Oct 26 statement into his pre-import copy
 * attached the four +$1,141.92 payroll rows unfiled, and every surface said the pay "did not reach a bank" again.
 * ⚖️ Default built, not asked (2026-10-29).
 *
 * ⛔ ONE ROW ANSWERS ONE DAY OF ONE SERIES: every asked series is matched at once (`unattachedMatchesAcross`) — and, for
 * a reader asked of some series only, beside its rivals (`UnattachedMatchOptions.rivals`), so no two surfaces give one
 * row to two bills. 🔴 Review of e6ad55a (MEDIUM): each series was matched on its own; two −$15.99 bills due Oct 10
 * both took the one −$15.99 row of Oct 10, and the runway named it twice over $31.98.
 */
export function unattachedMatchesBySeries(
  db: AppDatabase,
  wanted: ReadonlyMap<string, readonly ExpectedDay[]>,
  today: string,
  { rivals }: UnattachedMatchOptions = {},
): ReadonlyMap<string, readonly UnattachedMatch[]> {
  // read once, and only when a pay series is asked: the filing a pay day is read by (`payDayRows`)
  let idx: CategoryIndex | null = null;
  const categoryIndex = (): CategoryIndex => (idx ??= loadCategoryIndex(db));
  // ⛔ every asked series at once: one row answers one day of one series (`unattachedMatchesAcross`)
  const asked = seriesAsks(db, wanted, today, categoryIndex);
  const matched = unattachedMatchesAcross(asked);
  // nothing matched, nothing a rival could take; and a caller that asked every series has no rival to ask
  if (matched.size === 0 || rivals === undefined) return matched;
  // the asked series' own days stand: a rival is a series the caller did not ask of
  const rivalDays = new Map([...rivals()].filter(([id]) => !wanted.has(id)));
  const others = seriesAsks(db, rivalDays, today, categoryIndex).filter((a) => a.rows.length > 0);
  if (others.length === 0) return matched;
  const contested = unattachedMatchesAcross([...asked, ...others]);
  return new Map([...contested].filter(([id]) => wanted.has(id)));
}

export interface UnattachedMatchOptions {
  /**
   * Every OTHER series' days a surface of the same kind would call missed in the same window — the arrears' read due
   * days of every live bill (`arrearsInWindow`), the passed paydays of every live pay schedule
   * (`unbankedIncomeForSeries`) — asked only once one of the asked series has a match. A reader asked of SOME series
   * passes it, so a row goes where it would on the surface that asks of every series: a bill's own page and the runway
   * give it to the same bill. 🔴 Review of e6ad55a (MEDIUM): each bill's page, asking of itself alone, claimed the one
   * −$15.99 row of Oct 10 that two bills due that day could answer.
   */
  readonly rivals?: () => ReadonlyMap<string, readonly ExpectedDay[]>;
}

/** Each series' question (`SeriesAsk`): its days, and the rows on where it posts that could answer them. */
function seriesAsks(
  db: AppDatabase,
  wanted: ReadonlyMap<string, readonly ExpectedDay[]>,
  today: string,
  categoryIndex: () => CategoryIndex,
): SeriesAsk[] {
  const ids = [...wanted.entries()].filter(([, days]) => days.length > 0).map(([id]) => id);
  if (ids.length === 0) return [];
  const series = db
    .select({
      id: recurringSeries.id,
      kind: recurringSeries.kind,
      accountId: recurringSeries.accountId,
      toleranceDays: recurringSeries.toleranceDays,
    })
    .from(recurringSeries)
    .where(inArray(recurringSeries.id, ids))
    .all();
  const asks: SeriesAsk[] = [];
  for (const s of series) {
    const days = wanted.get(s.id) ?? [];
    const accountIds = s.accountId !== null ? [s.accountId] : accountsPaidFrom(db, s.id);
    if (accountIds.length === 0) continue;
    const isPay = s.kind === "income";
    const dates = days.map((d) => d.date).sort(compareDates);
    const lastDay = addDays(dates[dates.length - 1]!, s.toleranceDays);
    const rows = db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        seriesId: transactions.recurringSeriesId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, "active"),
          // its own attached rows only for a pay series — sifted to the ones its settlement never reads, below
          isPay
            ? or(isNull(transactions.recurringSeriesId), eq(transactions.recurringSeriesId, s.id))
            : isNull(transactions.recurringSeriesId),
          isNull(transactions.transferGroupId),
          inArray(transactions.accountId, accountIds),
          inArray(transactions.amountCents, [...new Set(days.map((d) => d.amountCents))]),
          gte(transactions.postedOn, addDays(dates[0]!, -s.toleranceDays)),
          lte(transactions.postedOn, compareDates(lastDay, today) < 0 ? lastDay : today),
        ),
      )
      .all();
    const attached = rows.filter((r) => r.seriesId !== null);
    const counted = attached.length === 0 ? new Set<string>() : payDayRowIds(db, categoryIndex(), s.id);
    const candidates: UnattachedRow[] = rows
      .filter((r) => r.seriesId === null || !counted.has(r.id))
      .map((r) => ({
        id: r.id,
        postedOn: r.postedOn,
        amountCents: r.amountCents,
        ...(r.seriesId === null ? {} : { notFiledAsIncome: true }),
      }));
    asks.push({ seriesId: s.id, days, rows: candidates, toleranceDays: s.toleranceDays });
  }
  return asks;
}

/** Every account an active row linked to the series has been on — where a series with no account of its own posts. */
function accountsPaidFrom(db: AppDatabase, seriesId: string): string[] {
  return db
    .selectDistinct({ accountId: transactions.accountId })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), eq(transactions.recurringSeriesId, seriesId)))
    .all()
    .map((r) => r.accountId);
}

/**
 * The ids of a pay series' rows its settlement reads — its pay days' (`payDayRows`, over every row linked to it, since
 * a day is a pay day by any of its rows). Every other row attached to it is counted as nothing.
 */
function payDayRowIds(db: AppDatabase, idx: CategoryIndex, seriesId: string): ReadonlySet<string> {
  const linked = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), eq(transactions.recurringSeriesId, seriesId)))
    .all();
  return new Set(payDayRows(idx, linked).map((r) => r.id));
}
