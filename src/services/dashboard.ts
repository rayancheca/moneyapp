import type { AppDatabase } from "@/db/client";
import type { AssetType } from "@/db/schema/holdings";
import type { SeriesKind } from "@/db/schema/recurring";
import { cashFlowCumulative, plottedRunningTotals } from "@/lib/cash-flow-cumulative";
import { compareDates, diffDays, todayIso } from "@/lib/dates";
import { daysNotImportedYet } from "@/lib/empty-period";
import { closesDayChange, dayChangePhrase, dayChangeTerm } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { resolvePeriod } from "@/lib/period";
import { listAccounts } from "./accounts";
import { bridgedNetWorthSeries, type BridgedNetWorthPoint } from "./in-flight";
import { forecastCurrentMonth } from "./forecast";
import { allSpendPartlyRead } from "./movers-card";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { holdingRows, portfolioDayChange, portfolioOverview, portfolioSeries, topMovers } from "./portfolio";
import { provenanceFor, type PartlyRead, type Provenance } from "./provenance";
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
/** how far ahead to look for the next paycheck when summing bills due by it */
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
   * Spending owed BY the next projected paycheck — due on or before its day — present only when an
   * income series exists to define "next paycheck" (§7.1 [RM-S]). The strip says "due by", not
   * "before": a bill due ON the payday is in it (measured on his ledger copy 2026-10-12: all $701.04 was).
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
   * ⚖️ Decision 72: the elapsed days of this month past the day every account he spends from is imported through, and
   * /budgets' line for them (`allSpendPartlyRead` — /spending's count and line for the same month); null when it is
   * read in full. Present, `actualToDateCents` and `projectedCents` are LOWER BOUNDS, not measurements.
   */
  partlyRead: PartlyRead | null;
  /**
   * /spending's proof of the month's spending (`allSpend`, asked on `today`) — the chip beside the figures, reading
   * "partly read" where `partlyRead` is present and the month holds rows. Null beside the dash (`freeToSpendCents`
   * null): never offered there, so never built there.
   */
  provenance: Provenance | null;
  /**
   * ⚖️ Decision 64: "spending imported through Aug 12" where the month holds no spending and not one elapsed day is read
   * by that day — /spending's Spent card prints "—" with these words (`CashFlow.spendingUnaccounted`), and so does the
   * tile. Null otherwise — and where no account has read one elapsed day at all, whose dash is "not imported yet".
   * ⛔ /spending's cash-flow readout, the tile's twin, prints them in place of its figures (`paceReadout`): 🔴 review of
   * 1042f71, the tile dashed beside a readout of "On pace for at least $0.00 … at least $0.00 so far".
   */
  spendingNotFound: string | null;
  /**
   * ⚖️ §6A 68: Free to spend is null because the month's Income is no measurement (`CashFlow.incomeUnread`) — its
   * spending figures, line and proof stand, and the tile says what the figure waits for, in /spending's savings-rate
   * words ("until income is found"). False wherever the month's spending is no figure either: that dash says spending's
   * words, as it always has.
   */
  waitsForIncome: boolean;
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
  /** the move INTO the newest close; null when there is none to measure — see `PortfolioDayChange.cents` */
  dayChangeCents: number | null;
  dayChangePct: number | null;
  dayChangeExact: boolean;
  /**
   * What to call the change — "today" only when the newest close IS today,
   * otherwise the two dates it was actually measured between.
   *
   * Resolved here rather than in the component because the naming rule needs
   * `today`, which the dashboard model already carries and the teaser's props
   * do not. It is `closesDayChange` over the closes `portfolioDayChange`
   * measured — the heading the /investments header renders, as a phrase — so
   * the two surfaces cannot disagree about the same figure.
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

  // "due by your next paycheck": look further out to find the next income
  // occurrence, then sum the spending occurrences that fall on or before it.
  const horizon = upcomingOccurrences(db, today, PAYCHECK_HORIZON_DAYS).filter((o) => o.kind !== "transfer");
  // ⚖️ HIS paycheck: `upcomingOccurrences` holds no payday of the agent's cash (`isAgentsIncomeSeries`, owner
  // decision 2026-09-28). 🔴 On a fixture, the agent's Oct 31 interest stood in for his Nov 5 pay, so "due by
  // your next paycheck" stopped counting bills five days short
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
   * ledger 2026-09-15, while `ledgerReaches` still counted transactions only
   * (newest row 2026-09-12): Sep 13, 14 and 15 drawn at $1,431.05, all three
   * `after-records`. /spending's graph lens had stopped drawing its running
   * totals through those days; this tile had not.
   *
   * ⚠️ That measurement predates S32, which counts a non-investment statement
   * end as imported (`ledgerReaches`). Re-measured on the same ledger at today
   * = 2026-09-15 after it: the newest row is still Sep 12, but Venture X's
   * statement closes Sep 13, so `ledgerReaches` is Sep 13 and Sep 13 is a
   * REACHED day — drawn at $1,431.05, correctly. Only Sep 14 and 15 are
   * `after-records`, left undrawn under "2 days of September 2026 not imported
   * yet".
   *
   * ⛔ The frontier AND the arithmetic are the graph's own — `cashFlowCumulative`,
   * then `plottedRunningTotals` — so the two cannot stop on different days, and
   * a day before the records begin is left undrawn as well.
   *
   * ⚠️ That frontier is the newest day ANY account reached (`ledgerReaches`); the
   * line under the tile counts from the day EVERY account he spends from reached
   * (`partlyRead`, decision 72). With one account they are one day; with more, the
   * staircase runs past the day the text counts from, over days whose figures
   * are lower bounds. 🔴 This said the undrawn days were the ones the text counts
   * (review of the pace card, batch 4/5). On his ledger copy 2026-10-21 it draws
   * Oct 1–14 (Venture X) to $1,603.00 under "spending imported through Aug 12 ·
   * 21 days of this period unaccounted" — as /spending's graph lens does.
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
  // ⛔ …and that one arithmetic is `daysNotImportedYet` now. Until 2026-09-14
  // this tile held it inline and was the only one of the two surfaces that
  // said "at least".
  const elapsedDays = diffDays(period.from, today) + 1;
  // not one elapsed day read by ANY account — an empty ledger too: there is no figure, only an assumption
  const noDayRead =
    daysNotImportedYet({
      from: period.from,
      to: period.to,
      today,
      ledgerOpens: ledgerOpens(db),
      ledgerReaches: ledgerReaches(db),
    }) >= elapsedDays;
  /*
   * ⚖️ His decision 72 (2026-10-13): the days the figures are lower bounds over are the ones not EVERY account he spends
   * from has read — /spending's count and line for the month (`allSpendPartlyRead`), and its proof is the chip. 🔴
   * Measured on his ledger copy 2026-10-21: counted against the ledger's newest day (Venture X, Oct 14) the tile read
   * "at least $1,603.00 spent · 7 days of October 2026 not imported yet" with no chip, while /spending, one click away,
   * read "partly read · spending imported through Aug 12 · 21 days of this period unaccounted".
   */
  const partlyRead = allSpendPartlyRead(db, period.from, period.to, today);
  // ⚖️ decision 64: no spending found and no elapsed day read by that day is no "$0.00 spent" — /spending's Spent card's
  // dash, asked of the same window by the same rule (`spendingNotFoundFact`)
  const spendingNotFound = cashFlow.spendingUnaccounted;
  const withheld = noDayRead || spendingNotFound !== null;
  /*
   * ⚖️ §6A 68 — no Income, no Free to spend: the month's posted income is its first term, and where no income was found
   * and not one day of the month is checked where his pay lands (`CashFlow.incomeUnread` — the rule the dashboard's own
   * Income card dashes by, `incomeExpectation`) it is no measurement. The figure waits; what was spent stands under it.
   * 🔴 On his ledger copy 2026-10-21 the tile read "≈ −$2,839.14" ($0.00 + $2,283.84 − $1,603.00 − $3,519.98) beside
   * that card's "—", Wells Fargo checked through Sep 24: Oct 1, 8 and 15's $3,425.76 were in neither leg, and banked
   * they make it +$586.62 (review of 6cb97ea). Spending's dash outranks it — its words say why the spent line is gone.
   *
   * ⚖️ default built, not asked (2026-10-21): the dash holds from the 1st of each month until a statement covering one
   * day of it is imported where his pay lands. Wells Fargo's statements arrive monthly (staleness is expected), so the
   * tile's headline figure reads "—" for most of every month. Measured on his ledger copy 2026-10-29: day 29 of 31
   * reads "— · until income is found" over "at least $1,603.00 spent · at least $1,713.55 projected", Wells Fargo
   * checked through Sep 24; the figure it holds back is −$3,981.06 ($0.00 + $1,141.92 − $1,603.00 − $3,519.98), Oct
   * 1, 8, 15 and 22's $4,567.68 in neither leg — +$586.62 banked. ⚠️ A live pay schedule naming no account lands
   * nowhere the ledger has read, so the figure waits in every month no income is found (this file's test gives its
   * Payroll an account to keep it); his It America LLC schedule names Wells Fargo. ⚠️ Latent, not built: a month whose
   * pay is found in part prints its figure, and a payday between the pay account's last checked day and today is in
   * neither leg there — $0, with no "partly read" for income. On a temp fixture (weekly $1,000 found Jul 2, its account
   * checked through Jul 2) the tile reads $4,920.00 on Jul 8 and $3,920.00 on Jul 10, Jul 9's pay in neither.
   */
  const waitsForIncome = !withheld && cashFlow.incomeUnread;
  /*
   * ⛔ The proof proves a rendered figure, so it is built only beside one (`SpendingPace.provenance`). 🔴 It was built on
   * every render — 18.4 ms against 419 ms for all of `dashboardData` on his ledger copy (review of the pace card, batch
   * 4/5) — where the tile withholds the figure and mounts no chip too. ⚠️ `partlyRead` above is no copy of its count to
   * remove: an empty window's proof carries none (`Provenance.partlyRead`), while "at least $0.00 spent" over a month
   * read in part still needs the line. ⚠️ A Free to spend that waits for income still renders what was spent: the proof
   * stands beside that.
   */
  const provenance = withheld
    ? null
    : provenanceFor(db, { kind: "allSpend", from: period.from, to: period.to, label: period.label, today })!;

  return {
    monthLabel: period.label,
    actualToDateCents: cashFlow.pace.actualToDateCents,
    projectedCents: cashFlow.pace.projectedCents,
    points,
    partlyRead,
    provenance,
    spendingNotFound,
    waitsForIncome,
    freeToSpendCents: withheld || waitsForIncome ? null : freeToSpendCents,
    href: "/spending",
  };
}

function investmentsTeaser(db: AppDatabase, today: string): InvestmentsTeaser | null {
  const overview = portfolioOverview(db);
  if (overview.asOf === null || overview.valueCents === 0) return null;

  const sparkline = portfolioSeries(db)
    .slice(-SPARKLINE_DAYS)
    .map((p) => p.valueCents);

  // ONE read of the holdings: their closes decide where the headline's move
  // ends, and the movers are drawn from the same rows
  const rows = holdingRows(db, today);
  const { winners, losers } = topMovers(db, 4, rows);
  const candidates = [...winners, ...losers];
  const top = candidates.reduce<(typeof candidates)[number] | null>(
    (best, m) => (best === null || Math.abs(m.dayChangePct) > Math.abs(best.dayChangePct) ? m : best),
    null,
  );

  // "today" is a claim about WHEN, and this figure is measured over today only
  // when the newest close is today's. Between price refreshes it is not, and the
  // teaser used to say the word anyway. ⛔ And it is the move INTO the newest
  // close, named by the closes it is made of — never the carried series' last
  // two days, which on Tue 2026-09-15 read "$0.00 (+0.00%) today".
  const dayChange = portfolioDayChange(db, rows);
  const term = dayChangePhrase(closesDayChange(dayChange.closes, today, formatDayShort).heading);
  // …and the mover is measured between ITS OWN two closes, which the carried
  // series can have left behind — the same rule over the right pair of days
  const moverTerm = top ? dayChangeTerm(top.quotedOn, top.previousQuotedOn, today, formatDayShort) : null;

  return {
    valueCents: overview.valueCents,
    dayChangeCents: dayChange.cents,
    dayChangePct: dayChange.pct,
    dayChangeExact: dayChange.exact,
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
