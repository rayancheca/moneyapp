import { spendingBucket, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { rowIsRecurring } from "./recurring-link";

/**
 * THE CAR'S UP-FRONT MONEY — one predicate, asked of one row, by every surface that has to know.
 *
 * The car card prints it as "Paid up front, spread over the lease": every posted row of HIS spending in the Car
 * subtree that no series drawn as recurring accounts for. A row attributed to a live or ENDED series is the bill,
 * paid — the card's "Lease and insurance" line prices it — while a row tagged to a DISMISSED series is money handed
 * over like any unlinked Car row (`rowIsRecurring` reads the status, not the link). The car card has always counted
 * exactly this set; it is extracted here so the second reader cannot draw a second boundary.
 *
 * ⚖️ Owner decision 2026-10-07 (§6A 48): the spending PACE leaves this money out, so it is not projected again as
 * monthly spending. 🔴 Measured on his ledger that day, `/recurring`'s "If you also spend at your recent pace" read
 * "Car  3-mo avg $2,033.33 + trend $0.00, × 25/31 days = −$1,639.78" — the $5,000 cash down payment (2026-08-11) and
 * the $1,100 Mercedes-Benz deposit (2026-08-12), ÷ 3, as though he hands a down payment over every month — beside a
 * card that already spreads the same $6,100 over the 24-month lease. Lease and insurance stay in, as the scheduled
 * bills they are; their rows were never pace (`linkIsNotRecurring`). Readers:
 *
 *   - `committed.ts::carCard` — the card's "Paid up front" total;
 *   - `forecast.ts::variableComponents` — the month forecast's pace (/recurring, the calendar, every month ahead);
 *   - `category-forecast.ts::nonRecurringSubtreeSpend` — /spending's predictions and /budgets' "Predict budgets".
 *
 * ⛔ HIS money only. A Car row on the AGENT'S cash is not his spending (`spendingBucket`, owner decisions 2026-10-02
 * and 2026-10-05), so the card never counted it as money he handed over, and the agent's own pace keeps it.
 *
 * ⚠️ Every one of his unlinked Car rows is up-front money by this definition — a repair filed under Car tomorrow
 * would be spread over the lease on the card AND left out of the pace. One rule: if that is ever wrong, it is wrong
 * in both places at once, and is fixed here.
 */
export interface UpfrontCarRule {
  /** the top-level Car category */
  readonly carId: string;
  /** Car and every category below it, resolved by the category index */
  readonly subtree: ReadonlySet<string>;
  readonly idx: CategoryIndex;
  /** `outsidePortfolioCashAccountIds` — the agent's cash, whose rows are none of his spending */
  readonly agentsCash: ReadonlySet<string>;
  /** `seriesIdsNotDrawnAsRecurring` — a row linked to one of these is not a bill */
  readonly notDrawn: ReadonlySet<string>;
}

/** The fields of a row (or one split part, carrying its parent's link and account) the predicate reads. */
export type UpfrontCarCandidate = Pick<AnalyticsTxn, "accountId" | "categoryId" | "amountCents" | "recurringSeriesId">;

/**
 * The rule for one ledger, or null when it has no car: no top-level category named "Car". A Car filed below another
 * category is not the car — the card's own resolution since pass 63 — and a ledger without one leaves every pace as
 * it was (`isUpfrontCarRow(null, …)` is false for every row).
 *
 * Pure: every caller already holds the reads, once.
 */
export function upfrontCarRule(
  idx: CategoryIndex,
  agentsCash: ReadonlySet<string>,
  notDrawn: ReadonlySet<string>,
): UpfrontCarRule | null {
  const car = [...idx.byId.values()].find((c) => c.parentId === null && c.name === "Car");
  if (!car) return null;
  return { carId: car.id, subtree: new Set(idx.subtreeIds(car.id)), idx, agentsCash, notDrawn };
}

/**
 * Whether a row is the car's up-front money: in the Car subtree, not a bill a drawn series accounts for, and his
 * spending. Either sign — the card nets a refund of the deposit against the deposit, so the pace leaves the refund
 * out with it. A split part is judged by its own category.
 */
export function isUpfrontCarRow(rule: UpfrontCarRule | null, row: UpfrontCarCandidate): boolean {
  if (rule === null || row.categoryId === null || !rule.subtree.has(row.categoryId)) return false;
  if (rowIsRecurring(row.recurringSeriesId, rule.notDrawn)) return false;
  return spendingBucket(rule.idx, rule.agentsCash, row) !== null;
}
