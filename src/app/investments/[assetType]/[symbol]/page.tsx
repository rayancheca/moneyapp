import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { replayFlows } from "@/lib/benchmark-replay";
import {
  DEFAULT_BENCHMARK,
  benchmarkLabel,
  resolveBenchmarkSymbol,
} from "@/lib/benchmark-symbol";
import { todayIso } from "@/lib/dates";
import { benchmarkReturns } from "@/lib/portfolio-returns";
import { resolveViewState } from "@/lib/view-state";
import { holdingDetail } from "@/services/holding-detail";
import { hasBenchmark, portfolioBenchmarkDays } from "@/services/portfolio";
import { readSettings } from "@/services/settings";
import { HoldingChartPanel } from "@/components/investments/HoldingChartPanel";
import { HoldingEventsList } from "@/components/investments/HoldingEventsList";
import { PositionCard } from "@/components/investments/PositionCard";
import { RealizedSalesList } from "@/components/investments/RealizedSalesList";
import {
  HOLDING_SURFACE,
  HOLDING_VIEW_SPEC,
} from "@/components/investments/investments-view-spec";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Holding" };

const ASSET_LABEL: Record<string, string> = { stock: "Stock", etf: "ETF", crypto: "Crypto" };

export default async function HoldingPage({
  params,
  searchParams,
}: {
  params: Promise<{ assetType: string; symbol: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { assetType, symbol } = await params;
  const raw = await searchParams;
  const db = getDb();
  const today = todayIso();
  const detail = (() => {
    try {
      return holdingDetail(db, assetType, decodeURIComponent(symbol).toUpperCase(), today);
    } catch {
      notFound();
    }
  })();
  // switchable Price ⇄ Return view (URL > persisted > default), one preference
  // shared across every holding page (the "holding" surface)
  const settings = readSettings(db);
  const holdingView = resolveViewState(
    HOLDING_VIEW_SPEC,
    {
      view: Array.isArray(raw.view) ? raw.view[0] : raw.view,
      unit: Array.isArray(raw.unit) ? raw.unit[0] : raw.unit,
    },
    settings.viewPreferences[HOLDING_SURFACE],
  );
  // the comparison benchmark (item 4): URL > persisted > SPY
  const benchmarkSymbol = resolveBenchmarkSymbol(
    Array.isArray(raw.bench) ? raw.bench[0] : raw.bench,
    settings.benchmarkSymbol,
  );
  // Return-view overlays (only when the benchmark is priced): buy-and-hold %
  // comparison + "what if this holding's flows had bought it instead" replay
  const benchDays =
    detail.returnDays.length >= 2 && hasBenchmark(db, benchmarkSymbol)
      ? portfolioBenchmarkDays(db, detail.returnDays.map((d) => d.day), benchmarkSymbol)
      : null;
  const benchmark = benchDays
    ? {
        label: benchmarkLabel(benchmarkSymbol),
        pct: benchmarkReturns(benchDays),
        replay: replayFlows(detail.returnDays, benchDays),
      }
    : null;
  const marks = detail.marks
    .filter((m): m is typeof m & { closeCents: number } => m.closeCents !== null)
    .map((m) => ({ day: m.day, valueCents: m.closeCents, kind: m.kind }));

  return (
    <>
      <Breadcrumbs
        className="mb-3"
        items={[{ label: "Investments", href: "/investments" }, { label: detail.symbol }]}
      />
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.symbol}</h1>
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-ink-faint">
            {ASSET_LABEL[detail.assetType] ?? detail.assetType}
          </span>
        </div>
        {detail.name && <p className="mt-1 text-sm text-ink-muted">{detail.name}</p>}
      </header>

      <div className="space-y-6">
        <SurfaceCard>
          {detail.priceSeries.length >= 2 ? (
            <HoldingChartPanel
              priceSeries={detail.priceSeries}
              today={today}
              marks={marks}
              avgCostCents={detail.avgCostLineCents}
              symbol={detail.symbol}
              returnDays={detail.returnDays}
              viewState={holdingView}
              basePath={`/investments/${detail.assetType}/${encodeURIComponent(detail.symbol)}`}
              baseParams={
                benchmarkSymbol === DEFAULT_BENCHMARK ? {} : { bench: benchmarkSymbol }
              }
              benchmark={benchmark}
              benchmarkSymbol={benchmarkSymbol}
            />
          ) : (
            <p className="py-6 text-sm text-ink-muted">
              A price chart appears once this holding has at least two days of cached prices.
            </p>
          )}
        </SurfaceCard>

        <PositionCard detail={detail} />
        {detail.realized.sellCount > 0 && (
          <RealizedSalesList sales={detail.realizedSales} totals={detail.realized} />
        )}
        <HoldingEventsList
          events={detail.events}
          eventsTotal={detail.eventsTotal}
          allTradesHref={detail.allTradesHref}
        />

        <p className="text-sm">
          <Link
            href="/investments"
            className="font-medium text-accent underline decoration-line underline-offset-4 transition-colors duration-(--duration-fast) hover:decoration-accent"
          >
            ← All investments
          </Link>
        </p>
      </div>
    </>
  );
}
