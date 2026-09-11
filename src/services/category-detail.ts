import { eq } from "drizzle-orm";
import { seriesRowLabel, type SeriesEvidence } from "@/lib/series-evidence";
import type { AppDatabase } from "@/db/client";
import { categories, type CategoryKind } from "@/db/schema/categories";
import { addDays, compareDates, monthKey, periodBounds } from "@/lib/dates";
import {
  categorySpending,
  spendingTransactions,
  hrefCategoryId,
  ledgerHref,
  loadCategoryIndex,
  monthKeysBack,
  recurringSeriesIdsForCategory,
  type DateRange,
} from "./analytics";
import { budgetStatuses } from "./budgets";
import { overdueForSeries } from "./arrears";
import { listSeries } from "./recurring";

/**
 * Category-page aggregates (ux-overhaul-plan §5.4) for `/categories/[id]`. The
 * page closes the linking chain: monthly trend, ranked merchants (via
 * spending.topMerchants scoped to the subtree), subcategory split, the budget
 * reference, and the recurring series whose linked transactions live in this
 * category — the bridge back to Stage 2. No schema change.
 */

export interface CategoryHeader {
  id: string;
  name: string;
  kind: CategoryKind;
  hue: string | null;
  icon: string | null;
  parentId: string | null;
  parentName: string | null;
  isSubcategory: boolean;
}

export function categoryDetailHeader(db: AppDatabase, categoryId: string): CategoryHeader {
  const row = db
    .select({ id: categories.id, name: categories.name, kind: categories.kind, color: categories.color, icon: categories.icon, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .get();
  if (!row) throw new Error("Unknown category");
  const parent = row.parentId
    ? db.select({ name: categories.name }).from(categories).where(eq(categories.id, row.parentId)).get()
    : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hue: row.color,
    icon: row.icon,
    parentId: row.parentId,
    parentName: parent?.name ?? null,
    isSubcategory: row.parentId !== null,
  };
}

// ── Monthly trend ────────────────────────────────────────────────────

export interface CategoryMonthPoint {
  month: string;
  spentCents: number;
  txnCount: number;
  href: string;
  /**
   * The ledger has walked into this month. False means nobody has looked, and
   * its zero is not a measurement — see `categoryMonthlyTrend`.
   */
  reached: boolean;
}

/**
 * Subtree spend per month over the trailing window; click a month → its txns.
 *
 * 🔴 A month the import has not reached came back `spentCents: 0, txnCount: 0`
 * and the bar read it out as a measurement: "Sep 2026: $0.00, 0 transactions",
 * on all 76 category pages, three cards above the page's own "September 2026
 * has not been imported yet. Nothing has been imported for 10 days of it …
 * That is a window nobody has looked at, not one in which nothing happened."
 * Measured 2026-09-10.
 *
 * ⛔ `ledgerReaches` says this in its own docstring — "days after this are days
 * nobody has looked at, not days on which nothing happened. A surface that
 * averages, projects or grades across them is publishing a lower bound as a
 * measurement" — and `/categories/[id]` already imports it for the empty state
 * two cards below. It just never reached the trend. REQUIRED rather than
 * defaulted: a caller that forgets would silently get the old assertion back.
 */
export function categoryMonthlyTrend(
  db: AppDatabase,
  categoryId: string,
  months: number,
  refDate: string,
  /** `ledgerReaches(db)` — the newest day the import has walked to, null when empty */
  reachesThrough: string | null,
): CategoryMonthPoint[] {
  // the system "Uncategorized" row is the bucket, and a link carrying its raw
  // id would filter by that id alone — see `hrefCategoryId`
  const linkCategory = hrefCategoryId(db, categoryId);
  return monthKeysBack(refDate, months).map((month) => {
    const from = `${month}-01`;
    const to = periodBounds(from, "monthly").end;
    const { spentCents, txnCount } = categorySpending(db, { categoryId, from, to });
    return {
      month,
      spentCents,
      txnCount,
      href: ledgerHref({ category: linkCategory, from, to }),
      // reached the month at all — its first day, not its last: a month the
      // ledger stops inside HAS been looked at, and its figure is a real
      // (if partial) measurement the page's coverage notes already qualify
      reached: reachesThrough !== null && compareDates(reachesThrough, from) >= 0,
    };
  });
}

/**
 * Which FRAME a category's figures are printed in: `+1` money-out (a bigger
 * number means more money gone), `-1` money-in (a bigger number means more
 * money arrived). Only an EXPENSE category is printed money-out — the reason is
 * spelled out over `sign` in `/categories/[id]`.
 *
 * 🔴 There were TWO copies of this and they disagreed. The page said
 * `isExpense ? 1 : -1`; the subcategory split said `kind === "income"` and left
 * transfer / investment / rewards in the money-out frame — so on those three
 * pages the rows were ranked and signed against the headline directly above
 * them, and `Math.abs` on the way out hid it. Measured 2026-09-11 on the real
 * ledger, `/categories/<Investments>?period=2026-07`: header
 * "Net · July 2026  -$3,090.00", its one row "Buys  $3,090.00", and that
 * child's own page "-$3,090.00" — the same 66 transactions printed with
 * opposite signs one click apart. All time the card read "Buys $109,251.85"
 * above "Sells $89,325.72", which as printed sum to $198,577.57 under a
 * headline of -$19,926.13.
 *
 * ⛔ The rows of the Subcategories card must SUM to the header over them, and
 * that is true in one frame only. Asked by the header and by the split, so the
 * two cannot drift again.
 */
export function categoryFlowSign(kind: CategoryKind): 1 | -1 {
  return kind === "expense" ? 1 : -1;
}

// ── Subcategory split ────────────────────────────────────────────────

export interface CategorySubRow {
  categoryId: string;
  name: string;
  /** the flow in the SAME frame as the page header — see `categoryFlowSign` */
  flowCents: number;
  txnCount: number;
  /**
   * The drill-down, or null when there is no filter that lists exactly these
   * rows — `/transactions?category=` takes the whole SUBTREE, so the parent's
   * own rows cannot be linked without over-listing. See `ownRow`.
   */
  href: string | null;
}

/**
 * Direct children of a top-level category, by flow (empty for a subcategory) —
 * PLUS the parent's own rows when it holds any.
 *
 * 🔴 The card listed children only, under a headline that counts the whole
 * subtree, so a category's own rows appeared nowhere and the rows did not sum
 * to the figure above them. Measured 2026-09-10, `/categories/<Travel>` for
 * July: Flights $531.79 + $1,843.10 + $20.00 = $2,394.89, plus two rows filed
 * directly on Travel (EMPOWER* KAMO GADELIA $38.99, SUPER+ * SUPERPLU $15.00)
 * = $53.99. The headline reads $2,448.88 — the sum — and the $53.99 was in no
 * row on the page.
 *
 * ⛔ The own row carries NO href. `ledgerHref({category})` filters by subtree,
 * so a link on it would list every child's rows too — which is the drill-down
 * contract broken rather than kept.
 */
export function categorySubcategorySplit(
  db: AppDatabase,
  categoryId: string,
  range: DateRange,
): CategorySubRow[] {
  const idx = loadCategoryIndex(db);
  const node = idx.byId.get(categoryId);
  if (!node) throw new Error("Unknown category");
  const children = [...idx.byId.values()].filter((c) => c.parentId === categoryId);
  if (children.length === 0) return [];

  const sign = categoryFlowSign(node.kind);
  // rows filed on the parent ITSELF — the same row list every other figure on
  // this page is built from, filtered to the exact category
  const ownRows = spendingTransactions(db, { categoryId, from: range.from, to: range.to }).filter(
    (t) => t.categoryId === categoryId,
  );
  const ownSpent = ownRows.reduce((sum, t) => sum - t.amountCents, 0);
  const ownRow: CategorySubRow[] =
    ownRows.length === 0
      ? []
      : [
          {
            categoryId,
            name: `On ${node.name} itself`,
            flowCents: sign * ownSpent,
            txnCount: new Set(ownRows.map((t) => t.id)).size,
            href: null,
          },
        ];
  return ownRow.concat(children
    .map((child) => {
      const { spentCents, txnCount } = categorySpending(db, { categoryId: child.id, from: range.from, to: range.to });
      // categorySpending returns -sum(amount); `categoryFlowSign` puts the row in
      // the same frame as the header it has to add up to
      const flowCents = sign * spentCents;
      return {
        categoryId: child.id,
        name: child.name,
        flowCents,
        txnCount,
        href: ledgerHref({ category: child.id, from: range.from, to: range.to }),
      };
    })
      .filter((r) => r.txnCount > 0))
    .sort((a, b) => b.flowCents - a.flowCents || a.name.localeCompare(b.name));
}

// ── Recurring series in this category (closes the Stage-2 chain) ──────

export interface CategorySeriesRow {
  id: string;
  name: string;
  cadence: string;
  amountCents: number;
  nextExpectedOn: string | null;
  /**
   * A charge this series owed inside the CALENDAR MONTH that no posting covers
   * — the backward half of `nextExpectedOn`, which walks forward by
   * construction and so can never see it.
   *
   * 🔴 `/categories/<Housing>` on 2026-09-08 read "Budget · grading Sep 1 –
   * Sep 30 · $0.00 of $2,291.21 · $2,291.21 left" and, below it, "Flamingo
   * South Beach (rent) monthly · next Oct 1 · $2,109.00" and "Rent utilities &
   * fees monthly · next Oct 1 · $182.21" — a September with nothing due and the
   * whole budget unspent. Both bills came due on Sep 1 and neither posted:
   * $2,291.21, the budget to the cent. `/budgets` says it in words on the page
   * this card links to — "That money is committed, so the room left is smaller
   * than it looks" — and `/recurring`'s Next column has printed it since the
   * same defect was fixed there on 2026-09-04.
   *
   * ⛔ Same call every other surface makes: `overdueForSeries` over the calendar
   * month, closing the day BEFORE today, so a bill due today is due rather than
   * late. Arrears are scoped to the calendar month by the owner's decision of
   * 2026-09-02.
   */
  overdue: { date: string; occurrenceCount: number } | null;
  status: string;
  isActive: boolean;
  /** the word every surface uses for its evidence — see `lib/series-evidence` */
  evidence: SeriesEvidence;
  /**
   * What to print after the cadence, chosen WITH the row — or null when there is
   * nothing to qualify. Evidence for a live series, status for one that is not:
   * `seriesEvidence` is only meaningful for detected/confirmed, and this list
   * printed "lapsed" over five series the owner had dismissed.
   */
  label: string | null;
  href: string;
}

/**
 * Recurring series whose linked active transactions fall in this category's
 * subtree — the bridge from the Spending tab back to Recurring (§4). A series'
 * category is the category of its linked rows (recurringSeries has no category
 * column), so this is derived from the ledger.
 */
export function seriesInCategory(db: AppDatabase, categoryId: string, today: string): CategorySeriesRow[] {
  const ids = recurringSeriesIdsForCategory(db, categoryId);
  if (ids.size === 0) return [];

  // one call for the whole card, keyed by series — see `CategorySeriesRow.overdue`
  const overdueById = new Map(
    overdueForSeries(db, ids, periodBounds(today, "monthly").start, addDays(today, -1)).series.map(
      (o) => [o.id, { date: o.nextDate, occurrenceCount: o.occurrenceCount }] as const,
    ),
  );

  return listSeries(db, today)
    .filter((s) => ids.has(s.id))
    /*
     * ⛔ DISMISSED IS THE OWNER SAYING "NOT RECURRING", and this card is headed
     * "Recurring series". It is also the detector's re-detection sink, so those
     * rows exist only because he rejected them — printing them back as bills is
     * the page contradicting a decision it was told about. `ended` stays: it WAS
     * recurring here and stopped, which is history this category owns.
     */
    .filter((s) => s.status !== "dismissed")
    .map((s) => ({
      id: s.id,
      name: s.name,
      cadence: s.cadence,
      /*
       * 🔴 The EFFECTIVE amount, user override first — what the forecast
       * projects and what every other surface prints. This read the stored
       * average, and for a hand-registered series that "average" is the seed
       * from registration: /categories/<Car> listed the lease at $559.89 on
       * 2026-09-03, the figure the ledger corrected to $695.04 on 2026-08-31.
       */
      amountCents: s.nextExpectedAmountCents ?? s.amountCentsAvg ?? 0,
      nextExpectedOn: s.nextExpectedOn,
      overdue: overdueById.get(s.id) ?? null,
      status: s.status,
      isActive: s.isActive,
      evidence: s.evidence,
      label: seriesRowLabel(s.status, s.evidence),
      href: `/recurring/${s.id}`,
    }));
}

// ── Budget reference ─────────────────────────────────────────────────

export interface CategoryBudgetRef {
  amountCents: number;
  /** banked plan from closed periods; 0 unless the budget opted into rollover */
  rolloverCents: number;
  /** amountCents + rolloverCents — the denominator `remainingCents` is measured from */
  availableCents: number;
  spentCents: number;
  remainingCents: number;
  period: string;
  /**
   * The window actually graded — the budget's own period containing `refDate`.
   *
   * 🔴 The card names no window and the page it sits on has a period selector,
   * so on 2026-09-04 `/categories/<Housing>?period=2026-07` read "Spent · July
   * 2026 · $2,653.58" over "monthly budget for this category · $0.00 of
   * $2,291.21" — one screen answering the same question twice. The figure is
   * right for September; the sentence was the defect. `/budgets`' own detail
   * card prints "Grading Sep 1 – Sep 30" for the same reason.
   */
  bounds: { start: string; end: string };
  alert: "none" | "warn80" | "over";
  href: string;
}

/** The active budget targeting THIS exact category, evaluated at refDate. */
export function categoryBudgetRef(db: AppDatabase, categoryId: string, refDate: string): CategoryBudgetRef | null {
  const status = budgetStatuses(db, refDate).find((s) => s.budget.categoryId === categoryId);
  if (!status) return null;
  return {
    amountCents: status.budget.amountCents,
    rolloverCents: status.rolloverCents,
    availableCents: status.availableCents,
    spentCents: status.spentCents,
    remainingCents: status.remainingCents,
    period: status.budget.period,
    bounds: { start: status.bounds.start, end: status.bounds.end },
    alert: status.alert,
    href: "/budgets",
  };
}
