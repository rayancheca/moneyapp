import type { AppDatabase } from "@/db/client";
import type { AssetType } from "@/db/schema/holdings";
import type { SeriesKind } from "@/db/schema/recurring";
import { cashFlowCumulative, plottedRunningTotals } from "@/lib/cash-flow-cumulative";
import { compareDates, diffDays, todayIso } from "@/lib/dates";
import { daysNotImportedYet } from "@/lib/empty-period";
import { dayChangeTerm } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { resolvePeriod } from "@/lib/period";
import { listAccounts } from "./accounts";
import { bridgedNetWorthSeries, type BridgedNetWorthPoint } from "./in-flight";
import { forecastCurrentMonth } from "./forecast";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { portfolioOverview, portfolioSeries, topMovers } from "./portfolio";
import { upcomingOccurrences } from "./recurring";
import { statementPulls, type AccountStatementPull } from "./statement-pulls";
import { needsReviewCount, uncategorizedCount } from "./review-count";
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
  /** cumulative actual spend through this sub-bucket; null where the ledger has not read it (`plottedRunningTotals`) */
  actualCents: number | null;
}

export interface SpendingPace {
  monthLabel: string;
  actualToDateCents: number;
  projectedCents: number;
  /**
   * Elapsed days of this month the ledger holds no import for. >0 means
   * `actualToDateCents` and `projectedCents` are LOWER BOUNDS, not
   * measurements — the same rule /budgets grades by, applied to the same days.
   */
  uncoveredDays: number;
  points: PacePoint[];
  /** income (actual + expected) minus spend-so-far and upcoming fixed bills */
  /**
   * Null when NO elapsed day of the month is imported: "$0.00 spent, so you
   * have $X free" is a claim about a month nobody has looked at. The em dash
   * is the refusal `dayChangeLabel` already makes for a portfolio with no prior
   * close — an omission costs no information, an assertion costs the truth.
   */
  freeToSpendCents: number | null;
  href: string;
}

export interface TeaserMover {
  symbol: string;
  assetType: AssetType;
  dayChangeCents: number;
  dayChangePct: number;
  /**
   * The two closes this move was measured between, when they are NOT the days
   * the headline above it names; null when the headline's term already says them.
   *
   * 🔴 On Tue 2026-09-15 the teaser read "$0.00 (+0.00%) today" and then "Top
   * mover COKE +5.77%" with no date: the headline's days are the portfolio
   * series', carried to today, and the mover's are COKE's Friday and Monday
   * closes. A chip under a line ending "today" inherits "today" unless it says
   * otherwise.
   */
  dayChangeTerm: string | null;
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
  /**
   * Active rows with NO CATEGORY — a different backlog from `reviewCount`, and
   * the reason the all-clear had to stop being built from one count. See
   * `review-count.ts::uncategorizedCount`.
   */
  uncategorizedCount: number;
  uncategorizedHref: string;
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

  /*
   * 🔴 THE STAIRCASE RAN FLAT THROUGH DAYS ITS OWN TEXT SAYS ARE NOT IMPORTED.
   * A bucket was drawn whenever `b.from <= today`, so the last total read was
   * held level across every elapsed day after it — under words saying "at least"
   * and "3 days of September 2026 not imported yet". Measured on the owner's
   * ledger 2026-09-15 (newest row 2026-09-12): Sep 13, 14 and 15 drawn at
   * $1,431.05, all three `after-records`. /spending's graph lens had stopped
   * drawing its running totals through those days; this tile had not.
   *
   * ⛔ The frontier AND the arithmetic are the graph's own — `cashFlowCumulative`,
   * then `plottedRunningTotals` — so the two cannot stop on different days, and
   * a day before the records begin is left undrawn as well.
   *
   * ⛔ …AND NEVER PAST TODAY. The graph draws a bucket holding a row as a figure
   * even when it is dated after today (data wins, `holdsRows`), which would put
   * a step of this "so far" line — and the marker where measuring stops — on a
   * day that has not happened. Today's bucket is drawn exactly when it is read.
   */
  const running = plottedRunningTotals(cashFlowCumulative(cashFlow.buckets, null, 0), cashFlow.buckets);
  const points: PacePoint[] = cashFlow.buckets.map((b, i) => ({
    label: b.label,
    actualCents: compareDates(b.from, today) <= 0 ? running[i]!.spentCum : null,
  }));

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

  /*
   * 🔴 The tile asserted "$0.00 spent" over days nothing had been imported for.
   * Measured on the real ledger, whose newest active row is 2026-08-24: at
   * today = 2026-09-20 it read "$0.00 spent · $0.00 projected · ≈ $947.00 free
   * to spend" over twenty days nobody had looked at.
   *
   * ⚠️ The arithmetic is `/budgets`' own, deliberately: data ending before the
   * window opens leaves the WHOLE elapsed window uncovered, and data running
   * past today leaves none. Two surfaces grading the same days must not grade
   * them two ways.
   */
  // ⛔ …and that one arithmetic is `daysNotImportedYet` now, which /spending's
  // cash-flow readout reads too. Until 2026-09-14 this tile held it inline and
  // was the only one of the two surfaces that said "at least".
  const uncoveredDays = daysNotImportedYet({
    from: period.from,
    to: period.to,
    today,
    ledgerOpens: ledgerOpens(db),
    ledgerReaches: ledgerReaches(db),
  });
  const elapsedDays = diffDays(period.from, today) + 1;

  return {
    monthLabel: period.label,
    actualToDateCents: cashFlow.pace.actualToDateCents,
    projectedCents: cashFlow.pace.projectedCents,
    points,
    uncoveredDays,
    // not one elapsed day measured: there is no figure, only an assumption
    freeToSpendCents: uncoveredDays >= elapsedDays ? null : freeToSpendCents,
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
  // …and the mover is measured between ITS OWN two closes, which the carried
  // series can have left behind — the same rule over the right pair of days
  const moverTerm = top ? dayChangeTerm(top.quotedOn, top.previousQuotedOn, today, formatDayShort) : null;

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
          dayChangeTerm: moverTerm === term ? null : moverTerm,
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
    uncategorizedCount: uncategorizedCount(db),
    uncategorizedHref: "/transactions?category=uncategorized",
    upcoming: upcomingBills(db, today),
    pace: spendingPace(db, today),
    investments: investmentsTeaser(db, today),
    statements: statementPulls(db, today),
  };
}
