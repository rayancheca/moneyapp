import { cloneElement, isValidElement } from "react";
import Link from "next/link";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { todayIso } from "@/lib/dates";
import { coveragePhrase, formatNameList, openingLabel } from "@/lib/coverage-label";
import { formatCents } from "@/lib/money";
import { dashboardData } from "@/services/dashboard";
import { dashboardChartData } from "@/services/dashboard-series";
import { spendingSankey } from "@/services/sankey";
import { netWorthAttribution, type NetWorthAttribution } from "@/services/attribution";
import { provenanceFor } from "@/services/provenance";
import { CHART_RANGES, rangeStartDay, type ChartRange } from "@/lib/chart-range";
import type { SankeyGraph } from "@/lib/sankey-layout";
import { resolveViewState } from "@/lib/view-state";
import { recentLedgerRows } from "@/services/ledger-rows";
import { carCard, runwayCard } from "@/services/committed";
import { eatingOutCard } from "@/services/eating-out";
import { institutionGroups } from "@/services/institution-groups";
import { DASHBOARD_SECTION_IDS, readSettings, type DashboardSectionId } from "@/services/settings";
import { normalizeOrder } from "@/lib/reorder";
import { ArrangeableSections } from "@/components/dashboard/ArrangeableSections";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import { InstitutionCard } from "@/components/accounts/InstitutionCard";
import { DashboardWindowProvider } from "@/components/dashboard/DashboardWindowContext";
import { InvestmentsTeaser } from "@/components/dashboard/InvestmentsTeaser";
import { StatementsTeaser } from "@/components/dashboard/StatementsTeaser";
import { DashboardChartSection } from "@/components/dashboard/DashboardChartSection";
import {
  DASHBOARD_SURFACE,
  DASHBOARD_VIEW_SPEC,
  dashboardSeriesMode,
} from "@/components/dashboard/dashboard-view-spec";
import { PeriodActivityPanel } from "@/components/dashboard/PeriodActivityPanel";
import { SpendingPaceWidget } from "@/components/dashboard/SpendingPaceWidget";
import { RunwayCard } from "@/components/dashboard/RunwayCard";
import { CarCostCard } from "@/components/dashboard/CarCostCard";
import { EatingOutCard } from "@/components/dashboard/EatingOutCard";
import { ToReviewCard } from "@/components/dashboard/ToReviewCard";
import { UpcomingBillsStrip } from "@/components/dashboard/UpcomingBillsStrip";
import { Money } from "@/components/ui/Money";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const dynamic = "force-dynamic";

const RECENT_TXN_LIMIT = 5;
// lower bound for the Sankey's "ALL" range window (rangeStartDay returns null);
// activeTxnsInRange filters postedOn >= from, so any date before the data works
const EARLIEST_DAY = "1970-01-01";
// 6 rows ≈ the height of the right column (pace + investments + top mover), so
// the activity grid reads as two full columns instead of a teaser and a gap
const REVIEW_PREVIEW_LIMIT = 6;

const SETUP_STEPS = [
  {
    step: "01",
    title: "Add your accounts",
    detail:
      "Chase, Discover, Capital One, SoFi, Robinhood — typed as checking, savings, credit, or investment.",
  },
  {
    step: "02",
    title: "Enter current balances",
    detail: "Net worth appears instantly: assets minus liabilities, credit cards counted against you.",
  },
  {
    step: "03",
    title: "Upload statements",
    detail: "Two years of history reconstructed and reconciled to the cent, statement by statement.",
  },
];

function firstParam(value: string | string[] | undefined): string | null {
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === "string" && s !== "" ? s : null;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const db = getDb();
  const today = todayIso();
  const data = dashboardData(db, today);
  const { netWorth } = data;
  // "prove it" for the headline: which accounts add up, which are priced from
  // holdings, and which hold rows this total cannot see
  const netWorthProvenance = provenanceFor(db, { kind: "netWorth", day: today });

  // hero chart view mode: URL > persisted preference > combined (NS#2 Pillar 2)
  const settings = readSettings(db);
  const chartView = resolveViewState(
    DASHBOARD_VIEW_SPEC,
    { chart: firstParam(raw.chart) ?? undefined },
    settings.viewPreferences[DASHBOARD_SURFACE],
  );
  const chartMode = chartView.chart ?? "combined";
  const isSankey = chartMode === "sankey";
  const acctsParam = firstParam(raw.accts) ?? settings.viewPreferences[DASHBOARD_SURFACE]?.accts ?? "";
  // A hero VIEW is not a net-worth SERIES mode, and the difference is a crash.
  // This used to read `chartMode as DashboardMode` behind a comment promising
  // that "adding a spec option without updating DashboardMode would need
  // updating here too" — and the very next spec option ("terrain") was added
  // without it. The cast let the raw slug reach `buildDashboardSeries`, whose
  // exhaustive switch has no case for it, so it fell through, returned
  // `undefined`, and the RSC died on `built.map` — the whole dashboard replaced
  // by the error boundary for anyone who clicked the seventh pill.
  //
  // `dashboardSeriesMode` is that comment enforced by the compiler instead: it
  // returns a real DashboardMode ("terrain" draws the SAME per-account series
  // as "accounts", spatially), or null for the views that build no series at
  // all (combined renders the richer summary path; sankey draws its own flow).
  // An option nobody has mapped yet returns null and renders an empty chart —
  // wrong, but not a 500.
  //
  // THE TERRAIN IS EVERY ACCOUNT, and that is not a preference. It states, in
  // its own accessible label and under the plate, whether its ribbons sum to
  // the net-worth line above it — so handing it the `accts` CURATION (which
  // belongs to the Accounts line view, where showing three accounts is the
  // point) makes it compare a subset against the whole and announce a mismatch
  // that is not one. Measured on the e2e ledger: an 11-of-16 selection left it
  // saying "$145,095.79 … does NOT match the net-worth chart above — read the
  // ledger", $67.00 out, when the full 16 reconcile to the cent. In a money
  // app a false alarm about the figures is worse than no figure at all, so
  // terrain asks for every account (an empty request means "all active" —
  // dashboardChartData's documented fallback) and leaves the curation alone.
  const isTerrain = chartMode === "terrain";
  const chartData = (() => {
    const seriesMode = dashboardSeriesMode(chartMode);
    if (seriesMode === null) return null;
    const requested = isTerrain ? [] : acctsParam.split(",").filter(Boolean);
    return dashboardChartData(db, seriesMode, requested);
  })();
  // Precompute the flow for each range pill so the client switches pills with no
  // round-trip (the pill is client-side ChartFocus state). Only runs in sankey
  // mode; 5 aggregations over local SQLite is cheap for a single-user desktop
  // app — revisit (build once + slice, or a per-range server action) if hosted.
  const sankeyByRange = isSankey
    ? (Object.fromEntries(
        CHART_RANGES.map((r) => [r, spendingSankey(db, { from: rangeStartDay(r, today) ?? EARLIEST_DAY, to: today })]),
      ) as Record<ChartRange, SankeyGraph>)
    : null;
  /*
   * The bridge, one decomposition per range pill, precomputed for the same
   * reason the flow is: the pill is client-side ChartFocus state and a
   * round-trip per click would make the switcher feel broken.
   *
   * ⚠️ The opening and closing totals come from the SAME bridged series the hero
   * prints, read at the window's two ends — never re-derived. Two implementations
   * of net worth is how a page ends up disagreeing with its own headline, and the
   * bridge's entire claim is that its parts sum to that difference.
   */
  const bridgeByRange =
    chartMode === "bridge"
      ? (Object.fromEntries(
          CHART_RANGES.map((r) => {
            const from = rangeStartDay(r, today) ?? netWorth.series[0]?.day ?? today;
            const at = (day: string): number => {
              let cents = netWorth.series[0]?.totalCents ?? 0;
              for (const p of netWorth.series) {
                if (p.day > day) break;
                cents = p.totalCents;
              }
              return cents;
            };
            return [r, netWorthAttribution(db, from, today, at(from), at(today))];
          }),
        ) as Record<ChartRange, NetWorthAttribution>)
      : null;
  // On a partial "today" the two causes read completely differently: an account
  // that had not opened yet is a fact about the calendar (neutral), a day no
  // statement covers is missing data (warning). The split lives on the point the
  // summary was taken from — dashboardData reads the same last point for its
  // counts, so the hero and the chart can never disagree about the day.
  const latestPoint = netWorth.series.at(-1) ?? null;
  const heroNotYetOpen = latestPoint?.notYetOpen ?? [];
  const heroGapAccounts = latestPoint?.gapAccounts ?? [];
  const heroOpening =
    heroNotYetOpen.length > 0 ? openingLabel(netWorth.coveredAccountNames, heroNotYetOpen) : null;

  if (netWorth.totalAccounts === 0) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">Net worth</h1>
          {/* matches the populated hero's responsive size so the two states are the
              same headline, not two different ones */}
          <p aria-hidden className="figures mt-2 text-4xl font-semibold tracking-tight text-ink-faint sm:text-5xl">
            $&thinsp;—
          </p>
          <p className="mt-3 max-w-prose text-sm text-ink-muted">
            No accounts yet. Add your accounts and balances to see your net worth today — upload
            statements to reconstruct the last two years.
          </p>
        </header>
        {/* The sheet now runs to 2064px, so a three-up grid hands each card a
            ~670px column — past a reader's eye span. A+ answers this with
            `--measure`; `max-w-prose` (65ch) is the same rule in Tailwind. */}
        <div className="grid gap-4 *:min-w-0 md:grid-cols-3">
          {SETUP_STEPS.map((s) => (
            <SurfaceCard key={s.step} className="space-y-2">
              <span className="figures text-xs text-accent">{s.step}</span>
              <h2 className="text-sm font-medium">{s.title}</h2>
              <p className="max-w-prose text-[13px] leading-relaxed text-ink-muted">{s.detail}</p>
            </SurfaceCard>
          ))}
        </div>
      </div>
    );
  }

  const groups = institutionGroups(db);
  const runway = runwayCard(db, today);
  const car = carCard(db, today);
  const eatingOut = eatingOutCard(db, today);
  const pickerOptions = buildCategoryPickerOptions(db.select().from(categories).all());
  const reviewRows = recentLedgerRows(db, { limit: REVIEW_PREVIEW_LIMIT, needsReviewOnly: true });
  const recentRows = recentLedgerRows(db, { limit: RECENT_TXN_LIMIT });

  // named, reorderable sections (S7 "movable") in the user's saved order
  const layout = normalizeOrder(settings.dashboardLayout, DASHBOARD_SECTION_IDS);

  const heroSection = (
      <section aria-labelledby="net-worth-heading">
        <header>
          <h1 id="net-worth-heading" className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
            Net worth
            {/* beside the label, never around the figure — a button wrapping the
                headline would be axe nested-interactive inside the header link
                targets, and the badge annotates the number rather than
                replacing a way to click it */}
            {netWorthProvenance && <ProvenancePopover label="net worth" provenance={netWorthProvenance} />}
          </h1>
          {/* The size steps down below `sm` because NumberRoll gives every digit a
              fixed `w-[1ch]` slot (NumberRoll.tsx:52) — that is what stops the odometer
              reflowing mid-animation, and it also means the headline cannot shrink to
              fit. At text-5xl one tabular char is ~28.8px, so an 11-character value
              ($100,000.00 and up) measures ~316px and overflows the 288px content box
              of a 320px viewport. text-4xl (~21.6px/char) holds 13 characters — past
              $1,234,567.89 — at the narrowest supported width. Same responsive-hero
              move PortfolioChartPanel.tsx:185 already makes around its own NumberRoll. */}
          <p className="figures mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
            {/* S10: the headline number rolls when it changes (never on first paint) */}
            <NumberRoll value={formatCents(netWorth.latestCents)} />
          </p>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-muted">
            <span>
              Assets <Money cents={netWorth.assetsCents} className="font-medium text-ink" />
            </span>
            <span>
              Liabilities{" "}
              <Money
                cents={netWorth.liabilitiesCents === 0 ? 0 : -netWorth.liabilitiesCents}
                className={`font-medium ${netWorth.liabilitiesCents === 0 ? "text-ink" : "text-negative"}`}
              />
            </span>
            {netWorth.inTransitCents !== 0 && (
              // the headline is bridged (docs/inflight-dips.md) — while money is
              // in the air it will NOT equal assets − liabilities, so say why
              <span className="text-ink-faint">
                {netWorth.inTransitCents > 0
                  ? `includes ${formatCents(netWorth.inTransitCents)} in transit`
                  : `excludes ${formatCents(-netWorth.inTransitCents)} posted twice in transit`}
              </span>
            )}
            {heroNotYetOpen.length > 0 && (
              <span className="text-ink-faint">
                {netWorth.totalAccounts - heroNotYetOpen.length} of {netWorth.totalAccounts} accounts open
                {heroOpening && <>{" "}· {coveragePhrase(heroOpening)}</>}
              </span>
            )}
            {heroGapAccounts.length > 0 && (
              <span className="text-warning">no statement for {formatNameList(heroGapAccounts)} on this date</span>
            )}
          </p>
        </header>

        {netWorth.series.length > 1 && (
          <>
            <DashboardChartSection
              netWorthPoints={netWorth.series}
              chartData={chartData}
              state={chartView}
              accounts={chartData?.accounts ?? []}
              selectedAccountIds={chartData?.selectedAccountIds ?? []}
              acctsParam={
                // the durable selection: in accounts mode the RSC validated it
                // (drops stale ids); in other modes carry the raw resolved
                // value. Terrain is explicitly "other": it asked for every
                // account, so echoing its selection back would silently
                // overwrite the user's curation with "all" the moment they
                // looked at the terrain and switched back.
                chartData && !isTerrain ? chartData.selectedAccountIds.join(",") : acctsParam
              }
              sankeyByRange={sankeyByRange}
              bridgeByRange={bridgeByRange}
              today={today}
            />
            <PeriodActivityPanel categories={pickerOptions} />
          </>
        )}
      </section>
  );

  // S9: one activity HUB — review, pace, investments, and the upcoming rail
  // compose as a bento with tight internal rhythm (no dead gap between them)
  const activitySection = (
      <section aria-labelledby="activity-hub-heading">
        <h2 id="activity-hub-heading" className="sr-only">
          Activity
        </h2>
        {/* `*:min-w-0` is load-bearing, not decoration. A grid item's automatic
            minimum size is min-content, so BOTH tracks here refused to shrink
            below the widest transaction row: the implicit single column below
            `lg` sized itself to 454px inside a 343px page (+95px of sideways
            scroll at 375, +30px at 440), and above `lg` the 1fr track held
            305px against its 291px share. Zeroing the items' minimum lets the
            tracks shrink; the rows inside already truncate. Same failure shape
            as `truncate` needing `min-w-0`, and page.test.ts gates it. */}
        <div className="grid gap-4 *:min-w-0 lg:grid-cols-[1.5fr_1fr]">
          <ToReviewCard
            count={data.reviewCount}
            href={data.reviewHref}
            rows={reviewRows}
            categories={pickerOptions}
          />
          <div className="space-y-4">
            {data.pace && <SpendingPaceWidget pace={data.pace} />}
            <StatementsTeaser pulls={data.statements} />
            {data.investments && <InvestmentsTeaser data={data.investments} />}
          </div>
        </div>
        <div className="mt-4">
          <UpcomingBillsStrip data={data.upcoming} />
        </div>
      </section>
  );

  /*
   * Pass 63's decision layer, extended: how long the money lasts, what the car
   * costs, and what eating out costs.
   *
   * Every card here is CONDITIONAL — each service returns null on a ledger that
   * cannot answer its question, and a card of zeroes is worse than no card. The
   * grid therefore counts what actually renders rather than assuming: with a
   * single card it stays one column, so the runway takes the full width instead
   * of sitting in a half-width column beside a hole.
   */
  const showEatingOut = eatingOut !== null && !eatingOut.isEmpty;
  const decisionCardCount = 1 + (car ? 1 : 0) + (showEatingOut ? 1 : 0);
  const decisionsSection = (
      <section aria-labelledby="decisions-heading">
        <h2 id="decisions-heading" className="sr-only">
          What this means
        </h2>
        <div className={`grid gap-4 *:min-w-0 ${decisionCardCount > 1 ? "lg:grid-cols-2" : ""}`}>
          <RunwayCard data={runway} />
          {car && <CarCostCard data={car} />}
          {showEatingOut && <EatingOutCard data={eatingOut} />}
        </div>
      </section>
  );

  const accountsSection = (
      <section aria-labelledby="accounts-overview-heading">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="accounts-overview-heading" className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            Accounts
          </h2>
          <Link href="/accounts" className="text-xs text-ink-muted hover:text-ink">
            Manage →
          </Link>
        </div>
        <div className="space-y-3">
          {groups.map((g) => (
            <InstitutionCard key={g.institutionName} group={g} />
          ))}
        </div>
      </section>
  );

  const recentSection =
    recentRows.length > 0 ? (
      <section aria-labelledby="recent-txns-heading">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="recent-txns-heading" className="text-sm font-medium">
            Recent transactions
          </h2>
          <Link
            href="/transactions"
            className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
          >
            All →
          </Link>
        </div>
        <RecentTransactions rows={recentRows} categories={pickerOptions} />
      </section>
    ) : null;

  const sectionsById: Record<DashboardSectionId, { label: string; node: React.ReactNode }> = {
    hero: { label: "Net worth", node: heroSection },
    activity: { label: "Activity", node: activitySection },
    decisions: { label: "What this means", node: decisionsSection },
    accounts: { label: "Accounts", node: accountsSection },
    recent: { label: "Recent transactions", node: recentSection },
  };
  const sections = layout
    .map((id) => {
      const entry = sectionsById[id as DashboardSectionId];
      // Key each node before it crosses the RSC boundary as a list item. Without
      // a key, Flight serialization warns "a child was passed from DashboardPage"
      // for any section whose <section> wasn't statically key-validated — the hero
      // section, whose conditional visuals block defeats the jsxs static-children
      // marking, arrives at ArrangeableSections as an unkeyed list child.
      const node = isValidElement(entry.node) ? cloneElement(entry.node, { key: id }) : entry.node;
      return { id, label: entry.label, node };
    })
    .filter((s) => s.node !== null);

  return (
    <DashboardWindowProvider>
      <ArrangeableSections sections={sections} />
    </DashboardWindowProvider>
  );
}
