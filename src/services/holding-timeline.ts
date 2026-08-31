import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { holdingEvents } from "@/db/schema/holding-events";
import type { HoldingEventKind } from "@/db/schema/holding-events";
import type { AssetType } from "@/db/schema/holdings";
import { splitAdjustedDeltas } from "@/lib/split-adjust";

/**
 * The quantity timeline, restated in today's shares — the ONE place that reads
 * `holding_events` for valuation.
 *
 * ⛔ It exists because FOUR call sites had the same defect, and fixing them one
 * at a time would have been four chances to disagree. Every one of them
 * multiplies a stored quantity by a cached close, and the closes are
 * split-ADJUSTED while the quantities are as-TRADED:
 *
 *   `rebuildInvestmentHistory`  the daily NAV — a tenth of the truth for the 60
 *                               trading days before COKE's 2025-05-27 10-for-1
 *   `flowsByDay`                money in — a phantom $1,017.85 "contribution"
 *                               on a day nothing was bought
 *   `realizedTradesByLeg`       realized P&L — the same $1,017.85 entering the
 *                               cost walk as a purchase of 9.013095 shares
 *   `holdingDeltasBetween`      the P&L calendar's per-holding day breakdown
 *
 * `lib/split-adjust.ts` carries the measurements and the arithmetic; this module
 * is only the loader, the grouping, and the order.
 *
 * ⚠️ ORDER IS PART OF THE ANSWER, not a presentation detail. A split's ratio is
 * `(Q + delta) / Q` for the Q standing when it happened, so which events precede
 * it decides which get scaled — and same-day order counts: the owner bought $10
 * of COKE on 2025-05-27 before the split landed that afternoon. `occurredOn`,
 * then `createdAt`, then `id`, which is the order `realizedTradesByLeg` already
 * used and the one the importer writes in.
 *
 * ⚠️ Grouped by (account, assetType, symbol). A split restates ONE security in
 * ONE account; symbol alone would let a ticker and a same-named coin share a
 * factor, which is the collision `rebuildInvestmentHistory` already guards
 * against when it resolves closes.
 */
export interface AdjustedHoldingEvent {
  id: string;
  accountId: string;
  symbol: string;
  assetType: AssetType;
  occurredOn: string;
  /** ADJUSTED to today's shares — zero for a split, which moves no shares in */
  quantityDeltaE8: number;
  /** exactly as stored, for callers that need the traded figure */
  rawQuantityDeltaE8: number;
  eventKind: HoldingEventKind;
  /** the product of every split still ahead of this event; 1 when there is none */
  splitFactor: number;
}

/** Every quantity event, split-adjusted; scoped to one account when asked. */
export function adjustedHoldingEvents(
  db: AppDatabase,
  accountId?: string,
): AdjustedHoldingEvent[] {
  const base = db
    .select({
      id: holdingEvents.id,
      accountId: holdingEvents.accountId,
      symbol: holdingEvents.symbol,
      assetType: holdingEvents.assetType,
      occurredOn: holdingEvents.occurredOn,
      quantityDeltaE8: holdingEvents.quantityDeltaE8,
      eventKind: holdingEvents.eventKind,
    })
    .from(holdingEvents);
  const rows = (accountId === undefined ? base : base.where(eq(holdingEvents.accountId, accountId)))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt), asc(holdingEvents.id))
    .all();

  const byLeg = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.accountId}|${r.assetType}|${r.symbol}`;
    const list = byLeg.get(key) ?? [];
    list.push(r);
    byLeg.set(key, list);
  }

  const adjustedById = new Map<string, { quantityDeltaE8: number; splitFactor: number }>();
  for (const [, list] of byLeg) {
    const adjusted = splitAdjustedDeltas(
      list.map((r) => ({ deltaE8: r.quantityDeltaE8, isSplit: r.eventKind === "split" })),
    );
    for (const [i, r] of list.entries()) {
      adjustedById.set(r.id, {
        quantityDeltaE8: adjusted[i]!.adjustedDeltaE8,
        splitFactor: adjusted[i]!.splitFactor,
      });
    }
  }

  // the global order is rebuilt from `rows`, so grouping never reorders output
  return rows.map((r) => {
    const a = adjustedById.get(r.id)!;
    return {
      ...r,
      quantityDeltaE8: a.quantityDeltaE8,
      rawQuantityDeltaE8: r.quantityDeltaE8,
      splitFactor: a.splitFactor,
    };
  });
}
