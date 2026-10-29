import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates } from "@/lib/dates";
import { unattachedMatches, type ExpectedDay, type UnattachedMatch } from "@/lib/unattached-match";

/**
 * Per series, the rows that match the days a surface is about to call missed — paydays it would say "did not reach a
 * bank", due days it would say "has not posted" — to the cent, within the series' own tolerance, sitting unattached
 * (`lib/unattached-match`, the rule and its 🔴). ⛔ ONE predicate, every caller: the arrears (`arrearsInWindow`), the
 * income mirror (`unbankedIncomeForSeries`) and the pay readings (`cashEarningsReadings`) ask it here, and no surface
 * matches a row of its own.
 *
 * A row is a candidate when it is ACTIVE, has NO series link and no transfer pairing (a transfer's leg is attached, to
 * its other leg), is dated on or before today (nothing after today has arrived), and sits on the series' account — or,
 * for a series with no account, on any account a row linked to it has ever been on (his Car lease names none, and its
 * payments posted from Wells Fargo). A series none of whose rows say where it posts has nowhere to look, and no match.
 */
export function unattachedMatchesBySeries(
  db: AppDatabase,
  wanted: ReadonlyMap<string, readonly ExpectedDay[]>,
  today: string,
): ReadonlyMap<string, readonly UnattachedMatch[]> {
  const out = new Map<string, readonly UnattachedMatch[]>();
  const ids = [...wanted.entries()].filter(([, days]) => days.length > 0).map(([id]) => id);
  if (ids.length === 0) return out;
  const series = db
    .select({ id: recurringSeries.id, accountId: recurringSeries.accountId, toleranceDays: recurringSeries.toleranceDays })
    .from(recurringSeries)
    .where(inArray(recurringSeries.id, ids))
    .all();
  for (const s of series) {
    const days = wanted.get(s.id) ?? [];
    const accountIds = s.accountId !== null ? [s.accountId] : accountsPaidFrom(db, s.id);
    if (accountIds.length === 0) continue;
    const dates = days.map((d) => d.date).sort(compareDates);
    const lastDay = addDays(dates[dates.length - 1]!, s.toleranceDays);
    const rows = db
      .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, "active"),
          isNull(transactions.recurringSeriesId),
          isNull(transactions.transferGroupId),
          inArray(transactions.accountId, accountIds),
          inArray(transactions.amountCents, [...new Set(days.map((d) => d.amountCents))]),
          gte(transactions.postedOn, addDays(dates[0]!, -s.toleranceDays)),
          lte(transactions.postedOn, compareDates(lastDay, today) < 0 ? lastDay : today),
        ),
      )
      .all();
    const matches = unattachedMatches(days, rows, s.toleranceDays);
    if (matches.length > 0) out.set(s.id, matches);
  }
  return out;
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
