import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents } from "@/lib/money";
import { RETURN_MEASURE } from "@/lib/return-measures";
import { formatQuantityE8 } from "@/services/holdings";
import type { HoldingDetail } from "@/services/holding-detail";
import type { Provenance } from "@/services/provenance";

/**
 * The position card (ux-overhaul-plan §6.4 [RH]): quantity, market value, avg
 * cost, today's return, what is held against what was paid, the money-weighted
 * rate, and portfolio diversity — aggregated across accounts, with a
 * per-account breakdown when the symbol is held in more than one.
 *
 * ⛔ None of those is "the total return", whatever this docstring used to call
 * the third one. `lib/return-measures` owns the words; see it for the day the
 * against-cost figure was labelled a total return on a page whose own header
 * read "-29.72% time-weighted".
 */

function pctText(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function toneClass(cents: number | null): string {
  if (cents === null || cents === 0) return "text-ink";
  return cents < 0 ? "text-negative" : "text-positive";
}

function Stat({
  label,
  provenance,
  hint,
  children,
}: {
  label: string;
  /** mounted beside the LABEL, never around the figure — see ProvenancePopover */
  provenance?: Provenance | null;
  /** the dated interval a figure was measured over, when it is not "today" */
  hint?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">
        {label}
        {provenance && <ProvenancePopover label={label.toLowerCase()} provenance={provenance} />}
      </dt>
      {/* 🔴 The hint lived HERE, as a third child beside the dt and the dd, and
          axe's `definition-list` rule (serious) forbids it: a `dl > div` may hold
          only properly-ordered dt/dd groups. It never fired because the only
          caller passing a hint — the day-change tile — passes null whenever the
          figure really is today's, which is what the e2e fixture has. Two more
          hints made it reachable and three specs went red at once.

          `PortfolioStats` had already learned this and says so in its own
          comment ("the anchor note lives inside the dd so each dl > div holds
          exactly a dt/dd pair"); this is the second card asking the question. */}
      <dd className="mt-1 text-sm font-medium">
        {children}
        {hint && <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">{hint}</span>}
      </dd>
    </div>
  );
}

export function PositionCard({ detail, provenance }: { detail: HoldingDetail; provenance?: Provenance | null }) {
  const { legs } = detail;
  return (
    <SurfaceCard>
      <h2 className="mb-4 text-sm font-medium">Your position</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Stat label="Quantity">
          <span className="figures">{formatQuantityE8(detail.quantityE8)}</span>
        </Stat>
        {/* the badge sits on MARKET VALUE and nowhere else on this card: it is
            the figure assembled from two different kinds of evidence — a share
            count the ledger can check and a price it cannot — and the others
            are either that figure restated or a plain input to it. */}
        <Stat label="Market value" provenance={provenance}>
          {detail.valueCents !== null ? <Money cents={detail.valueCents} /> : "—"}
        </Stat>
        <Stat label="Avg cost / share">
          {detail.avgCostCents !== null ? (
            <span className="figures">{formatCents(detail.avgCostCents)}</span>
          ) : (
            <span className="text-ink-faint">—</span>
          )}
        </Stat>
        {/* ⛔ The period is NAMED, never assumed. This figure is the move
            between the last two rows in `price_cache` and does not depend on
            the calendar at all; measured on the real ledger, 23 of 33 holding
            pages called it "Today" when it was not, the worst by 516 days.
            `dayChangeLabel` is the same rule the /investments header and the
            dashboard teaser already use. */}
        <Stat label={detail.todayReturnLabel} hint={detail.todayReturnInterval}>
          {detail.todayReturnCents !== null ? (
            <span className="flex items-baseline gap-1.5">
              <Money cents={detail.todayReturnCents} flow />
              <span className={`figures text-xs ${toneClass(detail.todayReturnCents)}`}>{pctText(detail.todayReturnPct)}</span>
            </span>
          ) : (
            "—"
          )}
        </Stat>
        {/* 🔴 This said "Total return", of a figure measured against COST — on a
            page whose own header prints a time-weighted return, and directly
            above "Money-weighted", as though the two were a pair. On
            /investments/crypto/ETH, 2026-09-04: a header reading
            "-29.72% time-weighted" over a tile reading "Total return +28.50%".
            /investments has called this one "Held, against what you paid" since
            the performance card shipped; `lib/return-measures` is now the one
            place both read it from. */}
        <Stat label={RETURN_MEASURE.unrealized.label} hint={RETURN_MEASURE.unrealized.meaning}>
          {detail.totalPlCents !== null ? (
            <span className="flex items-baseline gap-1.5">
              <Money cents={detail.totalPlCents} flow />
              <span className={`figures text-xs ${toneClass(detail.totalPlCents)}`}>{pctText(detail.totalPlPct)}</span>
            </span>
          ) : (
            /* 🔴 …and the tooltip under the fixed label still said it. "Add an
               average cost to see TOTAL RETURN" called the against-cost measure
               by the one name `lib/return-measures` exists to keep off it, one
               line below the label that had just been corrected — and the test
               that measure "can never be called a total return again" was about
               the label. Its two sibling tables say "P/L", the neutral word.

               ⚠️ And on a CLOSED position the advice cannot work: every one of
               the 24 zero-quantity holdings showed it, and no average cost will
               make a figure appear for positions you no longer hold. */
            <span
              className="text-ink-faint"
              title={
                detail.quantityE8 === 0
                  ? "Nothing held — this measures positions you still hold."
                  : "Add an average cost to see this."
              }
            >
              —
            </span>
          )}
        </Stat>
        <Stat label={RETURN_MEASURE.xirr.label} hint={`${RETURN_MEASURE.xirr.meaning} — a rate a year`}>
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
          <span className="figures">{detail.diversityDisplay ?? "—"}</span>
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
