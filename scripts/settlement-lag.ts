/**
 * Separating a SETTLEMENT LAG from missing money.
 *
 * Lives in `scripts/` rather than `src/lib/`, for the reason pass 56 recorded:
 * `assertBundleIsFresh` (e2e/global-setup.ts) walks the whole `src` tree and
 * refuses to run the e2e suite when anything in it is newer than the build, so
 * a check-only module under `src/lib` breaks `pnpm e2e` after every edit to it
 * for a file that is never in the bundle. The vitest config already collects
 * test files under `scripts/`, so this still gets unit tests — it simply
 * carries no coverage threshold.
 */

export interface Disagreement {
  day: string;
  cents: number;
}

/** Settlement moves a day or two, and a weekend stretches that to four. */
const LAG_WINDOW_DAYS = 4;

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Drop the disagreements that are a SETTLEMENT LAG rather than missing money.
 *
 * The ledger dates a movement when the trade happened; the sweep table dates it
 * when the cash actually moved, a day or two later. Each such movement therefore
 * shows up twice — once as the ledger running ahead, once as it running behind
 * — for the same amount, with opposite signs, a few days apart. 2025-04 is the
 * clearest case in the archive: eight disagreeing days, four exact mirror pairs,
 * net exactly $0.00. Reporting those as findings would bury the real ones.
 *
 * Pairing follows the transfer detector's doctrine rather than inventing a
 * looser one: EXACT amount, opposite sign, inside the window, and MUTUALLY
 * nearest — each side must be the other's closest candidate. A one-sided
 * near-match is left unpaired and reported, because a coincidence that silently
 * cancels a real gap is the expensive failure here, not a noisy line.
 */
export function dropSettlementLag(disagreements: readonly Disagreement[]): Disagreement[] {
  const taken = new Set<number>();

  const nearest = (i: number): number | null => {
    let best: number | null = null;
    let bestGap = Infinity;
    disagreements.forEach((other, j) => {
      if (j === i || taken.has(j)) return;
      if (other.cents !== -disagreements[i]!.cents) return;
      const gap = daysApart(disagreements[i]!.day, other.day);
      if (gap > LAG_WINDOW_DAYS || gap >= bestGap) return;
      best = j;
      bestGap = gap;
    });
    return best;
  };

  disagreements.forEach((_, i) => {
    if (taken.has(i)) return;
    const j = nearest(i);
    if (j === null) return;
    // mutual-nearest: j's own closest opposite must be i, or this is a
    // coincidence borrowing a partner that belongs to someone else
    if (nearest(j) !== i) return;
    taken.add(i);
    taken.add(j);
  });

  return disagreements.filter((_, i) => !taken.has(i));
}
