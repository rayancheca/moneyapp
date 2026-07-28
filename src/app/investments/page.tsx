import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/db/client";
import { replayFlows } from "@/lib/benchmark-replay";
import {
  DEFAULT_BENCHMARK,
  benchmarkLabel,
  resolveBenchmarkSymbol,
} from "@/lib/benchmark-symbol";
import { CHART_RANGES } from "@/lib/chart-range";
import { monthKey, todayIso } from "@/lib/dates";
import { formatMonthYear } from "@/lib/format-date";
import { benchmarkReturns } from "@/lib/portfolio-returns";
import { carryForwardTo } from "@/lib/price-series";
import { resolveViewState } from "@/lib/view-state";
import { listAccounts } from "@/services/accounts";
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
import { AllocationDonut } from "@/components/investments/AllocationDonut";
import { HoldingActionsMenu } from "@/components/investments/HoldingActionsMenu";
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
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const metadata: Metadata = { title: "Investments" };
export const dynamic = "force-dynamic";

const rangeSchema = z.enum(CHART_RANGES).catch("ALL");

/**
 * The ?error= banner (the /budgets pattern). Rendered in BOTH page branches so
 * the message can never land on a branch that drops it — including the
 * pre-mutation snapshot's "Could not save a restore point, so nothing was
 * changed", which unread renders as complete silence.
 */
function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-6 rounded-(--radius-card) border border-negative/40 bg-surface-raised px-4 py-3 text-sm text-negative"
    >
      {message}
    </div>
  );
}

export default async function InvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  // addHoldingAction is a `Promise<void>` form action, so its failures travel
  // back as ?error= (actions.ts:113). Unread, an add refused by validation — or
  // by a restore point that could not be written — was indistinguishable from
  // one that quietly did nothing.
  const error = typeof raw.error === "string" ? raw.error : null;
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
  const benchDays =
    returnDays.length >= 2 && hasBenchmark(db, benchmarkSymbol)
      ? portfolioBenchmarkDays(db, returnDays.map((d) => d.day), benchmarkSymbol)
      : null;
  const benchmark = benchDays
    ? {
        label: benchmarkLabel(benchmarkSymbol),
        pct: benchmarkReturns(benchDays),
        replay: replayFlows(returnDays, benchDays),
      }
    : null;
  const rows = holdingRows(db);
  const movers = topMovers(db);
  const allocation = allocationSlices(db);
  const calendarMonth = pnlCalendarMonth(db, monthKey(overview.asOf ?? today), today);

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
        <HoldingActionsMenu
          accounts={investmentAccounts.map((a) => ({ id: a.id, name: a.name, subtype: a.subtype }))}
          defaultDate={today}
        />
      </div>

      {error && <ErrorBanner message={error} />}

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
            footer={<PortfolioStats overview={overview} />}
          />
        ) : (
          <SurfaceCard>
            <p className="py-6 text-sm text-ink-muted">
              A portfolio chart appears once holdings have at least two days of cached prices.
            </p>
            <PortfolioStats overview={overview} />
          </SurfaceCard>
        )}

        {(movers.winners.length > 0 || movers.losers.length > 0) && (
          <SurfaceCard>
            <TopMovers winners={movers.winners} losers={movers.losers} />
          </SurfaceCard>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <SurfaceCard>
            <h2 className="mb-4 text-sm font-medium">Holdings</h2>
            <PortfolioHoldingsTable rows={rows} />
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
