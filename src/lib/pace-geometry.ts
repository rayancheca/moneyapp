/**
 * SVG-path math for the dashboard's spending-pace chart.
 *
 * In lib, not in the component, for the reason pass 50 established: the e2e
 * clock is pinned to E2E_FAKE_TODAY, so a Playwright run can only ever render
 * ONE day of one 31-day month. Day 1, the last day (where the projection
 * disappears), a 28-day February and a month with nothing spent yet are all
 * unreachable from any spec — which is exactly the set of cases that were
 * wrong. Here they are covered by the 100%-branch gate over src/lib.
 */

/** viewBox width — chosen so a 31-bucket month lands on tidy x steps */
export const PACE_VW = 240;
export const PACE_VH = 56;

/** breathing room top and bottom; the drawable band is PACE_VH - 2*PACE_PAD */
const PACE_PAD = 4;

export interface PaceGeometry {
  /** stepped path through every measured cumulative total */
  solid: string;
  /** `solid` closed down to a true zero baseline */
  area: string;
  /** straight dotted extrapolation to the month-end pace; null on the last day */
  projection: string | null;
  /** the last measured point — where measurement stops and estimate begins */
  todayX: number;
  todayY: number;
}

export interface PaceGeometryInput {
  /**
   * cumulative spend per bucket; null where the ledger has not read it — before
   * it opens, after it reaches, past today. What is read is one unbroken run.
   */
  readonly actualCents: readonly (number | null)[];
  readonly projectedCents: number;
}

/**
 * Returns null when there is nothing honest to draw.
 *
 * The zero guard is not defensive tidiness. With no spend recorded yet the
 * projection is also zero, so the old code drew a flat dashed rule along the
 * baseline for the full width of the month — a chart asserting a $0 month-end
 * projection as a drawn line, on the 1st of every month. Measured on the real
 * ledger at 2026-08-01: `projectedCents = 0`, solid `"M 0.0 52.0"` (a lone
 * moveto, which paints nothing), projection `"M 0.0 52.0 L 240.0 52.0"`.
 */
export function paceGeometry(input: PaceGeometryInput): PaceGeometry | null {
  const { actualCents, projectedCents } = input;
  const n = actualCents.length;
  if (n < 2) return null;

  /*
   * 🔴 The staircase began at bucket 0 whatever it held, and `y(null)` is
   * `y(0)` — so in a month the ledger opens inside, every day before the
   * records begin was drawn along the baseline as a $0 day nobody measured. It
   * starts on the first measured bucket.
   */
  let firstActualIdx = -1;
  let lastActualIdx = -1;
  for (let i = 0; i < n; i++) {
    if (actualCents[i] === null) continue;
    if (firstActualIdx < 0) firstActualIdx = i;
    lastActualIdx = i;
  }
  if (lastActualIdx < 0) return null;

  const measured = actualCents.slice(firstActualIdx, lastActualIdx + 1) as number[];
  const peak = measured[measured.length - 1]!;
  // nothing spent AND nothing projected — see the note above
  if (projectedCents <= 0 && peak <= 0) return null;

  const max = Math.max(projectedCents, peak, 1);
  const x = (i: number): number => Math.round((i / (n - 1)) * PACE_VW * 10) / 10;
  const y = (v: number): number =>
    Math.round((PACE_VH - PACE_PAD - (v / max) * (PACE_VH - PACE_PAD * 2)) * 10) / 10;

  // Cumulative spend is a STAIRCASE: each bucket is a day's closing total and
  // nothing was measured between two of them. Stepping (hold, then jump) asserts
  // strictly LESS than a diagonal, which would claim money trickled out evenly
  // across each day.
  let solid = `M ${x(firstActualIdx)} ${y(measured[0]!)}`;
  for (let i = 1; i < measured.length; i++) {
    solid += ` H ${x(firstActualIdx + i)} V ${y(measured[i]!)}`;
  }

  // Filled, because `projectedCents` is `upfront + (actualToDate − upfront) ×
  // daysInMonth / elapsed` (`computePace`) — the car's up-front money counted
  // once and never extrapolated (owner decision 2026-10-07, §6A 51), the rest a
  // straight line — and so always owns the top of the scale. That pins the
  // measured line's ceiling to `elapsed / daysInMonth` of the band on every day
  // of every month, and only a month holding up-front money lifts it above.
  // Early in a month it is squeezed into the bottom tenth no matter what was
  // spent: measured on the fixture, an 8-day range came to 2.0px against a
  // 1.75px stroke, so a staircase rendered as a flat hairline. A region against
  // a true zero survives that squeeze; a hairline does not.
  const area = `${solid} V ${y(0)} H ${x(firstActualIdx)} Z`;

  const projection =
    lastActualIdx < n - 1
      ? `M ${x(lastActualIdx)} ${y(peak)} L ${x(n - 1)} ${y(projectedCents)}`
      : null;

  return { solid, area, projection, todayX: x(lastActualIdx), todayY: y(peak) };
}
