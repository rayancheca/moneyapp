/**
 * Whole-number shares that still add up to the whole.
 *
 * 🔴 On 2026-09-11 the dashboard's "What changed" card read **"94% of your usual
 * spending posts to 4 accounts"** directly above those four accounts, printed as
 * **"51% · 22% · 20% · 2%" — which add to 95.** Both halves were honest rounds
 * of the same four figures:
 *
 *     Venture X       50.888497
 *     Chase Checking  21.684170
 *     Chase Sapphire  19.976802
 *     Discover         1.784702
 *     ─────────────────────────
 *     true sum        94.334172   → Math.round → 94   (the headline)
 *     each rounded    51 22 20 2  →      sum   → 95   (the rows)
 *
 * The total was rounded once, the parts four separate times, and nothing made
 * the two agree. A reader who adds the rows up is reading a card that does not.
 * The e2e fixture said 99 over rows adding to 98, the same way.
 *
 * ⛔ It also breaks the module's own stated doctrine. `movers-card` says of its
 * total: *"The total is the SUM of the rows … of the two only this one lets the
 * reader add the card up."* The coverage note forty lines below did not.
 *
 * The fix is apportionment, not a second rounding rule: floor every part, then
 * hand the leftover points to the parts with the largest fractional remainders
 * — the largest-remainder method. The total stays the honest round of the true
 * sum (94, not 95), the parts sum to it by construction, and no part moves by
 * more than one point.
 */

/**
 * `parts` (each ≥ 0 and finite) → integers summing to exactly
 * `Math.round(Σ parts)`. Ties break on the caller's own order, so the result is
 * a pure function of the input sequence.
 *
 * ⛔ Not a formatter: it returns integers and never renders a "%", so the caller
 * keeps its own wording. Non-negative parts are the only shape a share has, and
 * they are what guarantees the leftover is never negative.
 */
export function apportionPercents(parts: readonly number[]): number[] {
  const target = Math.round(parts.reduce((sum, p) => sum + p, 0));
  const out = parts.map((p) => Math.floor(p));
  const leftover = target - out.reduce((sum, f) => sum + f, 0);
  const byRemainder = parts
    .map((p, i) => ({ i, rem: p - Math.floor(p) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let n = 0; n < leftover; n += 1) out[byRemainder[n]!.i]! += 1;
  return out;
}
