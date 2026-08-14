import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/db/client";
import { replayFlows } from "@/lib/benchmark-replay";
import {
  DEFAULT_BENCHMARK,
  benchmarkLabel,
  isBenchmarkOff,
  resolveBenchmarkSymbol,
} from "@/lib/benchmark-symbol";
import { CHART_RANGES } from "@/lib/chart-range";
import { diffDays, monthKey, todayIso } from "@/lib/dates";
import { dayChangeLabel } from "@/lib/day-change-label";
import { formatDayLong, formatDayShort, formatMonthYear } from "@/lib/format-date";
import { benchmarkReturns } from "@/lib/portfolio-returns";
import { carryForwardTo } from "@/lib/price-series";
import { resolveViewState } from "@/lib/view-state";
import { listAccounts } from "@/services/accounts";
import { portfolioSession } from "@/services/intraday";
import { sessionView } from "@/lib/intraday-axis";
import { readSettings } from "@/services/settings";
import {
  allocationSlices,
  hasBenchmark,
  holdingRows,
  pnlCalendarMonth,
  portfolioBenchmarkDays,
  portfolioOverview,
  portfolioReturnDays,
  portfolioSeries,
  topMovers,
} from "@/services/portfolio";
import { SectionNotes } from "@/components/insights/SectionNotes";
import { holdingPriceSectionNotes } from "@/lib/section-notes";
import { AllocationDonut } from "@/components/investments/AllocationDonut";
import { HoldingActionsMenu } from "@/components/investments/HoldingActionsMenu";
import { RefreshPricesButton } from "@/components/investments/RefreshPricesButton";
import { PnlCalendar } from "@/components/investments/PnlCalendar";
import { PortfolioChartPanel } from "@/components/investments/PortfolioChartPanel";
import {
  INVESTMENTS_SURFACE,
  PORTFOLIO_VIEW_SPEC,
} from "@/components/investments/investments-view-spec";
import { PortfolioHoldingsTable } from "@/components/investments/PortfolioHoldingsTable";
import { PortfolioStats } from "@/components/investments/PortfolioStats";
import { TopMovers } from "@/components/investments/TopMovers";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const metadata: Metadata = { title: "Investments" };
export const dynamic = "force-dynamic";

const rangeSchema = z.enum(CHART_RANGES).catch("ALL");

export default async function InvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  // addHoldingAction is a `Promise<void>` form action, so its failures travel
  // back as ?error= (actions.ts:113). Unread, an add refused by validation — or
  // by a restore point that could not be written — was indistinguishable from
  // one that quietly did nothing. Rendered in BOTH page branches below (:94, :156)
  // so the message can never land on a branch that drops it.
  const error = errorParam(raw);
  const range = rangeSchema.parse(Array.isArray(raw.range) ? raw.range[0] : raw.range);
  const db = getDb();
  const settings = readSettings(db);
  // switchable-view state (NS#2 Pillar 2): URL > persisted preference > default.
  const portfolioView = resolveViewState(
    PORTFOLIO_VIEW_SPEC,
    {
      view: Array.isArray(raw.view) ? raw.view[0] : raw.view,
      unit: Array.isArray(raw.unit) ? raw.unit[0] : raw.unit,
      lens: Array.isArray(raw.lens) ? raw.lens[0] : raw.lens,
    },
    settings.viewPreferences[INVESTMENTS_SURFACE],
  );
  // the Return views' comparison benchmark (item 4): URL > persisted > SPY
  const benchmarkSymbol = resolveBenchmarkSymbol(
    Array.isArray(raw.bench) ? raw.bench[0] : raw.bench,
    settings.benchmarkSymbol,
  );
  // preserve a non-default range + benchmark across a view switch
  const viewBaseParams: Record<string, string> = {
    ...(range === "ALL" ? {} : { range }),
    ...(benchmarkSymbol === DEFAULT_BENCHMARK ? {} : { bench: benchmarkSymbol }),
  };
  const today = todayIso();
  const investmentAccounts = listAccounts(db).filter((a) => a.type === "investment" && a.isActive);

  if (investmentAccounts.length === 0) {
    return (
      <>
        <PageHeader
          title="Investments"
          description="Holdings, live prices, gain/loss, and allocation. Market value drives net worth; average cost is for P/L only."
        />
        {error && <ErrorBanner message={error} />}
        <EmptyState
          title="No investment accounts yet"
          description="Holdings attach to an investment account (brokerage or crypto). Add one under Accounts first — then enter positions here and refresh prices."
        />
        <p className="mt-4 text-sm">
          <Link
            href="/accounts"
            className="font-medium text-accent underline decoration-line underline-offset-4 transition-colors duration-(--duration-fast) hover:decoration-accent"
          >
            Go to Accounts →
          </Link>
        </p>
      </>
    );
  }

  const overview = portfolioOverview(db);
  // carry the value line forward to today (dashed tail) so the chart reaches the
  // present when prices haven't been refreshed since the last cached day; the
  // return/day-change math (overview, returnDays) stays on the real series.
  const points = carryForwardTo(
    portfolioSeries(db).map((p) => ({ day: p.day, valueCents: p.valueCents })),
    today,
  );
  const returnDays = portfolioReturnDays(db);
  // one aligned benchmark close series feeds both Return-view overlays: the
  // buy-and-hold % comparison and the "what if these flows bought SPY" replay.
  // Gated like the holding page: no overlays without a chartable return series.
  // `isBenchmarkOff` FIRST: "No comparison" has no price history, so hasBenchmark
  // would be false anyway — but short-circuiting here keeps the sentinel out of a
  // query that expects a real ticker, and states the intent instead of relying on
  // a lookup happening to miss.
  const benchDays =
    !isBenchmarkOff(benchmarkSymbol) && returnDays.length >= 2 && hasBenchmark(db, benchmarkSymbol)
      ? portfolioBenchmarkDays(db, returnDays.map((d) => d.day), benchmarkSymbol)
      : null;
  const benchmark = benchDays
    ? {
        label: benchmarkLabel(benchmarkSymbol),
        pct: benchmarkReturns(benchDays),
        replay: replayFlows(returnDays, benchDays),
      }
    : null;
  // ONE population feeds both the price-age note and the table that prints a
  // per-row date. They used to differ — the note filtered to live quantities
  // and the table did not — which meant a zero-quantity holding could print a
  // stale date on a row the note had never measured. (Measured inert today:
  // no active holding has a zero quantity in either the real or the seeded
  // database. Aligning them now is what keeps it inert.)
  const rows = holdingRows(db).filter((r) => r.quantityE8 > 0);
  // How old the closes behind every figure on this page are. Gated on the
  // NEWEST close, so it goes quiet as soon as any one symbol is refreshed —
  // the per-row dates in the holdings table are what survive that gate.
  const priceNotes = holdingPriceSectionNotes({
    rows,
    today,
    daysBetween: diffDays,
    formatDay: formatDayLong,
  });
  const movers = topMovers(db);
  const allocation = allocationSlices(db);
  const calendarMonth = pnlCalendarMonth(db, monthKey(overview.asOf ?? today), today);

  // Read unconditionally rather than behind a `range === "1D"` check: the pill
  // is client state, so gating on the URL would make a press to 1D need a
  // navigation. This is 1 + 2N indexed reads against a table pruned to two days,
  // on a page that already runs eight heavier queries.
  const intraday = portfolioSession(db, today);
  const session = sessionView(today, intraday.grid.points, intraday.priorCloseCents);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Investments"
          description={
            overview.asOf
              ? `Time-weighted return since ${overview.twrAnchor ? formatMonthYear(overview.twrAnchor) : "inception"}. Market value drives net worth; average cost is for P/L only.`
              : "Holdings, live prices, gain/loss, and allocation."
          }
        />
        {/* Refresh sits on the surface, not behind the ⋯ sheet. It was in there
            with the forms, two clicks deep, and the owner could not find it —
            "have a button i can press to refresh prices". Prices are the one
            thing on this page that goes stale on its own, so the control that
            un-stales them has to be visible without opening anything. */}
        <div className="flex items-center gap-2">
          <RefreshPricesButton />
          <HoldingActionsMenu
            accounts={investmentAccounts.map((a) => ({ id: a.id, name: a.name, subtype: a.subtype }))}
            defaultDate={today}
          />
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Mounted HERE, not inside PortfolioChartPanel: ChartFocus renders its
          panel twice (inline and in the focus dialog), so a note placed inside
          it would exist twice in the DOM. */}
      <SectionNotes notes={priceNotes} label="What this page noticed" />

      <div className="space-y-6">
        {/* the chart panel provides its own SurfaceCard (via ChartFocus) and
            renders the summary stats in its footer, so they show in both the
            inline card and the focus modal; the pre-chart fallback keeps a card */}
        {points.length >= 2 ? (
          <PortfolioChartPanel
            points={points}
            returnDays={returnDays}
            today={today}
            defaultRange={range}
            viewState={portfolioView}
            baseParams={viewBaseParams}
            benchmark={benchmark}
            benchmarkSymbol={benchmarkSymbol}
            footer={<PortfolioStats overview={overview} today={today} />}
            session={session}
            pricedSymbols={intraday.grid.pricedSymbols}
            totalSymbols={intraday.grid.totalSymbols}
          />
        ) : (
          <SurfaceCard>
            <p className="py-6 text-sm text-ink-muted">
              A portfolio chart appears once holdings have at least two days of cached prices.
            </p>
            <PortfolioStats overview={overview} today={today} />
          </SurfaceCard>
        )}

        {(movers.winners.length > 0 || movers.losers.length > 0) && (
          <SurfaceCard>
            <TopMovers winners={movers.winners} losers={movers.losers} />
          </SurfaceCard>
        )}

        {/* `*:min-w-0` is load-bearing (the dashboard's shrink guard, same
            token). A grid item's automatic minimum size is its MIN-CONTENT
            size, so below lg — where this collapses to one implicit column —
            the track sized itself to the holdings table and dragged the whole
            document sideways: +337px at 320, +217px on his phone. Zeroing it
            lets the track match the container and hands the scrolling back to
            the table's own overflow-x-auto, which is where a wide financial
            table belongs. The lg track already says minmax(0,…) for this
            reason; the mobile column had nothing saying it. */}
        <div className="grid gap-6 *:min-w-0 lg:grid-cols-[minmax(0,1fr)_280px]">
          <SurfaceCard>
            <h2 className="mb-4 text-sm font-medium">Holdings</h2>
            <PortfolioHoldingsTable
              rows={rows}
              dayChangeLabel={dayChangeLabel(overview.asOf, overview.dayChangeVsDay, today, formatDayShort).label}
              today={today}
            />
          </SurfaceCard>
          <SurfaceCard className="h-fit">
            <h2 className="mb-4 text-sm font-medium">Allocation</h2>
            <AllocationDonut slices={allocation.slices} totalCents={allocation.totalCents} />
          </SurfaceCard>
        </div>

        <section aria-labelledby="pnl-heading">
          <h2 id="pnl-heading" className="mb-3 text-sm font-medium">
            Profit &amp; loss calendar
          </h2>
          <PnlCalendar initialMonth={calendarMonth} today={today} />
        </section>
      </div>
    </>
  );
}
