import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/db/client";
import { CHART_RANGES } from "@/lib/chart-range";
import { monthKey, todayIso } from "@/lib/dates";
import { formatMonthYear } from "@/lib/format-date";
import { carryForwardTo } from "@/lib/price-series";
import { listAccounts } from "@/services/accounts";
import {
  allocationSlices,
  holdingRows,
  pnlCalendarMonth,
  portfolioOverview,
  portfolioReturnDays,
  portfolioSeries,
  topMovers,
} from "@/services/portfolio";
import { AllocationDonut } from "@/components/investments/AllocationDonut";
import { HoldingActionsMenu } from "@/components/investments/HoldingActionsMenu";
import { PnlCalendar } from "@/components/investments/PnlCalendar";
import { PortfolioChartPanel } from "@/components/investments/PortfolioChartPanel";
import { PortfolioHoldingsTable } from "@/components/investments/PortfolioHoldingsTable";
import { PortfolioStats } from "@/components/investments/PortfolioStats";
import { TopMovers } from "@/components/investments/TopMovers";
import { EmptyState } from "@/components/ui/EmptyState";
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
  const range = rangeSchema.parse(Array.isArray(raw.range) ? raw.range[0] : raw.range);
  const db = getDb();
  const today = todayIso();
  const investmentAccounts = listAccounts(db).filter((a) => a.type === "investment" && a.isActive);

  if (investmentAccounts.length === 0) {
    return (
      <>
        <PageHeader
          title="Investments"
          description="Holdings, live prices, gain/loss, and allocation. Market value drives net worth; average cost is for P/L only."
        />
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

      <div className="space-y-6">
        <SurfaceCard>
          {points.length >= 2 ? (
            <PortfolioChartPanel points={points} returnDays={returnDays} today={today} defaultRange={range} />
          ) : (
            <p className="py-6 text-sm text-ink-muted">
              A portfolio chart appears once holdings have at least two days of cached prices.
            </p>
          )}
          <PortfolioStats overview={overview} />
        </SurfaceCard>

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
