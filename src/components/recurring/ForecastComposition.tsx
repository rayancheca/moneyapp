import { Money } from "@/components/ui/Money";
import type { ForecastSplit, ForecastSplitSide } from "@/lib/forecast-split";
import { stalePartLabel } from "./labels";

/**
 * What the two headline figures are MADE OF — committed bills against a
 * trailing pace, scheduled deposits against a trailing pace.
 *
 * The card published "$11,765.34" and the owner read it against an expectation
 * of "3-5k" and concluded the app disagreed with him. It did not: $3,567.60 of
 * that is rent, fees, the lease, insurance, the gym, FPL and the internet, and
 * $8,197.74 is his own last three months extrapolated. Both numbers were always
 * in `f.components`; nothing on the card added them up.
 *
 * ## Why a band rather than two more tiles
 *
 * Seven tiles is a wall, and the split is not a seventh headline — it is the
 * composition of two figures that are already there. Sitting the band directly
 * beneath the row keeps the tiles as the answer and makes this the working. It
 * also puts money in and money out on the SAME picture, which is the only way
 * the asymmetry shows: September's spending is 30% committed, its income is
 * 98.9% one series that has not deposited since June.
 *
 * ⚠️ The bar is `aria-hidden`. It encodes nothing the labels beneath it do not
 * state in words and figures, which is also why colour is safe here — it is
 * redundant, never the only channel.
 */

interface SideSpec {
  /** the reader's word for the direction, not the sign */
  title: string;
  /** what a recurring series means on this side */
  fixedLabel: string;
  variableLabel: string;
  /** solid segment (fixed) and soft segment (variable) */
  fixedFill: string;
  variableFill: string;
}

const MONEY_IN: SideSpec = {
  title: "Money in",
  fixedLabel: "Scheduled",
  variableLabel: "Recent pace",
  fixedFill: "bg-positive",
  variableFill: "bg-positive-soft",
};

const MONEY_OUT: SideSpec = {
  title: "Money out",
  fixedLabel: "Committed",
  variableLabel: "Recent pace",
  fixedFill: "bg-negative",
  variableFill: "bg-negative-soft",
};

function Part({
  swatch,
  label,
  cents,
  count,
}: {
  swatch: string;
  label: string;
  cents: number;
  count: number;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 translate-y-[-1px] rounded-[2px] ${swatch}`}
      />
      <span className="text-ink-muted">{label}</span>
      {/* magnitude, not the signed figure: the direction is the row's title,
          and a "-$8,197.74" under a heading that already says "Money out"
          reads as a refund rather than as spending */}
      <Money cents={Math.abs(cents)} className="text-ink" />
      <span className="text-ink-faint">
        ({count} {count === 1 ? "line" : "lines"})
      </span>
    </span>
  );
}

function Side({ spec, side }: { spec: SideSpec; side: ForecastSplitSide }) {
  const stale = stalePartLabel(side);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
          {spec.title}
        </h3>
        {stale && (
          <span className="text-[11px] text-warning" title="see “running late”, below">
            {stale}
          </span>
        )}
      </div>

      {/*
        A composition bar, not a progress bar: the track is fully spoken for by
        the two segments, so an empty side must draw NOTHING rather than an
        empty track. `fixedShare === null` is exactly that state, and it is why
        the split reports null there instead of zero — "nothing is projected"
        and "none of what is projected is committed" would otherwise render
        identically.
      */}
      <div aria-hidden="true" className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
        {side.fixedShare !== null && (
          <>
            <span
              className={spec.fixedFill}
              style={{ width: `${(side.fixedShare * 100).toFixed(2)}%` }}
            />
            <span className={`flex-1 ${spec.variableFill}`} />
          </>
        )}
      </div>

      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Part
          swatch={spec.fixedFill}
          label={spec.fixedLabel}
          cents={side.fixedCents}
          count={side.fixedCount}
        />
        <Part
          swatch={spec.variableFill}
          label={spec.variableLabel}
          cents={side.variableCents}
          count={side.variableCount}
        />
      </p>
    </div>
  );
}

export function ForecastComposition({ split }: { split: ForecastSplit }) {
  /*
   * A month with nothing projected at all gets no band. Two empty tracks and
   * four "$0.00 (0 lines)" labels would be a composition of nothing, presented
   * with the confidence of a measurement.
   */
  if (split.income.fixedShare === null && split.spending.fixedShare === null) return null;

  return (
    <div className="mt-6 grid gap-5 border-t border-line pt-5 md:grid-cols-2 md:gap-8">
      <Side spec={MONEY_IN} side={split.income} />
      <Side spec={MONEY_OUT} side={split.spending} />
    </div>
  );
}
