/**
 * Pure geometry for the centre-rule deviation bar (Direction C).
 *
 * One question, asked plainly: WHAT MOVED. Every other view of spending answers
 * "how much" — the totals, the donut, the massif, the table. None of them puts
 * the month-over-month CHANGE on its own axis, so a category that quietly
 * doubled reads the same as one that held steady.
 *
 * The form is a single vertical rule with bars growing out of it: right when
 * more was spent than last period, left when less. The rule is zero, and zero
 * is the honest centre of a change chart — not the bottom of it. Rows are
 * ordered by the SIZE of the move, not by the amount spent, so the biggest
 * changes are the first thing read.
 *
 * No React, no DOM, no `Date`, no `Math.random` — same contract as the other
 * layout modules, so the visual baselines stay put.
 */

export interface DeviationInput {
  key: string;
  label: string;
  currentCents: number;
  previousCents: number;
  href?: string;
}

export interface DeviationBar {
  key: string;
  label: string;
  currentCents: number;
  previousCents: number;
  deltaCents: number;
  /** null when the category did not exist last period — a share is meaningless */
  deltaRatio: number | null;
  href?: string;
  /** true when MORE was spent than last period (bar grows right) */
  isIncrease: boolean;
  y: number;
  height: number;
  /** bar rect, already resolved to the correct side of the rule */
  x: number;
  width: number;
}

export interface DeviationLayout {
  width: number;
  height: number;
  /** x of the zero rule */
  centreX: number;
  labelWidth: number;
  bars: DeviationBar[];
  /** the largest absolute move, which sets the scale */
  peakCents: number;
  /**
   * How many categories MOVED, before the top-N cut — and how they split.
   *
   * ⛔ `bars.length` is what was DRAWN. Counting the drawn bars and calling them
   * the categories that moved is the defect this session kept finding: a count
   * taken from one collection standing over another.
   *
   * 🔴 Measured on the real ledger, `/spending?period=2026` against 2025: the
   * caption read "8 up · 0 down" and the accessible description read "8
   * categories moved against the previous period: 8 up, 0 down" — while TWENTY
   * moved, fifteen up and **five down**. A spending card said nothing had
   * fallen in a year when five things had, because all five were outside the
   * eight biggest moves.
   */
  movedCount: number;
  upCount: number;
  downCount: number;
}

export interface DeviationOptions {
  width: number;
  /** how many rows to draw; the rest are summarised by the caller */
  limit?: number;
  rowHeight?: number;
  rowGap?: number;
  labelWidth?: number;
  /** room right of the bars for the printed delta */
  valueWidth?: number;
}

const ROW_HEIGHT = 22;
const ROW_GAP = 8;
const LABEL_WIDTH = 132;
const VALUE_WIDTH = 92;
const MIN_BAR = 2;
const DEFAULT_LIMIT = 8;

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeDeviationLayout(
  rows: readonly DeviationInput[],
  options: DeviationOptions,
): DeviationLayout {
  const rowHeight = options.rowHeight ?? ROW_HEIGHT;
  const rowGap = options.rowGap ?? ROW_GAP;
  const labelWidth = options.labelWidth ?? LABEL_WIDTH;
  const valueWidth = options.valueWidth ?? VALUE_WIDTH;
  const limit = options.limit ?? DEFAULT_LIMIT;

  // Order by the SIZE of the move. A category that barely shifted is not news
  // however much it costs, which is exactly what every other spending view
  // already tells you.
  const moved = rows
    .map((r) => ({ ...r, deltaCents: r.currentCents - r.previousCents }))
    .filter((r) => r.deltaCents !== 0)
    .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || a.label.localeCompare(b.label));
  // counted BEFORE the cut — see `movedCount` on the layout
  const upCount = moved.filter((r) => r.deltaCents > 0).length;
  const ranked = moved.slice(0, limit);

  const peakCents = ranked.reduce((m, r) => Math.max(m, Math.abs(r.deltaCents)), 0);

  // The bar field is symmetric about the rule, so each side gets half.
  const field = Math.max(1, options.width - labelWidth - valueWidth);
  const half = field / 2;
  const centreX = r2(labelWidth + half);

  const bars: DeviationBar[] = ranked.map((r, i) => {
    const isIncrease = r.deltaCents > 0;
    // Linear, deliberately. Unlike the spine's stroke widths this axis IS the
    // quantity being compared — a sqrt here would flatter small moves and make
    // "twice as big a change" stop looking twice as big.
    /* v8 ignore next — the `: MIN_BAR` arm is unreachable, kept as a guard. This
       map only runs when `ranked` is non-empty, and `ranked` has already dropped
       every zero-delta row (:93), so peakCents is the max of a non-empty set of
       non-zero magnitudes and is always > 0. */
    const w = peakCents > 0 ? Math.max(MIN_BAR, (Math.abs(r.deltaCents) / peakCents) * half) : MIN_BAR;
    return {
      key: r.key,
      label: r.label,
      currentCents: r.currentCents,
      previousCents: r.previousCents,
      deltaCents: r.deltaCents,
      deltaRatio: r.previousCents > 0 ? r2(r.deltaCents / r.previousCents) : null,
      href: r.href,
      isIncrease,
      y: i * (rowHeight + rowGap),
      height: rowHeight,
      x: r2(isIncrease ? centreX : centreX - w),
      width: r2(w),
    };
  });

  const height = bars.length === 0 ? 0 : bars.length * (rowHeight + rowGap) - rowGap;

  return {
    width: options.width,
    height,
    centreX,
    labelWidth,
    bars,
    peakCents,
    movedCount: moved.length,
    upCount,
    downCount: moved.length - upCount,
  };
}

/** The chart's own summary sentence, used as the SVG description. */
export function deviationDescription(
  layout: DeviationLayout,
  fmt: (cents: number) => string,
): string {
  if (layout.bars.length === 0) return "Nothing changed against the previous period.";
  const biggest = layout.bars[0]!;
  // ⛔ the counts are of what MOVED, the "showing" clause is of what was DRAWN.
  // Saying only the second is how this described a year with five falls as
  // having none.
  const shown =
    layout.movedCount > layout.bars.length ? ` Showing the ${layout.bars.length} biggest.` : "";
  return (
    `${layout.movedCount} categories moved against the previous period: ` +
    `${layout.upCount} up, ${layout.downCount} down.${shown} ` +
    `The largest move is ${biggest.label}, ${biggest.isIncrease ? "up" : "down"} ` +
    `${fmt(Math.abs(biggest.deltaCents))}.`
  );
}
