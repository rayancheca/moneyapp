/**
 * How to draw a hundred dollars beside seventy thousand without lying.
 *
 * ## The measured problem
 *
 * On the real ledger, 2026-08-24, the active accounts span **seven million to
 * one**. Rendered on a single linear axis 208px tall:
 *
 * | account | balance | height |
 * |---|---|---|
 * | Robinhood Brokerage | $70,291.75 | 208px |
 * | Chase Checking | $3,007.60 | 8.9px |
 * | Discover | −$557.62 | **1.65px** |
 * | Robinhood Cash | $113.88 | **0.34px** |
 * | SoFi Savings | $0.10 | **0.00px** |
 *
 * Five of ten accounts draw under one device pixel. The chart is not showing
 * them small — it is not showing them at all, and a reader cannot tell an empty
 * account from one holding a hundred dollars.
 *
 * ## What this does, and what it refuses to do
 *
 * It splits values into TIERS by magnitude. Each tier gets its own axis, scaled
 * to that tier's own largest member, and **states how much it is magnified**. A
 * reader compares exactly within a tier and reads across tiers from the printed
 * factor. Nothing is rescaled silently.
 *
 * ⛔ **Not a log scale.** Money is not read logarithmically — nobody looks at a
 * bar and thinks in decades — and a log axis cannot represent a credit-card
 * balance at all, because it has no sign and no zero.
 *
 * ⛔ **Not a minimum-bar floor.** `deviation-layout` uses one and is right to:
 * its bars need not sum to anything. Wherever parts must add up, a floored bar
 * makes the arithmetic visibly wrong, and it also flatly misreports size — a
 * 2px floor tells the reader $0.10 and $113.88 are the same.
 *
 * ⛔ **Not a broken axis.** A gap drawn in the middle of a scale is the classic
 * dishonest chart, and it hides exactly the ratio the reader came for.
 *
 * ⛔ **And not magnification without limit.** Ten cents beside $70,291.75 would
 * need 702,917× to fill a bar. Past `MAX_MAGNIFICATION` a value stops being a
 * shape and becomes a sentence — it is listed, not drawn. Saying "two accounts
 * hold under a dollar" is information; drawing them as tall as the brokerage is
 * not.
 *
 * Pure: no React, no DOM, no `Date`, no `Math.random`.
 */

/**
 * The widest ratio allowed inside one tier.
 *
 * Chosen from the pixel budget rather than from taste: the app's charts are
 * 208px tall (`h-52`), and 208 ÷ 69 ≈ 3px, which is the smallest mark that still
 * reads as a bar rather than as a hairline. Tighten it for a shorter chart.
 */
export const TIER_RATIO = 69;

/**
 * The most a tier may be blown up relative to the first.
 *
 * Beyond this the magnified panel stops being a fair comparison and becomes a
 * distortion with a number printed under it. A thousandfold is already an
 * extraordinary claim to put on a page.
 */
export const MAX_MAGNIFICATION = 1000;

export interface MagnitudeInput {
  key: string;
  /** signed; only the MAGNITUDE tiers, because sign is the renderer's business */
  cents: number;
}

export interface MagnitudeTier {
  /** 0 is the true-scale tier; every later one is magnified */
  index: number;
  /** this tier's own axis ceiling — the largest magnitude it holds */
  maxCents: number;
  /** how many times larger this tier is drawn than tier 0. Always 1 for tier 0. */
  magnification: number;
  /** in the caller's original order, so a re-render never reshuffles */
  keys: string[];
}

export interface MagnitudeTiering {
  tiers: MagnitudeTier[];
  /** real money, too small to draw even magnified — name it in prose instead */
  negligible: string[];
  /**
   * Exactly zero. Kept apart from `negligible` on purpose: an empty account and
   * a nearly-empty one are different facts, and a reader deserves to know which.
   */
  zero: string[];
}

export interface MagnitudeOptions {
  tierRatio?: number;
  maxMagnification?: number;
}

export function magnitudeTiers(
  values: readonly MagnitudeInput[],
  options: MagnitudeOptions = {},
): MagnitudeTiering {
  const tierRatio = options.tierRatio ?? TIER_RATIO;
  const maxMagnification = options.maxMagnification ?? MAX_MAGNIFICATION;

  const zero: string[] = [];
  const sized: { key: string; magnitude: number; order: number }[] = [];
  values.forEach((v, order) => {
    if (v.cents === 0) {
      zero.push(v.key);
      return;
    }
    sized.push({ key: v.key, magnitude: Math.abs(v.cents), order });
  });

  if (sized.length === 0) return { tiers: [], negligible: [], zero };

  // Descending by size; ties keep the caller's order so the output is stable
  // across renders of the same data.
  const sorted = [...sized].sort((a, b) => b.magnitude - a.magnitude || a.order - b.order);
  const headMagnitude = sorted[0]!.magnitude;

  const tiers: MagnitudeTier[] = [];
  const negligible: string[] = [];
  let current: MagnitudeTier | null = null;

  for (const item of sorted) {
    if (current !== null && item.magnitude >= current.maxCents / tierRatio) {
      current.keys.push(item.key);
      continue;
    }
    /*
     * This value is too small for the open tier, so it wants a tier of its own.
     * It only gets one if that tier can be drawn honestly — past the cap the
     * magnification is no longer a comparison, and everything from here down is
     * smaller still, so nothing after this can qualify either.
     */
    const magnification = Math.round(headMagnitude / item.magnitude);
    if (magnification > maxMagnification) {
      negligible.push(item.key);
      continue;
    }
    current = {
      index: tiers.length,
      maxCents: item.magnitude,
      // tier 0 is the reference and is by definition unmagnified, even though
      // the division would also give 1 — stated so the meaning does not depend
      // on the arithmetic happening to agree
      magnification: tiers.length === 0 ? 1 : magnification,
      keys: [item.key],
    };
    tiers.push(current);
  }

  // Restore the caller's order inside each tier: sorting was a means of finding
  // the boundaries, not a decision about how the tier should read.
  const orderOf = new Map(sized.map((s) => [s.key, s.order] as const));
  for (const tier of tiers) {
    tier.keys.sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
  }
  negligible.sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));

  return { tiers, negligible, zero };
}
