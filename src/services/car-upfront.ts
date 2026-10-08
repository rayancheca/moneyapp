import type { AppDatabase } from "@/db/client";
import { compareDates } from "@/lib/dates";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { loadCategoryIndex, spendingBucket, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { rowIsRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

/**
 * The day the lease starts — the first day of its term — and NOT a payment day. Money handed over before it is the
 * car's up-front money (⚖️ owner decision 2026-10-07, §6A 52: "before the lease starts (2026-09-11)").
 *
 * Why the 11th: it is the start he gave for the lease on 2026-08-11 ("from 2026-09-11"), and so the first of the 24
 * months the car card spreads the up-front money over (`CAR_LEASE_TERM_MONTHS`). The payment he named for that day was
 * superseded by the Mercedes-Benz statement — the lease bills $695.04 on the 15th, first due 2026-09-15 (paid early,
 * 2026-09-02) — and the 11th is the insurance's billing day ($357.58, first premium 2026-08-11, posted 08-12), not
 * the lease's. It falls after every row he handed over up front (the $5,000 cash on 08-11, the $1,100 deposit on 08-12).
 *
 * ⛔ A bill paid before it is still a bill: the 09-02 lease payment and the first premium are linked to their series,
 * and `isUpfrontCarRow` asks the link as well as the date.
 */
export const CAR_LEASE_STARTS_ON = "2026-09-11";

/** The term the car's up-front money buys: the lease, 2026-09-11 → 2028-08-11. */
export const CAR_LEASE_TERM_MONTHS = 24;

/**
 * THE CAR'S UP-FRONT MONEY — one predicate, asked of one row, by every surface that has to know.
 *
 * The car card prints it as "Paid up front, spread over the lease": a posted row of HIS spending in the Car subtree,
 * dated BEFORE the lease starts, that no series drawn as recurring accounts for. A row attributed to a live or ENDED
 * series is the bill, paid — the card's "Lease and insurance" line prices it — while a row tagged to a DISMISSED
 * series is money handed over like any unlinked Car row (`rowIsRecurring` reads the status, not the link).
 *
 * ⚖️ Owner decision 2026-10-07 (§6A 52): BEFORE THE LEASE STARTS, and only then (`CAR_LEASE_STARTS_ON`). A non-bill Car
 * row after it — a repair, a registration, EV charging, a dismissed "wash club" — is ordinary spending: in every pace
 * and budget, and never spread over the lease. 🔴 Until then every unlinked Car row was up-front money for good, so the
 * first repair would have been amortised over 24 months on the card and left out of every rate.
 *
 * ⚖️ Owner decisions 2026-10-07 (§6A 48, §6A 51): every spending RATE leaves this money out, so it is not projected
 * again as monthly spending. 🔴 Measured on his ledger that day: `/recurring`'s pace read "Car 3-mo avg $2,033.33 +
 * trend $0.00, × 25/31 days = −$1,639.78" — the $5,000 cash down payment (2026-08-11) and the $1,100 Mercedes-Benz
 * deposit (2026-08-12), ÷ 3; the runway's "What you spend a month" carried $1,016.67 a month of it (÷ 6); and the
 * dashboard's pace, replayed at 2026-08-20, projected August at $16,841.12. Lease and insurance stay in, as the
 * scheduled bills they are. Readers:
 *
 *   - `committed.ts::carCard` — "Paid up front" (counts it), and its spending-before-the-car (leaves it out);
 *   - `committed.ts::spendBaseline` — the runway's "What you spend a month";
 *   - `forecast.ts::variableComponents` — the month forecast's pace (/recurring, the calendar, every month ahead);
 *   - `category-forecast.ts::nonRecurringSubtreeSpend` — /spending's predictions and /budgets' "Predict budgets";
 *   - `spending.ts::cashFlowByPeriod` — the running period's pace: the dashboard tile and /spending's "projected";
 *   - `budgets.ts::budgetOneOffCents` — /budgets' run-rate; `budgets.ts::budgetGuidanceCents` — the editor's guide.
 *
 * A rate either leaves it out of its window or, measuring the running period, counts it once as spent and never
 * extrapolates it.
 *
 * ⛔ HIS money only. A Car row on the AGENT'S cash is not his spending (`spendingBucket`, owner decisions 2026-10-02
 * and 2026-10-05), so the card never counted it as money he handed over, and the agent's own pace keeps it.
 */
export interface UpfrontCarRule {
  /** the top-level Car category */
  readonly carId: string;
  /** Car and every category below it, resolved by the category index */
  readonly subtree: ReadonlySet<string>;
  /** `CAR_LEASE_STARTS_ON` — a row dated on or after it is not up front */
  readonly leaseStartsOn: string;
  readonly idx: CategoryIndex;
  /** `outsidePortfolioCashAccountIds` — the agent's cash, whose rows are none of his spending */
  readonly agentsCash: ReadonlySet<string>;
  /** `seriesIdsNotDrawnAsRecurring` — a row linked to one of these is not a bill */
  readonly notDrawn: ReadonlySet<string>;
}

/** The fields of a row (or one split part, carrying its parent's date, link and account) the predicate reads. */
export type UpfrontCarCandidate = Pick<
  AnalyticsTxn,
  "postedOn" | "accountId" | "categoryId" | "amountCents" | "recurringSeriesId"
>;

/**
 * The rule for one ledger, or null when it has no car: no top-level category named "Car". A Car filed below another
 * category is not the car — the card's own resolution since pass 63 — and a ledger without one leaves every rate as
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
  return {
    carId: car.id,
    subtree: new Set(idx.subtreeIds(car.id)),
    leaseStartsOn: CAR_LEASE_STARTS_ON,
    idx,
    agentsCash,
    notDrawn,
  };
}

/** `upfrontCarRule` over the ledger's own reads, for a caller that holds none of them. */
export function readUpfrontCarRule(db: AppDatabase): UpfrontCarRule | null {
  return upfrontCarRule(loadCategoryIndex(db), outsidePortfolioCashAccountIds(db), seriesIdsNotDrawnAsRecurring(db));
}

/**
 * Whether a row is the car's up-front money: in the Car subtree, dated before the lease starts, not a bill a drawn
 * series accounts for, and his spending. Either sign — the card nets a refund of the deposit against the deposit, so
 * a rate leaves the refund out with it. A split part is judged by its own category.
 */
export function isUpfrontCarRow(rule: UpfrontCarRule | null, row: UpfrontCarCandidate): boolean {
  if (rule === null || row.categoryId === null || !rule.subtree.has(row.categoryId)) return false;
  if (compareDates(row.postedOn, rule.leaseStartsOn) >= 0) return false;
  if (rowIsRecurring(row.recurringSeriesId, rule.notDrawn)) return false;
  return spendingBucket(rule.idx, rule.agentsCash, row) !== null;
}
