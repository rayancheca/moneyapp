import { Money } from "@/components/ui/Money";
import { formatCents } from "@/lib/money";
import { formatQuantityE8, type Portfolio } from "@/services/holdings";

const ASSET_LABEL: Record<string, string> = {
  stock: "Stock",
  etf: "ETF",
  crypto: "Crypto",
};

function formatPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

const NUM_CELL = "figures px-3 py-2.5 text-right align-baseline";

/** Data-dense Ledger table: symbol · qty · price · value · P/L · allocation. */
export function HoldingsTable({ portfolio }: { portfolio: Portfolio }) {
  const { rows, totals } = portfolio;

  if (rows.length === 0) {
    return (
      <p className="py-6 text-sm text-ink-muted">
        No holdings yet — add your first position below and refresh prices.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <caption className="sr-only">
          Portfolio holdings with latest prices, market value, profit and loss, and allocation
        </caption>
        <thead>
          <tr className="border-b border-line text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            <th scope="col" className="px-3 py-2 text-left">
              Holding
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Quantity
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Price
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Value
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              P/L
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Alloc
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.accountId}-${r.symbol}`}
              className="border-b border-line transition-colors duration-(--duration-fast) last:border-b-0 hover:bg-surface-sunken/60"
            >
              <th scope="row" className="px-3 py-2.5 text-left font-normal">
                <span className="font-medium">{r.symbol}</span>
                <span className="ml-2 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
                  {ASSET_LABEL[r.assetType]}
                </span>
                <div className="mt-0.5 text-[11px] text-ink-faint">{r.accountName}</div>
              </th>
              <td className={NUM_CELL}>{formatQuantityE8(r.quantityE8)}</td>
              <td className={`${NUM_CELL} text-ink-muted`}>
                {r.latestClose !== null ? (
                  formatCents(Math.round(r.latestClose * 100))
                ) : (
                  <span className="text-warning">no price</span>
                )}
              </td>
              <td className={NUM_CELL}>
                {r.valueCents !== null ? <Money cents={r.valueCents} /> : "—"}
              </td>
              <td className={NUM_CELL}>
                {r.plCents !== null ? (
                  <>
                    <Money cents={r.plCents} flow />
                    <div
                      className={`text-[11px] ${r.plCents < 0 ? "text-negative" : r.plCents > 0 ? "text-positive" : "text-ink-faint"}`}
                    >
                      {formatPct(r.plPct)}
                    </div>
                  </>
                ) : (
                  <span className="text-ink-faint" title="Add an average cost to see P/L">
                    —
                  </span>
                )}
              </td>
              <td className={`${NUM_CELL} text-ink-muted`}>
                {r.allocationPct !== null ? `${r.allocationPct.toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-strong text-sm font-medium">
            <th scope="row" className="px-3 py-3 text-left">
              Total
            </th>
            <td />
            <td />
            <td className={NUM_CELL}>
              <Money cents={totals.valueCents} />
            </td>
            <td className={NUM_CELL}>
              {totals.plCents !== null ? (
                <>
                  <Money cents={totals.plCents} flow />
                  <div
                    className={`text-[11px] font-normal ${totals.plCents < 0 ? "text-negative" : totals.plCents > 0 ? "text-positive" : "text-ink-faint"}`}
                  >
                    {formatPct(totals.plPct)}
                  </div>
                </>
              ) : (
                "—"
              )}
            </td>
            <td className={`${NUM_CELL} text-ink-muted`}>100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
