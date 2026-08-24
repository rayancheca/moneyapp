/**
 * Pure geometry for the net-worth bridge — a waterfall whose parts visibly add
 * up to the whole.
 *
 * One question: net worth moved from X to Y, and WHY. Every other view answers
 * "how much" — the hero, the curve, the account list. None of them puts the
 * CHANGE on its own axis and decomposes it, so a month where the market did all
 * the work looks exactly like one where the owner did.
 *
 * No React, no DOM, no `Date`, no `Math.random` — the same contract as the other
 * layout modules, so the Playwright baselines stay byte-stable.
 *
 * ## Two decisions that are not obvious, both forced by measurement
 *
 * **The axis is the excursion, not zero.** The real July–August window runs
 * $82,897.66 → $109,322.37. Anchored at zero, the whole bridge is a band across
 * the top of the canvas and `earned` — $52.95 — is 0.05% of the height. So the
 * axis spans the running totals, and `axisStartsAtZero` says so out loud, because
 * an axis that quietly omits zero is exactly the kind of true-but-unreadable
 * thing this app has been caught by before (the pace chart's ceiling, pinned by
 * arithmetic and flat by construction).
 *
 * **A band too small to draw is MARKED, never floored.** `deviation-layout` gives
 * sub-pixel bars a 2px minimum and that is right for it — those bars need not sum
 * to anything. Here the entire claim is that the parts ADD UP, and a floored bar
 * makes the geometry visibly not close: the connectors would step somewhere the
 * running total never went. So the height stays honest and `belowHairline` tells
 * the renderer to draw a rule and say the band is too small to draw to scale. The
 * table lens carries the number, which is what the lens is for.
 */

/**
 * Below this a band cannot be read as an area at all.
 *
 * THREE pixels, not one, and it is the same number `TIER_RATIO` is derived from
 * (208px ÷ 69 ≈ 3). One pixel was wrong twice over: a 1px bar is not legible,
 * and it put the "can the bridge draw this?" threshold on a different footing
 * from the "should the magnified strip hold this?" threshold, so the strip could
 * print "too small to see above" over a band the bridge drew perfectly well.
 * One number, one meaning, and the caption is true by construction.
 */
export const LEGIBLE_PX = 3;

export interface WaterfallBandInput {
  key: string;
  label: string;
  /** signed, net-worth-directed */
  cents: number;
}

export interface WaterfallInput {
  openingCents: number;
  closingCents: number;
  bands: readonly WaterfallBandInput[];
}

export interface WaterfallOptions {
  width: number;
  height: number;
  /** fraction of a column the bar occupies; the rest is the gap */
  barFraction?: number;
  /**
   * Breathing room below the lowest running total, as a fraction of the span.
   *
   * ⚠️ Purely visual, and that is a correction. It was introduced to give the
   * lowest TOTAL column a visible height, back when totals were drawn as bars
   * from the floor — and review measured what that actually produced: on the
   * all-time window the opening total rendered as a 77.97px bar labelled
   * "$0.00" beside a 205.23px bar labelled "$109,322.37", a drawn ratio of 0.380
   * against a true ratio of 0.000. Worse, whenever the opening WAS the lowest
   * running total its bar height came out at exactly `height × pad/(1+pad)`
   * regardless of the number printed under it — a column carrying no information
   * at all. Totals are levels now, not areas, and nothing is measured from the
   * floor; this only stops a band at the extreme sitting flush against the edge.
   */
  floorPadFraction?: number;
}

export type WaterfallStepKind = "total" | "band";
export type WaterfallDirection = "up" | "down" | "flat";

export interface WaterfallStep {
  key: string;
  label: string;
  kind: WaterfallStepKind;
  /** a total's LEVEL, or a band's signed delta */
  cents: number;
  /** the running total after this step; for a total, the total itself */
  runningCents: number;
  direction: WaterfallDirection;
  x: number;
  width: number;
  y: number;
  height: number;
  /**
   * A BAND the bridge cannot draw as an area. The renderer must mark it and let
   * the magnified strip carry its size. Always false for a total, which has no
   * area to be too small.
   */
  belowHairline: boolean;
  /** y of the level this step leaves behind, for the connector to the next; null on the last */
  connectorY: number | null;
}

export interface WaterfallLayout {
  width: number;
  height: number;
  steps: WaterfallStep[];
  /** where the drawing floor sits — padded below the data unless it snapped to zero */
  axisMinCents: number;
  axisMaxCents: number;
  /** the lowest and highest running totals, before any padding */
  dataMinCents: number;
  dataMaxCents: number;
  /** the axis floor really is zero — otherwise the renderer must disclose it */
  axisStartsAtZero: boolean;
  /** the bands land exactly on the closing total */
  closes: boolean;
  /** closing − (opening + Σ bands). Zero when it closes. */
  shortfallCents: number;
}

const BAR_FRACTION = 0.62;
const FLOOR_PAD_FRACTION = 0.06;

function directionOf(cents: number): WaterfallDirection {
  if (cents > 0) return "up";
  if (cents < 0) return "down";
  return "flat";
}

export function computeWaterfallLayout(
  input: WaterfallInput,
  options: WaterfallOptions,
): WaterfallLayout {
  const {
    width,
    height,
    barFraction = BAR_FRACTION,
    floorPadFraction = FLOOR_PAD_FRACTION,
  } = options;

  // levels[i] is the running total AFTER step i; levels[0] is the opening
  const levels: number[] = [input.openingCents];
  for (const b of input.bands) levels.push(levels[levels.length - 1]! + b.cents);
  const reached = levels[levels.length - 1]!;
  const shortfallCents = input.closingCents - reached;

  /*
   * The closing column is drawn at the CLOSING total, not at wherever the bands
   * happened to land. When those differ the picture is wrong and must look
   * wrong — stretching the last band to meet the far bank is precisely the plug
   * `lib/attribution` refuses to build.
   */
  const runs = [...levels, input.closingCents];
  const dataMinCents = Math.min(...runs);
  const dataMaxCents = Math.max(...runs);
  /*
   * The floor drops below the lowest running total so the lowest TOTAL column
   * still has a bar. Where the data never goes negative the pad is clamped at
   * zero instead — a net-worth axis that dips below zero when nothing did is a
   * worse lie than a shorter column, and snapping to zero is strictly better
   * because it makes `axisStartsAtZero` honestly true.
   */
  /*
   * Floored to a whole cent, and that is not a nicety. Every money value in this
   * app is an integer number of cents and `formatCents` THROWS on anything else
   * — rendering the axis floor crashed the dashboard with
   * `RangeError: Invalid cents value: 10259599.92` the moment the disclosure was
   * added. Floor rather than round, so the pad can only ever grow the gap and
   * never pull the axis up into the data.
   */
  const padded = Math.floor(dataMinCents - (dataMaxCents - dataMinCents) * floorPadFraction);
  const axisMinCents = dataMinCents >= 0 ? Math.max(0, padded) : padded;
  const axisMaxCents = dataMaxCents;
  const span = axisMaxCents - axisMinCents;

  // A window where nothing moved has no extent: every level is the same point,
  // so every height is zero rather than 0/0.
  const y = (v: number): number => (span === 0 ? height : height * ((axisMaxCents - v) / span));

  const columns = input.bands.length + 2;
  const colWidth = width / columns;
  const barWidth = colWidth * barFraction;
  const xOf = (i: number): number => i * colWidth + (colWidth - barWidth) / 2;

  const steps: WaterfallStep[] = [];

  /*
   * ⛔ A total is a LEVEL and is drawn with NO HEIGHT — a rule at `y`, never a
   * bar from the floor.
   *
   * Bars from a floor were the shipped version and review measured what they
   * said: the all-time window drew the opening as a 77.97px column labelled
   * "$0.00". A rectangle's height encodes a magnitude, and the distance from an
   * arbitrary padded floor up to a level is not one — it changes when the pad
   * changes and stays put when the total does. The two totals are printed as
   * text beside their marks, which is the only honest way to state a level.
   */
  const pushTotal = (key: string, label: string, cents: number, index: number): void => {
    steps.push({
      key,
      label,
      kind: "total",
      cents,
      runningCents: cents,
      // no direction either: a level has none, and colouring one up or down
      // would claim a movement that is not there
      direction: "flat",
      x: xOf(index),
      width: barWidth,
      y: y(cents),
      height: 0,
      belowHairline: false,
      connectorY: null,
    });
  };

  pushTotal("opening", "Opening", input.openingCents, 0);

  input.bands.forEach((b, i) => {
    const from = levels[i]!;
    const to = levels[i + 1]!;
    const yFrom = y(from);
    const yTo = y(to);
    const bandHeight = Math.abs(yTo - yFrom);
    steps.push({
      key: b.key,
      label: b.label,
      kind: "band",
      cents: b.cents,
      runningCents: to,
      direction: directionOf(b.cents),
      x: xOf(i + 1),
      width: barWidth,
      // a band floats between its own two levels — never from the floor
      y: Math.min(yFrom, yTo),
      height: bandHeight,
      belowHairline: bandHeight < LEGIBLE_PX,
      connectorY: null,
    });
  });

  pushTotal("closing", "Closing", input.closingCents, columns - 1);

  // Each step hands its level to the next; the last has nothing to hand it to.
  for (let i = 0; i < steps.length - 1; i += 1) {
    steps[i]!.connectorY = y(steps[i]!.runningCents);
  }

  return {
    width,
    height,
    steps,
    axisMinCents,
    axisMaxCents,
    dataMinCents,
    dataMaxCents,
    axisStartsAtZero: axisMinCents === 0,
    closes: shortfallCents === 0,
    shortfallCents,
  };
}
