"use client";

import { useState } from "react";
import { DataTable, type Column, type SortState } from "@/components/ui/DataTable";
import { Money } from "@/components/ui/Money";
import { formatCents } from "@/lib/money";
import { formatQuantityE8, type AccountHoldingRow } from "@/services/holdings";

/**
 * An investment account's holdings on the shared DataTable (ux-overhaul-plan
 * §7.3): each row opens the aggregated holding page. Allocation is within THIS
 * account. Sortable by value; day change is colored semantically.
 */

const ASSET_LABEL: Record<string, string> = { stock: "Stock", etf: "ETF", crypto: "Crypto" };

function pct(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneClass(cents: number | null): string {
  if (cents === null || cents === 0) return "text-ink-faint";
  return cents < 0 ? "text-negative" : "text-positive";
}

const SORTERS: Record<string, (a: AccountHoldingRow, b: AccountHoldingRow) => number> = {
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  value: (a, b) => (a.valueCents ?? -1) - (b.valueCents ?? -1),
  day: (a, b) => (a.dayChangePct ?? 0) - (b.dayChangePct ?? 0),
  alloc: (a, b) => (a.allocationPct ?? 0) - (b.allocationPct ?? 0),
};

export function AccountHoldingsTable({ rows }: { rows: readonly AccountHoldingRow[] }) {
  const [sort, setSort] = useState<SortState>({ key: "value", dir: "desc" });

  const sorted = [...rows].sort((a, b) => {
    const cmp = (SORTERS[sort.key] ?? SORTERS.value)!(a, b);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const columns: Column<AccountHoldingRow>[] = [
    {
      key: "symbol",
      header: "Holding",
      sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <span className="font-medium">{r.symbol}</span>
          <span className="ml-2 text-[11px] text-ink-faint">{ASSET_LABEL[r.assetType] ?? r.assetType}</span>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      align: "right",
      render: (r) => <span className="figures">{formatQuantityE8(r.quantityE8)}</span>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      render: (r) =>
        r.latestClose !== null ? (
          <span className="figures">{formatCents(Math.round(r.latestClose * 100))}</span>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    {
      key: "day",
      header: "Day",
      align: "right",
      sortable: true,
      render: (r) => <span className={`figures text-xs ${toneClass(r.dayChangeCents)}`}>{pct(r.dayChangePct)}</span>,
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      sortable: true,
      render: (r) => (r.valueCents !== null ? <Money cents={r.valueCents} /> : <span className="text-ink-faint">—</span>),
    },
    {
      key: "pl",
      header: "P/L",
      align: "right",
      render: (r) =>
        r.plCents !== null ? (
          <span className="inline-flex flex-col items-end">
            <Money cents={r.plCents} flow className="text-xs" />
            <span className={`text-[10px] ${toneClass(r.plCents)}`}>{pct(r.plPct)}</span>
          </span>
        ) : (
          <span className="text-ink-faint" title="Add an average cost to see P/L">
            —
          </span>
        ),
    },
    {
      key: "alloc",
      header: "Alloc",
      align: "right",
      sortable: true,
      render: (r) => (
        <span className="figures text-xs text-ink-muted">
          {r.allocationPct !== null ? `${r.allocationPct.toFixed(1)}%` : "—"}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      rowKey={(r) => `${r.assetType}-${r.symbol}`}
      caption="Holdings in this account"
      sort={sort}
      onSortChange={setSort}
      rowHref={(r) => `/investments/${r.assetType}/${r.symbol}`}
    />
  );
}
