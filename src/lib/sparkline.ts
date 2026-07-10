/**
 * Pure SVG-path math for the tiny balance sparklines on account cards.
 * Kept in lib (no DOM, no React) so the geometry is unit-testable and the
 * component stays a dumb renderer.
 */

export interface SparklineGeometry {
  /** polyline through every point */
  linePath: string;
  /** line closed down to the baseline for a soft area fill */
  areaPath: string;
  lastX: number;
  lastY: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Maps values onto a width×height viewBox with `pad` breathing room.
 * Returns null when there is nothing to draw (fewer than 2 points).
 * A flat series draws a horizontal midline rather than dividing by zero.
 */
export function sparklineGeometry(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): SparklineGeometry | null {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const x = (i: number): number => round(pad + (i / (values.length - 1)) * innerW);
  const y = (v: number): number =>
    span === 0 ? round(height / 2) : round(pad + (1 - (v - min) / span) * innerH);

  const points = values.map((v, i) => `${x(i)},${y(v)}`);
  const linePath = `M${points.join("L")}`;
  const baseline = round(height - pad);
  const areaPath = `${linePath}L${x(values.length - 1)},${baseline}L${x(0)},${baseline}Z`;

  return {
    linePath,
    areaPath,
    lastX: x(values.length - 1),
    lastY: y(values[values.length - 1]!),
  };
}
