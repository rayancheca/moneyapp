"use client";

import { useState } from "react";
import { DataTable, type Column, type SortState } from "@/components/ui/DataTable";
import { Money } from "@/components/ui/Money";
import { holdingMetricLabel, nextHoldingMetric, type HoldingMetric } from "@/lib/holding-cycle";
import { formatCents } from "@/lib/money";
import { formatQuantityE8 } from "@/services/holdings";
import type { HoldingRow } from "@/services/portfolio";
import { HoldingSparkline } from "./HoldingSparkline";

/**
 * The portfolio holdings table (ux-overhaul-plan §6.3): symbol + qty subtitle, a
 * day sparkline, price, and one day-change block that TAPS to cycle % → $ →
 * total P/L. Sortable; each row opens the aggregated holding page.
 */

const ASSET_LABEL: Record<string, string> = { stock: "Stock", etf: "ETF", crypto: "Crypto" };

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneClass(cents: number | null): string {
  if (cents === null) return "text-ink-faint";
  return cents < 0 ? "text-negative" : cents > 0 ? "text-positive" : "text-ink-faint";
}

const SORTERS: Record<string, (a: HoldingRow, b: HoldingRow) => number> = {
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  value: (a, b) => (a.valueCents ?? -1) - (b.valueCents ?? -1),
  day: (a, b) => (a.dayChangePct ?? 0) - (b.dayChangePct ?? 0),
  alloc: (a, b) => (a.allocationPct ?? 0) - (b.allocationPct ?? 0),
};

export function PortfolioHoldingsTable({ rows }: { rows: HoldingRow[] }) {
  const [metric, setMetric] = useState<HoldingMetric>("dayPct");
  const [sort, setSort] = useState<SortState>({ key: "value", dir: "desc" });

  const sorted = [...rows].sort((a, b) => {
    const cmp = (SORTERS[sort.key] ?? SORTERS.value)!(a, b);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  function metricCell(r: HoldingRow) {
    if (metric === "dayPct") {
      return <span className={`figures ${toneClass(r.dayChangeCents)}`}>{pct(r.dayChangePct)}</span>;
    }
    if (metric === "dayDollar") {
      return r.dayChangeCents !== null ? <Money cents={r.dayChangeCents} flow /> : <span className="text-ink-faint">—</span>;
    }
    return r.plCents !== null ? (
      <span className="inline-flex flex-col items-end">
        <Money cents={r.plCents} flow />
        <span className={`text-[11px] ${toneClass(r.plCents)}`}>{pct(r.plPct)}</span>
      </span>
    ) : (
      <span className="text-ink-faint" title="Add an average cost to see P/L">—</span>
    );
  }

  const columns: Column<HoldingRow>[] = [
    {
      key: "symbol",
      header: "Holding",
      sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <span className="font-medium">{r.symbol}</span>
          <span className="ml-2 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
            {ASSET_LABEL[r.assetType]}
          </span>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            {formatQuantityE8(r.quantityE8)} · {r.accountName}
          </div>
        </div>
      ),
    },
    {
      key: "spark",
      header: "30d",
      render: (r) => <HoldingSparkline values={r.sparkline} />,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      render: (r) =>
        r.latestClose !== null ? (
          <span className="figures text-ink-muted">{formatCents(Math.round(r.latestClose * 100))}</span>
        ) : (
          <span className="text-warning">no price</span>
        ),
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      sortable: true,
      render: (r) => (r.valueCents !== null ? <Money cents={r.valueCents} /> : <span>—</span>),
    },
    {
      key: "metric",
      align: "right",
      // header is the tap-to-cycle control, not a sort — cycling relabels the column
      header: (
        <button
          type="button"
          onClick={() => setMetric(nextHoldingMetric(metric))}
          aria-label={`Showing ${holdingMetricLabel(metric)}. Tap to cycle metric.`}
          className="inline-flex items-center gap-1 uppercase tracking-[0.08em] transition-colors duration-(--duration-fast) hover:text-ink"
        >
          {holdingMetricLabel(metric)}
          <span aria-hidden>⇄</span>
        </button>
      ),
      render: (r) => <span className="figures">{metricCell(r)}</span>,
    },
    {
      key: "alloc",
      header: "Alloc",
      align: "right",
      sortable: true,
      render: (r) => (
        <span className="figures text-ink-muted">{r.allocationPct !== null ? `${r.allocationPct.toFixed(1)}%` : "—"}</span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      rowKey={(r) => `${r.accountId}-${r.symbol}`}
      caption="Portfolio holdings with price, day change or profit and loss, and allocation"
      sort={sort}
      onSortChange={setSort}
      rowHref={(r) => `/investments/${r.assetType}/${r.symbol}`}
      emptyState="No holdings yet — add your first position with the ⋯ menu."
    />
  );
}
