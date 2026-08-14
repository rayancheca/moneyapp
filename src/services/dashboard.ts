import type { AppDatabase } from "@/db/client";
import type { AssetType } from "@/db/schema/holdings";
import type { SeriesKind } from "@/db/schema/recurring";
import { compareDates, todayIso } from "@/lib/dates";
import { dayChangeTerm } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { resolvePeriod } from "@/lib/period";
import { listAccounts } from "./accounts";
import { bridgedNetWorthSeries, type BridgedNetWorthPoint } from "./in-flight";
import { forecastCurrentMonth } from "./forecast";
import { portfolioOverview, portfolioSeries, topMovers } from "./portfolio";
import { upcomingOccurrences } from "./recurring";
import { statementPulls, type AccountStatementPull } from "./statement-pulls";
import { needsReviewCount } from "./review-count";
import { cashFlowByPeriod } from "./spending";

/**
 * The dashboard aggregator (ux-overhaul-plan §7.1): assembles the teaser models
 * for the hub that "never dead-ends" — every widget carries the exact drill
 * target it opens, so the §7.4 drill-down contract is verified against ONE
 * source of truth rather than hrefs scattered across JSX. Each teaser reuses a
 * finished Stage-1..4 service (netWorthSeries, forecast, portfolio, spending,
 * recurring), so the numbers reconcile with the tab they link to.
 */

const UPCOMING_WINDOW_DAYS = 14;
/** how far ahead to look for the next paycheck when summing bills due before it */
const PAYCHECK_HORIZON_DAYS = 45;
const SPARKLINE_DAYS = 30;

export interface NetWorthSummary {
  /** in-flight-bridged (docs/inflight-dips.md): transfer floats never chart as
   *  dips/spikes; bridged days carry `inTransitCents` for the chart's mark */
  series: BridgedNetWorthPoint[];
  latestCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  asOf: string | null;
  /** the latest point's signed in-flight correction — non-zero means the
   *  headline includes money currently in transit and the hero must SAY so
   *  (it will not equal assets − liabilities until the transfer settles) */
  inTransitCents: number;
  complete: boolean;
  coveredAccounts: number;
  totalAccounts: number;
  /** names of accounts missing coverage on the latest day (empty when complete) */
  missingAccounts: string[];
  /** names of accounts WITH coverage on the latest day */
  coveredAccountNames: string[];
}

export interface UpcomingBillItem {
  seriesId: string;
  name: string;
  kind: SeriesKind;
  date: string;
  /** net-worth-signed (income positive, bill negative) */
  amountCents: number;
  href: string;
}

export interface UpcomingBills {
  items: UpcomingBillItem[];
  windowDays: number;
  /** signed net of the window's occurrences */
  netCents: number;
  /**
   * Spending owed before the next projected paycheck, present only when an
   * income series exists to define "next paycheck" (§7.1 [RM-S]).
   */
  beforePaycheck: { cents: number; date: string } | null;
}

export interface PacePoint {
  label: string;
  /** cumulative actual spend through this sub-bucket; null once past today */
  actualCents: number | null;
  /** straight-line projection toward the period's projected spend */
  idealCents: number;
}

export interface SpendingPace {
  monthLabel: string;
  actualToDateCents: number;
  projectedCents: number;
  points: PacePoint[];
  /** income (actual + expected) minus spend-so-far and upcoming fixed bills */
  freeToSpendCents: number;
  href: string;
}

export interface TeaserMover {
  symbol: string;
  assetType: AssetType;
  dayChangeCents: number;
  dayChangePct: number;
  href: string;
}

export interface InvestmentsTeaser {
  valueCents: number;
  /** null when no prior covered day exists — see `PortfolioOverview.dayChangeCents` */
  dayChangeCents: number | null;
  dayChangePct: number | null;
  dayChangeExact: boolean;
  /**
   * What to call the change — "today" only when the newest close IS today,
   * otherwise the two dates it was actually measured between.
   *
   * Resolved here rather than in the component because the naming rule needs
   * `today`, which the dashboard model already carries and the teaser's props
   * do not. `dayChangeTerm` wraps the same `dayChangeLabel` the /investments
   * header renders, so the two surfaces cannot disagree about the same figure.
   */
  dayChangeTerm: string;
  sparkline: number[];
  topMover: TeaserMover | null;
  href: string;
}

export interface DashboardData {
  netWorth: NetWorthSummary;
  reviewCount: number;
  reviewHref: string;
  upcoming: UpcomingBills;
  pace: SpendingPace | null;
  investments: InvestmentsTeaser | null;
  /**
   * Every account that issues statements, due or not. The teaser needs the
   * whole list, not just the outstanding ones: an all-clear it can only reach
   * by counting to zero is a claim, and "no rows" and "nothing to do" have to
   * be distinguishable on a dashboard.
   */
  statements: AccountStatementPull[];
}

function netWorthSummary(db: AppDatabase): NetWorthSummary {
  const series = bridgedNetWorthSeries(db);
  const latest = series.at(-1) ?? null;
  const accounts = listAccounts(db).filter((a) => a.isActive);
  const assetsCents = accounts
    .filter((a) => !a.isLiability && a.balance)
    .reduce((sum, a) => sum + (a.balance?.balanceCents ?? 0), 0);
  const liabilitiesCents = accounts
    .filter((a) => a.isLiability && a.balance)
    .reduce((sum, a) => sum + (a.balance?.balanceCents ?? 0), 0);
  return {
    series,
    latestCents: latest?.totalCents ?? 0,
    assetsCents,
    liabilitiesCents,
    asOf: latest?.day ?? null,
    inTransitCents: latest?.inTransitCents ?? 0,
    complete: latest?.complete ?? true,
    coveredAccounts: latest?.coveredAccounts ?? 0,
    totalAccounts: latest?.totalAccounts ?? 0,
    missingAccounts: latest?.missingAccounts ?? [],
    coveredAccountNames: latest?.coveredAccountNames ?? [],
  };
}

function upcomingBills(db: AppDatabase, today: string): UpcomingBills {
  // internal transfers are net-worth-neutral (the app-wide transfer LAW, enforced
  // in analytics + forecast) — a recurring "move to savings" is never a bill and
  // never spending owed, so it stays out of the whole widget
  const within = upcomingOccurrences(db, today, UPCOMING_WINDOW_DAYS).filter((o) => o.kind !== "transfer");
  const items: UpcomingBillItem[] = within.map((o) => ({
    seriesId: o.seriesId,
    name: o.name,
    kind: o.kind,
    date: o.date,
    amountCents: o.amountCents,
    href: `/recurring/${o.seriesId}`,
  }));
  const netCents = items.reduce((sum, i) => sum + i.amountCents, 0);

  // "before your next paycheck": look further out to find the next income
  // occurrence, then sum the spending occurrences that fall on or before it.
  const horizon = upcomingOccurrences(db, today, PAYCHECK_HORIZON_DAYS).filter((o) => o.kind !== "transfer");
  const nextPaycheck = horizon.find((o) => o.kind === "income") ?? null;
  const beforePaycheck = nextPaycheck
    ? {
        date: nextPaycheck.date,
        cents: horizon
          .filter((o) => o.amountCents < 0 && compareDates(o.date, nextPaycheck.date) <= 0)
          .reduce((sum, o) => sum + o.amountCents, 0),
      }
    : null;

  return { items, windowDays: UPCOMING_WINDOW_DAYS, netCents, beforePaycheck };
}

function spendingPace(db: AppDatabase, today: string): SpendingPace | null {
  const period = resolvePeriod({}, today);
  const cashFlow = cashFlowByPeriod(db, period, today);
  if (!cashFlow.pace) return null;

  const totalBuckets = cashFlow.buckets.length || 1;
  let cumulative = 0;
  const points: PacePoint[] = cashFlow.buckets.map((b, i) => {
    const past = compareDates(b.from, today) <= 0;
    if (past) cumulative += b.spendingCents;
    return {
      label: b.label,
      actualCents: past ? cumulative : null,
      idealCents: Math.round((cashFlow.pace!.projectedCents * (i + 1)) / totalBuckets),
    };
  });

  // free-to-spend = full-month income (actual + upcoming fixed) minus spend so
  // far and the fixed bills still due — the discretionary headroom left (§7.1)
  const forecast = forecastCurrentMonth(db, today);
  const remainingFixedIncome = forecast.components
    .filter((c) => c.kind === "fixed" && c.cents > 0)
    .reduce((sum, c) => sum + c.cents, 0);
  const remainingFixedBills = forecast.components
    .filter((c) => c.kind === "fixed" && c.cents < 0)
    .reduce((sum, c) => sum + c.cents, 0); // negative
  const freeToSpendCents =
    cashFlow.totals.earnedCents +
    remainingFixedIncome -
    cashFlow.totals.spentCents +
    remainingFixedBills;

  return {
    monthLabel: period.label,
    actualToDateCents: cashFlow.pace.actualToDateCents,
    projectedCents: cashFlow.pace.projectedCents,
    points,
    freeToSpendCents,
    href: "/spending",
  };
}

function investmentsTeaser(db: AppDatabase, today: string): InvestmentsTeaser | null {
  const overview = portfolioOverview(db);
  if (overview.asOf === null || overview.valueCents === 0) return null;

  const sparkline = portfolioSeries(db)
    .slice(-SPARKLINE_DAYS)
    .map((p) => p.valueCents);

  const { winners, losers } = topMovers(db, 4);
  const candidates = [...winners, ...losers];
  const top = candidates.reduce<(typeof candidates)[number] | null>(
    (best, m) => (best === null || Math.abs(m.dayChangePct) > Math.abs(best.dayChangePct) ? m : best),
    null,
  );

  // "today" is a claim about WHEN, and this figure is measured over today only
  // when the newest close is today's. Between price refreshes it is not, and the
  // teaser used to say the word anyway.
  const term = dayChangeTerm(overview.asOf, overview.dayChangeVsDay, today, formatDayShort);

  return {
    valueCents: overview.valueCents,
    dayChangeCents: overview.dayChangeCents,
    dayChangePct: overview.dayChangePct,
    dayChangeExact: overview.dayChangeExact,
    dayChangeTerm: term,
    sparkline,
    topMover: top
      ? {
          symbol: top.symbol,
          assetType: top.assetType,
          dayChangeCents: top.dayChangeCents,
          dayChangePct: top.dayChangePct,
          href: `/investments/${top.assetType}/${top.symbol}`,
        }
      : null,
    href: "/investments",
  };
}

/** The full dashboard model — every teaser plus the target each one drills to. */
export function dashboardData(db: AppDatabase, today: string = todayIso()): DashboardData {
  return {
    netWorth: netWorthSummary(db),
    reviewCount: needsReviewCount(db),
    reviewHref: "/transactions?view=review",
    upcoming: upcomingBills(db, today),
    pace: spendingPace(db, today),
    investments: investmentsTeaser(db, today),
    statements: statementPulls(db, today),
  };
}
