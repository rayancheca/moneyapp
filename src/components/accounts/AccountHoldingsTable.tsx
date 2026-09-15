"use client";

import { useState } from "react";
import { PriceColumnHeader } from "@/components/investments/PriceColumnHeader";
import { DataTable, type Column, type SortState } from "@/components/ui/DataTable";
import { Money } from "@/components/ui/Money";
import { diffDays } from "@/lib/dates";
import { closesDayChange } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { priceColumnAge } from "@/lib/holding-price-age";
import { sharePercent } from "@/lib/insight-facts";
import { formatCents } from "@/lib/money";
import { formatQuantityE8, type AccountHoldingRow } from "@/services/holdings";

/**
 * An investment account's holdings on the shared DataTable (ux-overhaul-plan
 * §7.3): each row opens the aggregated holding page. Allocation is within THIS
 * account. Sortable by value; day change is colored semantically.
 *
 * Price age is disclosed here exactly as it is on /investments, from the same
 * `priceColumnAge` call — and it matters MORE here. /investments carries a
 * page-level note (`holdingPriceSectionNotes`) that this page does not have, so
 * until now every number in the Price, Day, Value, P/L and Alloc columns came
 * from a stored close with nothing anywhere on the page saying how old it was.
 * `AccountHoldingRow.quotedOn` was computed for every row (services/holdings.ts)
 * and dropped on the floor.
 *
 * 🔴 …and the Day column printed a move with no date. Measured on the real
 * ledger, Tue 2026-09-15: Robinhood Brokerage's nine rows read "+5.77%",
 * "+3.36%" … under a bare "Day", every one a move between Fri Sep 11's and Mon
 * Sep 14's closes, while COKE's own page dated the same +5.77% "Last close ·
 * Sep 14 vs Sep 11". The column now dates its moves the way the /investments
 * movers strip and holdings subtotal do — `closesDayChange` over the rows' own
 * two closes: once on the column when every row's move has one name, on each
 * row when they differ, and nothing new at all when that name is "Today".
 */

const ASSET_LABEL: Record<string, string> = { stock: "Stock", etf: "ETF", crypto: "Crypto" };

function pct(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneClass(cents: number | null): string {
  if (cents === null || cents === 0) return "text-ink-faint";
  return cents < 0 ? "text-negative" : "text-positive";
}

/**
 * The "Day" header, carrying the two closes when ONE pair names every row's
 * move — `PriceColumnHeader`'s idiom, inside the `<th>` so the pair joins the
 * column's accessible name. "Day" alone otherwise: a move that closed today
 * has nothing to add, and rows that differ each carry their own.
 */
function DayColumnHeader({ interval }: { interval: string | null }) {
  if (interval === null) return <>Day</>;
  return (
    <span className="inline-flex flex-col items-end">
      <span>Day</span>
      <span className="text-[10px] font-normal normal-case tracking-normal text-ink-faint">{interval}</span>
    </span>
  );
}

const SORTERS: Record<string, (a: AccountHoldingRow, b: AccountHoldingRow) => number> = {
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  value: (a, b) => (a.valueCents ?? -1) - (b.valueCents ?? -1),
  day: (a, b) => (a.dayChangePct ?? 0) - (b.dayChangePct ?? 0),
  alloc: (a, b) => (a.allocationPct ?? 0) - (b.allocationPct ?? 0),
};

export function AccountHoldingsTable({
  rows,
  today,
}: {
  rows: readonly AccountHoldingRow[];
  /** Today, from the SERVER — see PortfolioHoldingsTable for why never `new Date()` here. */
  today: string;
}) {
  const [sort, setSort] = useState<SortState>({ key: "value", dir: "desc" });

  const sorted = [...rows].sort((a, b) => {
    const cmp = (SORTERS[sort.key] ?? SORTERS.value)!(a, b);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const priceAge = priceColumnAge(rows, today, diffDays, formatDayShort);
  // WHEN each Day move happened, split the same way: on the column when one name
  // is true of every row, on each row when not. Keyed by holding rather than by
  // position, because the table sorts a copy.
  const dayDating = closesDayChange(rows, today, formatDayShort);
  const dayTermByHolding = new Map(rows.map((r, i) => [`${r.assetType}|${r.symbol}`, dayDating.terms[i] ?? null]));

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
      header: <PriceColumnHeader age={priceAge.header} />,
      align: "right",
      render: (r) => {
        if (r.latestClose === null) return <span className="text-ink-faint">—</span>;
        const age = priceAge.row(r.quotedOn);
        return (
          <span className="inline-flex flex-col items-end">
            <span className="figures">{formatCents(Math.round(r.latestClose * 100))}</span>
            {age !== null && (
              <span className="text-[11px] text-ink-faint" title={age.title}>
                {age.text}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "day",
      header: <DayColumnHeader interval={dayDating.heading.interval} />,
      align: "right",
      sortable: true,
      render: (r) => {
        const move = <span className={`figures text-xs ${toneClass(r.dayChangeCents)}`}>{pct(r.dayChangePct)}</span>;
        // null whenever the column already names this row's closes
        const term = dayTermByHolding.get(`${r.assetType}|${r.symbol}`) ?? null;
        if (term === null) return move;
        return (
          <span className="inline-flex flex-col items-end">
            {move}
            <span className="text-[11px] text-ink-faint">{term}</span>
          </span>
        );
      },
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
          {r.allocationPct !== null ? sharePercent(r.allocationPct) : "—"}
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
