import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { holdingDetail } from "@/services/holding-detail";
import { HoldingChartPanel } from "@/components/investments/HoldingChartPanel";
import { HoldingEventsList } from "@/components/investments/HoldingEventsList";
import { PositionCard } from "@/components/investments/PositionCard";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Holding" };

const ASSET_LABEL: Record<string, string> = { stock: "Stock", etf: "ETF", crypto: "Crypto" };

export default async function HoldingPage({
  params,
}: {
  params: Promise<{ assetType: string; symbol: string }>;
}) {
  const { assetType, symbol } = await params;
  const db = getDb();
  const detail = (() => {
    try {
      return holdingDetail(db, assetType, decodeURIComponent(symbol).toUpperCase());
    } catch {
      notFound();
    }
  })();

  const today = todayIso();
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
            />
          ) : (
            <p className="py-6 text-sm text-ink-muted">
              A price chart appears once this holding has at least two days of cached prices.
            </p>
          )}
        </SurfaceCard>

        <PositionCard detail={detail} />
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
