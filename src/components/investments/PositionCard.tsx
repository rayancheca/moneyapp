import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents } from "@/lib/money";
import { formatQuantityE8 } from "@/services/holdings";
import type { HoldingDetail } from "@/services/holding-detail";

/**
 * The position card (ux-overhaul-plan §6.4 [RH]): quantity, market value, avg
 * cost, today's return, total return, and portfolio diversity — aggregated
 * across accounts, with a per-account breakdown when the symbol is held in more
 * than one.
 */

function pctText(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function toneClass(cents: number | null): string {
  if (cents === null || cents === 0) return "text-ink";
  return cents < 0 ? "text-negative" : "text-positive";
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{children}</dd>
    </div>
  );
}

export function PositionCard({ detail }: { detail: HoldingDetail }) {
  const { legs } = detail;
  return (
    <SurfaceCard>
      <h2 className="mb-4 text-sm font-medium">Your position</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Stat label="Quantity">
          <span className="figures">{formatQuantityE8(detail.quantityE8)}</span>
        </Stat>
        <Stat label="Market value">{detail.valueCents !== null ? <Money cents={detail.valueCents} /> : "—"}</Stat>
        <Stat label="Avg cost / share">
          {detail.avgCostCents !== null ? (
            <span className="figures">{formatCents(detail.avgCostCents)}</span>
          ) : (
            <span className="text-ink-faint">—</span>
          )}
        </Stat>
        <Stat label="Today">
          {detail.todayReturnCents !== null ? (
            <span className="flex items-baseline gap-1.5">
              <Money cents={detail.todayReturnCents} flow />
              <span className={`figures text-xs ${toneClass(detail.todayReturnCents)}`}>{pctText(detail.todayReturnPct)}</span>
            </span>
          ) : (
            "—"
          )}
        </Stat>
        <Stat label="Total return">
          {detail.totalPlCents !== null ? (
            <span className="flex items-baseline gap-1.5">
              <Money cents={detail.totalPlCents} flow />
              <span className={`figures text-xs ${toneClass(detail.totalPlCents)}`}>{pctText(detail.totalPlPct)}</span>
            </span>
          ) : (
            <span className="text-ink-faint" title="Add an average cost to see total return">—</span>
          )}
        </Stat>
        <Stat label="Money-weighted">
          {detail.xirrPct !== null ? (
            <span className="flex items-baseline gap-1.5" title="XIRR — the annualized growth rate of your dollars in this holding">
              <span className={`figures ${toneClass(detail.xirrPct)}`}>{pctText(detail.xirrPct)}</span>
              {!detail.xirrExact && (
                <span className="text-[11px] text-ink-faint" title="A crypto flow feeds this — not separable to the cent">
                  ≈
                </span>
              )}
            </span>
          ) : (
            <span className="text-ink-faint">—</span>
          )}
        </Stat>
        <Stat label="Portfolio diversity">
          <span className="figures">{detail.diversityPct !== null ? `${detail.diversityPct.toFixed(1)}%` : "—"}</span>
        </Stat>
      </dl>

      {legs.length > 1 && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">By account</h3>
          <ul className="divide-y divide-line">
            {legs.map((leg) => (
              <li key={leg.accountId} className="flex items-center justify-between py-2 text-sm">
                <span className="min-w-0 truncate">
                  {leg.accountName}
                  <span className="ml-2 figures text-xs text-ink-faint">{formatQuantityE8(leg.quantityE8)}</span>
                </span>
                {leg.valueCents !== null ? <Money cents={leg.valueCents} className="shrink-0" /> : "—"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SurfaceCard>
  );
}
