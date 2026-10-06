import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import type { CategoryIndex } from "./analytics";

/**
 * The category each recurring series is named by — the ONE answer to "what is this series' category" for every surface
 * that names one: a series page's chip (`seriesDetail`), the calendar's hue (`recurringCalendar`) and the band the
 * forecast nets an agent's schedule in (`agentsSeriesBands`). A series named by none is absent. `seriesIds` limits the
 * read to those series; left out, it reads every one.
 *
 * The owner's first (`user_category_id`), then the category most of its ACTIVE rows are filed in, the smaller id on a
 * tie so a tie reads one way everywhere. ⛔ A row not filed yet — NULL, or the system "Uncategorized" category, one set
 * (`CategoryIndex.isUncategorized`, owner decision 2026-09-03) — says nothing about the stream: one filed row outranks
 * any number of them. Only a series none of whose rows is filed is named "Uncategorized", where a row sits on it, as its
 * page has always said; one whose rows are all NULL is named by none.
 *
 * ⛔ Not membership. Which series a category's page, budget tail and forecast count (`recurringSeriesIdsForSubtree`) is
 * every category its rows sit in, so a split bill is never projected twice; this names ONE.
 *
 * 🔴 Three readers answered it three ways. The series page counted a row on the system "Uncategorized" category as a
 * vote and skipped a NULL one, the forecast skipped both, and the calendar counted both and broke a tie by the order
 * its scan met them. Measured at dbef9ae on a temp ledger: the agent's monthly +$5.00 schedule filed [Uncategorized,
 * Uncategorized, Fees > Bank Fees] read "Uncategorized" on its page — unfiled, which goes by its sign, into the agent's
 * income — while the forecast card netted the same $5.00 inside the agent's costs.
 */
export function seriesCategoryIds(
  db: AppDatabase,
  idx: CategoryIndex,
  seriesIds?: readonly string[],
): Map<string, string> {
  if (seriesIds !== undefined && seriesIds.length === 0) return new Map();
  const scoped = seriesIds === undefined ? undefined : inArray(transactions.recurringSeriesId, [...seriesIds]);

  // series → its best category so far: filed before unfiled, then the count, then the smaller id
  const best = new Map<string, { categoryId: string; filed: boolean; n: number }>();
  for (const r of db
    .select({ seriesId: transactions.recurringSeriesId, categoryId: transactions.categoryId, n: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNotNull(transactions.recurringSeriesId),
        isNotNull(transactions.categoryId),
        scoped,
      ),
    )
    .groupBy(transactions.recurringSeriesId, transactions.categoryId)
    .all()) {
    if (r.seriesId === null || r.categoryId === null) continue;
    const next = { categoryId: r.categoryId, filed: !idx.isUncategorized(r.categoryId), n: Number(r.n) };
    const held = best.get(r.seriesId);
    if (held === undefined || outranks(next, held)) best.set(r.seriesId, next);
  }

  const out = new Map([...best].map(([seriesId, b]) => [seriesId, b.categoryId] as const));
  // the owner's own answer wins over anything his rows say — an OVERRIDE, as `recurringSeriesIdsForSubtree` reads it
  for (const s of db
    .select({ id: recurringSeries.id, userCategoryId: recurringSeries.userCategoryId })
    .from(recurringSeries)
    .where(
      and(
        isNotNull(recurringSeries.userCategoryId),
        seriesIds === undefined ? undefined : inArray(recurringSeries.id, [...seriesIds]),
      ),
    )
    .all()) {
    if (s.userCategoryId !== null) out.set(s.id, s.userCategoryId);
  }
  return out;
}

/** The single comparison `seriesCategoryIds` ranks a series' categories by. */
function outranks(
  a: { readonly categoryId: string; readonly filed: boolean; readonly n: number },
  b: { readonly categoryId: string; readonly filed: boolean; readonly n: number },
): boolean {
  if (a.filed !== b.filed) return a.filed;
  if (a.n !== b.n) return a.n > b.n;
  return a.categoryId < b.categoryId;
}
