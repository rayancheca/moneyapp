import { Fragment } from "react";
import { Money } from "@/components/ui/Money";
import type { ForecastSplit, ForecastSplitSide } from "@/lib/forecast-split";
import { seriesEvidenceTone } from "@/lib/series-evidence";
import { staleFooterWord, staleParts } from "./labels";

/** A part's tone, as the chips and the series page's badge wear it (`seriesEvidenceTone`). */
const PART_TONE_CLASS: Record<ReturnType<typeof seriesEvidenceTone>, string> = {
  warning: "text-warning",
  neutral: "text-ink-muted",
};

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

/** The pace part of a side whose pace stands on no month: its label and a dash, never "$0.00 (0 lines)". */
function WithheldPart({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 translate-y-[-1px] rounded-[2px] ${swatch}`} />
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink-faint">—</span>
    </span>
  );
}

function Side({
  spec,
  side,
  paceWithheld = false,
}: {
  spec: SideSpec;
  side: ForecastSplitSide;
  /** no month was read in full to average this side's pace over (`ForecastComposition`'s `spendPaceWithheld`) */
  paceWithheld?: boolean;
}) {
  const parts = staleParts(side);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
          {spec.title}
        </h3>
        {/* ⛔ Each part in its own word's tone, pointing at the footer's word for it: late money warns, never-billed
            money is quiet — the chips' and the series page's badge's tone (`seriesEvidenceTone`). 🔴 The whole label
            wore amber under 'see "running late", below': "$468.86 of it never billed" over October's money out on
            his ledger copy at today = 2026-10-12, with nothing running late in the footer (review of 481e357). */}
        {parts.length > 0 && (
          <span className="text-[11px] text-ink-faint">
            {parts.map((p, i) => (
              <Fragment key={p.evidence}>
                {i > 0 ? " · " : null}
                <span
                  className={PART_TONE_CLASS[seriesEvidenceTone(p.evidence)]}
                  title={`see “${staleFooterWord(p.evidence)}”, below`}
                >
                  {p.text}
                </span>
              </Fragment>
            ))}
          </span>
        )}
      </div>

      {/*
        A composition bar, not a progress bar: the track is fully spoken for by
        the two segments, so an empty side must draw NOTHING rather than an
        empty track. `fixedShare === null` is exactly that state, and it is why
        the split reports null there instead of zero — "nothing is projected"
        and "none of what is projected is committed" would otherwise render
        identically. A withheld pace is the same state for the same reason: with
        one half unknown, "100% committed" would say nothing discretionary is
        coming.
      */}
      <div aria-hidden="true" className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
        {side.fixedShare !== null && !paceWithheld && (
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
        {paceWithheld ? (
          <WithheldPart swatch={spec.variableFill} label={spec.variableLabel} />
        ) : (
          <Part
            swatch={spec.variableFill}
            label={spec.variableLabel}
            cents={side.variableCents}
            count={side.variableCount}
          />
        )}
      </p>
    </div>
  );
}

export function ForecastComposition({
  split,
  spendPaceWithheld = false,
}: {
  split: ForecastSplit;
  /**
   * No month since the ledger's first whole one is read in full, so there is no spending pace at all — the card's
   * one predicate for it (`spendPaceWithheld`), which holds the pace row back too.
   */
  spendPaceWithheld?: boolean;
}) {
  /*
   * A month with nothing projected at all gets no band. Two empty tracks and
   * four "$0.00 (0 lines)" labels would be a composition of nothing, presented
   * with the confidence of a measurement.
   */
  if (split.income.fixedShare === null && split.spending.fixedShare === null) return null;

  /*
   * ⛔ A PACE OF NO MONTH IS NOT A PACE OF NOTHING, here as on the pace row beneath. Money out's "Recent pace" is the
   * spending pace that row withholds, so it reads "—" and its bar draws no share. 🔴 Review of 06a5d3e: the fix held
   * back the row alone, and on a young ledger whose one card was read only to Jun 12 this band read "Money out ·
   * Committed $1,500.00 (1 line) · Recent pace $0.00 (0 lines)", drawn 100% committed, directly above the row's
   * sentence saying there is no spending average to stand on.
   * ⚖️ Money in's pace prints: the income pace is not cut by the spending frontier (his decision 71, 2026-10-13) and
   * is measured over its own floored months (`incomePaceMonths`), as "Show the math" prints it below.
   */
  return (
    <div className="mt-6 grid gap-5 border-t border-line pt-5 md:grid-cols-2 md:gap-8">
      <Side spec={MONEY_IN} side={split.income} />
      <Side spec={MONEY_OUT} side={split.spending} paceWithheld={spendPaceWithheld} />
    </div>
  );
}
