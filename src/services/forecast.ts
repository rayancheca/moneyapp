import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { projectOngoingIncome } from "@/lib/income-forecast";
import { formatCents } from "@/lib/money";
import { latestBalances, netWorthSeries } from "./derivation";
import { projectOccurrences, toProjectable, type SeriesOccurrence } from "./recurring";

/**
 * Current-month forecast (master-plan Phase 6) — every number traceable:
 * the components array IS the math, and it sums exactly to the totals.
 *
 * FIXED: each active (detected|confirmed) series projects every remaining
 * occurrence in the month. Transfer-kind series are excluded — the analytics
 * semantics are authoritative (transfers are never income or spending), and
 * counting both legs would double-book cash that never leaves the household.
 *
 * VARIABLE: per top-level expense bucket, trailing average of the last 3
 * FULL months of active expense spending excluding recurring-tagged rows,
 * plus a simple trend adjustment ((newest − oldest)/2, clamped at zero),
 * scaled by remaining days / days in month. Uncategorized negative amounts
 * form an explicit "Uncategorized" bucket — never hidden.
 */

const TRAILING_FULL_MONTHS = 3;

export interface ForecastComponent {
  label: string;
  kind: "fixed" | "variable";
  /** net-worth-signed: income positive, spending negative */
  cents: number;
  detail: string;
}

export interface MonthForecast {
  today: string;
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  /** today through month end, inclusive */
  remainingDays: number;
  projectedIncomeCents: number;
  projectedSpendCents: number;
  projectedNetCents: number;
  projectedEomCashCents: number;
  projectedEomNetWorthCents: number;
  components: ForecastComponent[];
}

interface MonthWindow {
  start: string;
  end: string;
  key: string;
}

/** The last N full calendar months before the month containing `today`. */
export function trailingFullMonths(today: string, count: number): MonthWindow[] {
  const windows: MonthWindow[] = [];
  let cursorStart = periodBounds(today, "monthly").start;
  for (let i = 0; i < count; i++) {
    const prevEnd = addDays(cursorStart, -1);
    const bounds = periodBounds(prevEnd, "monthly");
    windows.unshift({ start: bounds.start, end: bounds.end, key: monthKey(prevEnd) });
    cursorStart = bounds.start;
  }
  return windows; // oldest → newest
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: "weekly",
  biweekly: "biweekly",
  semimonthly: "semimonthly",
  monthly: "monthly",
  quarterly: "quarterly",
  annual: "annual",
};

function fixedComponents(db: AppDatabase, today: string, monthEnd: string): ForecastComponent[] {
  const active = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();

  const components: { component: ForecastComponent; firstDate: string }[] = [];
  for (const series of active) {
    if (series.kind === "transfer") continue;
    // forecast reads user overrides first (§4.4): amount, cadence, next-expected
    const occurrences: SeriesOccurrence[] = projectOccurrences(toProjectable(series), today, monthEnd);
    if (occurrences.length === 0) continue;
    const perOccurrence = occurrences[0]!.amountCents;
    const cents = occurrences.length * perOccurrence;
    components.push({
      firstDate: occurrences[0]!.date,
      component: {
        label: series.name,
        kind: "fixed",
        cents,
        detail: `${occurrences.length} × ${formatCents(perOccurrence)} (${CADENCE_LABEL[series.cadence] ?? series.cadence}), next ${occurrences[0]!.date}`,
      },
    });
  }
  return components
    .sort((a, b) => compareDates(a.firstDate, b.firstDate) || a.component.label.localeCompare(b.component.label))
    .map((c) => c.component);
}

const UNCATEGORIZED_LABEL = "Uncategorized";

function variableComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
): ForecastComponent[] {
  const windows = trailingFullMonths(today, TRAILING_FULL_MONTHS);
  const rangeStart = windows[0]!.start;
  const rangeEnd = windows.at(-1)!.end;

  const categoryRows = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind })
    .from(categories)
    .all();
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  const rootOf = (categoryId: string) => {
    const cat = categoryById.get(categoryId);
    if (!cat) return null;
    return cat.parentId ? (categoryById.get(cat.parentId) ?? null) : cat;
  };

  // trailing spend EXCLUDES recurring-tagged rows — those live in FIXED
  const rows = db
    .select({
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.recurringSeriesId),
        gte(transactions.postedOn, rangeStart),
        lte(transactions.postedOn, rangeEnd),
      ),
    )
    .all();

  // bucket → monthKey → net-worth-signed sum
  const buckets = new Map<string, Map<string, number>>();
  const add = (label: string, month: string, cents: number) => {
    const perMonth = buckets.get(label) ?? new Map<string, number>();
    perMonth.set(month, (perMonth.get(month) ?? 0) + cents);
    buckets.set(label, perMonth);
  };

  for (const t of rows) {
    if (t.categoryId === null) {
      // uncategorized negatives are an explicit spending bucket, never hidden
      if (t.amountCents < 0) add(UNCATEGORIZED_LABEL, monthKey(t.postedOn), t.amountCents);
      continue;
    }
    const root = rootOf(t.categoryId);
    if (!root || root.kind !== "expense") continue;
    add(root.name, monthKey(t.postedOn), t.amountCents);
  }

  const components: ForecastComponent[] = [];
  for (const [label, perMonth] of buckets) {
    // spend magnitudes per trailing month (outflow negative → positive spend)
    const spend = windows.map((w) => -(perMonth.get(w.key) ?? 0));
    const oldest = spend[0]!;
    const newest = spend.at(-1)!;
    const avg = spend.reduce((a, b) => a + b, 0) / spend.length;
    const trend = (newest - oldest) / 2;
    const monthlyEstimate = Math.max(0, avg + trend); // never project negative spend
    const projected = Math.round((monthlyEstimate * remainingDays) / daysInMonth);
    if (projected <= 0) continue;
    components.push({
      label,
      kind: "variable",
      cents: -projected,
      detail: `3-mo avg ${formatCents(Math.round(avg))} + trend ${formatCents(Math.round(trend))}, × ${remainingDays}/${daysInMonth} days`,
    });
  }

  return components.sort(
    (a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.label.localeCompare(b.label),
  );
}

/**
 * VARIABLE INCOME — the fix for a near-zero "projected income" when income is
 * real but IRREGULAR (a cash job, tutoring) rather than a detected series. Per
 * income subcategory, the trailing average of the last 3 FULL months of ONGOING
 * income, scaled by remaining days. Mirrors variableComponents (spending) but
 * with income honesty (see lib/income-forecast.ts): a bucket must appear in ≥2
 * trailing months (one-off refunds/aid never extrapolate) and there is NO upward
 * trend nudge. Series-tagged rows are excluded — they project via FIXED. Income
 * is a positive inflow, so only positive-amount income-kind rows contribute.
 */
/**
 * Income subcategories that are event-driven windfalls / misc one-offs, NOT
 * ongoing earnings — never projected forward, even when they happen to cluster
 * across months (a tax refund + a security-deposit return + a merchant refund
 * can all land in the same 2-3 months without any of them recurring; the same
 * goes for "Other Income", the misc catch-all where gifts/settlements/stray
 * inflows land). The presence gate alone can't catch that, so these are
 * excluded by name — only the deliberate earning buckets (Salary, Tutoring,
 * Interest, Dividends) project.
 */
const EVENT_DRIVEN_INCOME = new Set([
  "Financial Aid",
  "Refunds & Reimbursements",
  "Other Income",
]);

function variableIncomeComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
): ForecastComponent[] {
  const windows = trailingFullMonths(today, TRAILING_FULL_MONTHS);
  const rangeStart = windows[0]!.start;
  const rangeEnd = windows.at(-1)!.end;

  const categoryRows = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind })
    .from(categories)
    .all();
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  // the income subcategory a row belongs to, or null when it isn't ongoing income-kind
  const incomeBucket = (categoryId: string): string | null => {
    const cat = categoryById.get(categoryId);
    if (!cat) return null;
    const root = cat.parentId ? (categoryById.get(cat.parentId) ?? null) : cat;
    if (!root || root.kind !== "income") return null;
    if (EVENT_DRIVEN_INCOME.has(cat.name)) return null;
    return cat.name;
  };

  // trailing income EXCLUDES recurring-tagged rows — those live in FIXED
  const rows = db
    .select({
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.recurringSeriesId),
        gte(transactions.postedOn, rangeStart),
        lte(transactions.postedOn, rangeEnd),
      ),
    )
    .all();

  const buckets = new Map<string, Map<string, number>>();
  for (const t of rows) {
    if (t.categoryId === null || t.amountCents <= 0) continue; // income is a positive inflow
    const label = incomeBucket(t.categoryId);
    if (label === null) continue;
    const perMonth = buckets.get(label) ?? new Map<string, number>();
    const mk = monthKey(t.postedOn);
    perMonth.set(mk, (perMonth.get(mk) ?? 0) + t.amountCents);
    buckets.set(label, perMonth);
  }

  const trailing = [...buckets].map(([label, perMonth]) => ({
    label,
    monthlyTotalsCents: windows.map((w) => perMonth.get(w.key) ?? 0),
  }));

  return projectOngoingIncome(trailing)
    .map((e) => ({
      label: e.label,
      kind: "variable" as const,
      cents: Math.round((e.monthlyCents * remainingDays) / daysInMonth),
      detail: `${e.basis}, × ${remainingDays}/${daysInMonth} days`,
    }))
    .filter((c) => c.cents > 0);
}

export function forecastCurrentMonth(db: AppDatabase, today: string = todayIso()): MonthForecast {
  const { start: monthStart, end: monthEnd } = periodBounds(today, "monthly");
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const remainingDays = diffDays(today, monthEnd) + 1;

  const components = [
    ...fixedComponents(db, today, monthEnd),
    ...variableIncomeComponents(db, today, remainingDays, daysInMonth),
    ...variableComponents(db, today, remainingDays, daysInMonth),
  ];

  // the components ARE the math: totals derive from them, exactly
  const projectedIncomeCents = components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const projectedSpendCents = components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  const projectedNetCents = projectedIncomeCents + projectedSpendCents;

  const cashTypes = new Set(["checking", "savings"]);
  const activeAccounts = db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .all();
  const balances = latestBalances(db);
  let cashCents = 0;
  for (const a of activeAccounts) {
    if (!cashTypes.has(a.type)) continue;
    cashCents += balances.get(a.id)?.balanceCents ?? 0;
  }

  const latestNetWorth = netWorthSeries(db).at(-1)?.totalCents ?? 0;

  return {
    today,
    monthStart,
    monthEnd,
    daysInMonth,
    remainingDays,
    projectedIncomeCents,
    projectedSpendCents,
    projectedNetCents,
    projectedEomCashCents: cashCents + projectedNetCents,
    projectedEomNetWorthCents: latestNetWorth + projectedNetCents,
    components,
  };
}
