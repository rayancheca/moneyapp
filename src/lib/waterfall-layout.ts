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

/** Below this, a band cannot be seen as an area — the renderer draws a rule. */
export const HAIRLINE_PX = 1;

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
  /** the height is under one device pixel — draw a rule and say so */
  belowHairline: boolean;
  /** y of the level this step leaves behind, for the connector to the next; null on the last */
  connectorY: number | null;
}

export interface WaterfallLayout {
  width: number;
  height: number;
  steps: WaterfallStep[];
  axisMinCents: number;
  axisMaxCents: number;
  /** the axis floor really is zero — otherwise the renderer must disclose it */
  axisStartsAtZero: boolean;
  /** the bands land exactly on the closing total */
  closes: boolean;
  /** closing − (opening + Σ bands). Zero when it closes. */
  shortfallCents: number;
}

const BAR_FRACTION = 0.62;

function directionOf(cents: number): WaterfallDirection {
  if (cents > 0) return "up";
  if (cents < 0) return "down";
  return "flat";
}

export function computeWaterfallLayout(
  input: WaterfallInput,
  options: WaterfallOptions,
): WaterfallLayout {
  const { width, height, barFraction = BAR_FRACTION } = options;

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
  const axisMinCents = Math.min(...runs);
  const axisMaxCents = Math.max(...runs);
  const span = axisMaxCents - axisMinCents;

  // A window where nothing moved has no extent: every level is the same point,
  // so every height is zero rather than 0/0.
  const y = (v: number): number => (span === 0 ? height : height * ((axisMaxCents - v) / span));
  const floorY = height;

  const columns = input.bands.length + 2;
  const colWidth = width / columns;
  const barWidth = colWidth * barFraction;
  const xOf = (i: number): number => i * colWidth + (colWidth - barWidth) / 2;

  const steps: WaterfallStep[] = [];

  const pushTotal = (key: string, label: string, cents: number, index: number): void => {
    const top = y(cents);
    steps.push({
      key,
      label,
      kind: "total",
      cents,
      runningCents: cents,
      // A total is a LEVEL, not a movement — it has no direction to be, and
      // colouring it up or down would claim one.
      direction: "flat",
      x: xOf(index),
      width: barWidth,
      y: top,
      height: floorY - top,
      belowHairline: floorY - top < HAIRLINE_PX,
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
      belowHairline: bandHeight < HAIRLINE_PX,
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
    axisStartsAtZero: axisMinCents === 0,
    closes: shortfallCents === 0,
    shortfallCents,
  };
}
