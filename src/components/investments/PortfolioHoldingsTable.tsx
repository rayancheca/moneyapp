"use client";

import { sharePercent } from "@/lib/insight-facts";
import { useRef, useState, type ReactNode } from "react";
import { DataTable, type Column, type SortState } from "@/components/ui/DataTable";
import { RULE_STRONG } from "@/components/ui/letterpress";
import { Money } from "@/components/ui/Money";
import { holdingMetricLabel, nextHoldingMetric, type HoldingMetric } from "@/lib/holding-cycle";
import {
  subtotalAnnouncement,
  subtotalCoverage,
  subtotalHoldings,
} from "@/lib/holding-subtotal";
import { diffDays } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { priceColumnAge } from "@/lib/holding-price-age";
import { PriceColumnHeader } from "./PriceColumnHeader";
import { formatCents } from "@/lib/money";
import { formatQuantityE8 } from "@/services/holdings";
import type { HoldingRow } from "@/services/portfolio";
import { HoldingSparkline } from "./HoldingSparkline";

/**
 * The portfolio holdings table (ux-overhaul-plan §6.3): symbol + qty subtitle, a
 * day sparkline, price, and one day-change block that TAPS to cycle % → $ →
 * total P/L. Sortable; each row opens the aggregated holding page.
 *
 * Rows are also TICKABLE, and ticking them prints what they add up to: value,
 * share of the portfolio, and today's move. The arithmetic lives in
 * lib/holding-subtotal.ts, which sums only the figures that exist and reports
 * how many rows fed each one — an unpriced holding is disclosed, never quietly
 * counted as zero.
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

/** One leg, not one symbol: the same symbol in two accounts is two rows. */
/**
 * The selection identity of one holding LEG.
 *
 * Keyed on account + symbol, not symbol alone: the same symbol held in two
 * accounts is two independent legs with two values and two allocation shares,
 * and collapsing them would make one checkbox tick both and halve the subtotal.
 * Exported so that property is pinned by a test rather than by inspection.
 */
export function holdingKey(r: Pick<HoldingRow, "accountId" | "symbol">): string {
  return `${r.accountId}-${r.symbol}`;
}

const NO_SELECTION: ReadonlySet<string> = new Set();

/** One figure in the subtotal line: a label, the number, and its caveat. */
function SubtotalStat({
  label,
  note,
  children,
}: {
  label: string;
  /** the coverage caveat, or null when every selected row fed this figure */
  note: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1.5 text-sm">
        {children}
        {note !== null && <span className="text-[11px] text-ink-faint">{note}</span>}
      </dd>
    </div>
  );
}

export function PortfolioHoldingsTable({
  rows,
  dayChangeLabel,
  today,
}: {
  rows: HoldingRow[];
  /**
   * What to call the day-change column of the subtotal bar — "Today" only when
   * the closes behind these rows are today's. Resolved by the page from
   * `dayChangeLabel`, so this bar, the header stat, and the price-age note all
   * agree about how old the numbers are.
   *
   * A bare label, never an interval: the selection can span holdings with
   * different `quotedOn` dates, so no single pair of days describes them all.
   */
  dayChangeLabel: string;
  /**
   * Today, from the SERVER. Never computed here: `MONEYAPP_FAKE_TODAY` pins the
   * server's clock and is not inlined into the client bundle, so a `new Date()`
   * in this component would disagree with what the server rendered and would
   * drift the e2e baselines with whatever day the machine thinks it is.
   * (src/lib/dates.ts states the same contract.)
   */
  today: string;
}) {
  const [metric, setMetric] = useState<HoldingMetric>("dayPct");
  const [sort, setSort] = useState<SortState>({ key: "value", dir: "desc" });
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(NO_SELECTION);
  /**
   * Announced INSTEAD of the subtotal once a selection goes back to empty.
   * `subtotalAnnouncement` is silent at zero, which is right on first paint —
   * but going from a full sentence to silence tells a screen-reader user
   * nothing, and clearing is exactly the moment they need confirming.
   */
  const [clearedNote, setClearedNote] = useState("");
  // the table's own select-all checkbox — where focus goes when the Clear
  // button removes itself from the document
  const tableRef = useRef<HTMLDivElement>(null);

  function changeSelection(next: ReadonlySet<string>): void {
    setClearedNote(next.size === 0 && selectedIds.size > 0 ? "Selection cleared." : "");
    setSelectedIds(next);
  }

  function clearSelection(): void {
    changeSelection(NO_SELECTION);
    // the button is about to unmount, so focus would fall to <body> and a
    // keyboard user would lose their place in the table entirely
    tableRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
  }

  const sorted = [...rows].sort((a, b) => {
    const cmp = (SORTERS[sort.key] ?? SORTERS.value)!(a, b);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  // Sorting and selection never touch each other: the sort re-orders a COPY,
  // and a selection id is content (account + symbol), so a re-sort moves ticked
  // rows around without dropping a tick. Read off `rows` rather than `sorted`
  // for the same reason — the subtotal is order-insensitive, and filtering here
  // means an id whose row is gone contributes nothing and is not counted.
  const selectedRows = rows.filter((r) => selectedIds.has(holdingKey(r)));
  const subtotal = subtotalHoldings(selectedRows);

  // WHERE price age gets stated — on the column when one close describes every
  // priced row, on the individual rows when they disagree. Both come from one
  // call so they can neither double up nor both fall silent.
  const priceAge = priceColumnAge(rows, today, diffDays, formatDayShort);

  function metricCell(r: HoldingRow) {
    if (metric === "dayPct") {
      return <span className={`figures ${toneClass(r.dayChangeCents)}`}>{pct(r.dayChangePct)}</span>;
    }
    if (metric === "dayDollar") {
      return r.dayChangeCents !== null ? <Money cents={r.dayChangeCents} flow /> : <span className="text-ink-faint">—</span>;
    }
    if (metric === "realized") {
      // avg-cost P/L locked in by this leg's sells, at daily closes; ≈ marks a
      // walk that skipped an unpriced trade
      return r.realizedCents !== null ? (
        <span className="inline-flex flex-col items-end">
          <Money cents={r.realizedCents} flow />
          <span
            className="text-[11px] text-ink-faint"
            title={
              r.realizedExact
                ? "Locked in by sells — estimated at daily closes"
                : "Estimated at daily closes — some trades lack a cached price or predate the recorded buys"
            }
          >
            {r.realizedExact ? "" : "≈ "}
            {r.realizedSellCount} sell{r.realizedSellCount === 1 ? "" : "s"}
          </span>
        </span>
      ) : (
        <span
          className="text-ink-faint"
          title={
            r.realizedExact
              ? "No sells yet — realized P/L appears after a sale"
              : "Realized P/L unavailable — recorded sells predate their buys or lack a cached price"
          }
        >
          —
        </span>
      );
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
      header: <PriceColumnHeader age={priceAge.header} />,
      align: "right",
      render: (r) => {
        if (r.latestClose === null) return <span className="text-warning">no price</span>;
        // Only when the header cannot speak for this row — i.e. the rows
        // disagree about their closes, which is exactly the case the page note
        // above cannot describe (it is gated on the NEWEST close, so one
        // freshly-priced symbol silences it while everything else is a week old).
        const age = priceAge.row(r.quotedOn);
        return (
          <span className="inline-flex flex-col items-end">
            <span className="figures text-ink-muted">
              {formatCents(Math.round(r.latestClose * 100))}
            </span>
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
        <span className="figures text-ink-muted">{r.allocationPct !== null ? sharePercent(r.allocationPct) : "—"}</span>
      ),
    },
  ];

  return (
    <>
      <div ref={tableRef}>
        <DataTable
          columns={columns}
          rows={sorted}
          rowKey={holdingKey}
          caption="Portfolio holdings with price, day change, unrealized or realized profit and loss, and allocation"
          sort={sort}
          onSortChange={setSort}
          selectable
          // the account is part of the name because it is part of the row: two
          // accounts can hold the same symbol, and "Select AAPL" twice is two
          // indistinguishable checkboxes
          rowLabel={(r) => `${r.symbol} in ${r.accountName}`}
          selectedIds={selectedIds}
          onSelectedIdsChange={changeSelection}
          rowHref={(r) => `/investments/${r.assetType}/${r.symbol}`}
          emptyState="No holdings yet — add your first position with the ⋯ menu."
        />
      </div>

      {/* The total line, closed by the strong rule the way a printed ledger
          closes one. Below the table, so ticking a row never shifts the rows
          being ticked. */}
      {subtotal.selected > 0 && (
        <div
          className={`mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pt-3 ${RULE_STRONG}`}
        >
          <dl className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <SubtotalStat label="Selected" note={null}>
              <span className="figures font-medium">{subtotal.selected}</span>
              <span className="text-[11px] text-ink-faint">
                holding{subtotal.selected === 1 ? "" : "s"}
              </span>
            </SubtotalStat>
            <SubtotalStat
              label="Value"
              note={subtotalCoverage(subtotal.valueCents, subtotal.selected, "priced")}
            >
              {subtotal.valueCents.total !== null ? (
                <Money cents={subtotal.valueCents.total} className="font-medium" />
              ) : (
                // the same word the Price column uses for a symbol with no close
                <span className="text-warning">no price</span>
              )}
            </SubtotalStat>
            <SubtotalStat
              label="Share"
              note={subtotalCoverage(subtotal.allocationPct, subtotal.selected, "with a share")}
            >
              <span className="figures font-medium text-ink-muted">
                {/* the sum of the Alloc cells ticked, as they print — `subtotalHoldings` */}
                {subtotal.allocationShare ?? "—"}
              </span>
            </SubtotalStat>
            <SubtotalStat
              label={dayChangeLabel}
              note={subtotalCoverage(subtotal.dayChangeCents, subtotal.selected, "with a day change")}
            >
              {subtotal.dayChangeCents.total !== null ? (
                <Money cents={subtotal.dayChangeCents.total} flow className="font-medium" />
              ) : (
                <span className="text-ink-faint">—</span>
              )}
            </SubtotalStat>
          </dl>
          <button
            type="button"
            onClick={clearSelection}
            className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Always mounted so the region exists before it has anything to say —
          a live region created in the same tick as its text is not reliably
          announced. Same idiom as the palette's result count. */}
      <div aria-live="polite" className="sr-only">
        {subtotal.selected > 0 ? subtotalAnnouncement(subtotal, dayChangeLabel.toLowerCase()) : clearedNote}
      </div>
    </>
  );
}
