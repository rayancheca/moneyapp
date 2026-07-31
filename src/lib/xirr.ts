import { diffDays } from "@/lib/dates";

/**
 * XIRR — the money-weighted (internal) rate of return on a series of DATED cash
 * flows, from the investor's perspective (contributions negative, withdrawals /
 * terminal value positive). It answers "how fast did MY dollars grow", weighting
 * by when each dollar was in the market — the complement to the time-weighted
 * return (which strips flow timing out). Pure and clock-free; returns an
 * annualized decimal rate (0.10 = 10%/yr) or null when no rate is well-defined.
 *
 * Solved by Newton-Raphson on the NPV, with a bisection fallback for the cases
 * Newton diverges on (deep losses, awkward brackets). Returns null when there
 * are <2 flows, no sign change (no root exists), or it fails to converge —
 * matching the codebase's pervasive `| null` honesty for undefined returns.
 */

export interface CashFlow {
  /** YYYY-MM-DD */
  day: string;
  /** investor-signed cents: money IN to the investment is negative, OUT is positive */
  amountCents: number;
}

const DAYS_PER_YEAR = 365;
const TOL_CENTS = 1e-6; // NPV is in cents — a millionth of a cent is convergence
const NEWTON_ITERS = 100;
const BISECT_ITERS = 200;
/** rate domain is (-1, ∞); a return below -100%/yr is meaningless */
const RATE_FLOOR = -0.999999;
const RATE_CEIL = 1e6;

function sane(rate: number): number | null {
  return Number.isFinite(rate) && rate > -1 && rate < RATE_CEIL ? rate : null;
}

export function xirr(flows: readonly CashFlow[]): number | null {
  if (flows.length < 2) return null;
  // a root of NPV(rate) exists only when the flows change sign
  if (!flows.some((f) => f.amountCents > 0) || !flows.some((f) => f.amountCents < 0)) {
    return null;
  }

  const sorted = [...flows].sort((a, b) => a.day.localeCompare(b.day));
  const t0 = sorted[0]!.day;
  const years = sorted.map((f) => diffDays(t0, f.day) / DAYS_PER_YEAR);
  const amounts = sorted.map((f) => f.amountCents);

  // all flows on a SINGLE day → no time dimension. NPV is identically 0 for
  // every rate (all exponents are 0, so every term is just its amount and they
  // cancel), so no rate is defined — a brand-new position must read "—", not a
  // fabricated number. (years is sorted ascending; last == 0 ⇒ all == 0.)
  if (years[years.length - 1] === 0) return null;

  const npv = (rate: number): number => {
    let sum = 0;
    for (let i = 0; i < amounts.length; i += 1) sum += amounts[i]! / (1 + rate) ** years[i]!;
    return sum;
  };
  const dNpv = (rate: number): number => {
    let sum = 0;
    for (let i = 0; i < amounts.length; i += 1) {
      const y = years[i]!;
      if (y === 0) continue; // d/drate of a constant (t=0) term is 0
      sum += (-y * amounts[i]!) / (1 + rate) ** (y + 1);
    }
    return sum;
  };

  // ── Newton-Raphson from a reasonable guess ──────────────────────────
  let rate = 0.1;
  for (let i = 0; i < NEWTON_ITERS; i += 1) {
    const f = npv(rate);
    if (!Number.isFinite(f)) break;
    if (Math.abs(f) < TOL_CENTS) return sane(rate);
    const df = dNpv(rate);
    /* v8 ignore next — unreachable, kept as a guard. dNpv's terms carry exponent
       (y+1) against npv's y, so for a large span df underflows to 0 (hence ±Inf)
       within 0.05% of the rate at which f does — and the domain clamp below halves
       1+rate each step, jumping clean over a window that narrow, so `f` always
       trips its own check first (verified: a 2000-year span breaks at f, not df).
       `df === 0` needs the weighted sum to vanish exactly at an iterate, which the
       sign-change precondition makes impossible for two flows. */
    if (!Number.isFinite(df) || df === 0) break;
    let next = rate - f / df;
    /* v8 ignore next — unreachable, kept as a guard. f and df are both finite here
       and df is non-zero, and in the overflow regime |df| exceeds |f| (again the
       larger exponent), so the quotient cannot overflow to Infinity. */
    if (!Number.isFinite(next)) break;
    // keep the iterate inside the (-1, ∞) domain
    if (next <= -1) next = (rate - 1) / 2;
    // accept a stalled iterate ONLY when it is genuinely at a root — the domain
    // clamp above can walk toward -1 and "stop moving" far from any root, so a
    // pure "stopped moving" test would report a bogus rate (a severe-loss bug);
    // otherwise fall through to the bracketed bisection below
    if (Math.abs(next - rate) < TOL_CENTS) {
      if (Math.abs(npv(next)) < TOL_CENTS) return sane(next);
      break;
    }
    rate = next;
  }

  // ── Bisection fallback: find a sign-change bracket by scanning ───────
  const bracket = findBracket(npv);
  if (!bracket) return null;
  let [lo, hi] = bracket;
  let fLo = npv(lo);
  for (let i = 0; i < BISECT_ITERS; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    /* v8 ignore next — unreachable, kept as a guard. It needs two things at once
       that exclude each other: `mid` close enough to RATE_FLOOR that (1+mid)^y
       underflows (y > ~54 years), and a bracket sitting down at the floor. But the
       longer the span, the closer to zero the root of a losing series moves — a
       120-year total loss brackets at [-0.11, -0.10], a 2000-year one at [-0.01, 0]
       — so a long span never produces a floor-adjacent bracket. */
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < TOL_CENTS || hi - lo < 1e-12) return sane(mid);
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  /* v8 ignore next 2 — unreachable: findBracket can return a span no wider than
     RATE_CEIL − 100_000 = 9e5, and halving that 200 times gives ~5e-58, so the
     `hi - lo < 1e-12` exit above always fires first (measured: the widest real
     bracket converges by iteration ~70). Kept as a guard against a future change
     to BISECT_ITERS or the sample range rather than deleted. */
  return sane((lo + hi) / 2);
}

/**
 * The first rate interval over which NPV changes sign, or null if none exists.
 * Scans densely over the realistic return range (-99%..+1000%/yr) and sparsely
 * beyond — checking only the two endpoints would miss a real root whenever the
 * NPV curve crosses zero an even number of times between them (multiple-IRR).
 */
function findBracket(npv: (rate: number) => number): [number, number] | null {
  const samples: number[] = [RATE_FLOOR];
  for (let r = -0.99; r <= 10; r += 0.01) samples.push(r);
  samples.push(100, 1_000, 10_000, 100_000, RATE_CEIL);
  let prev = samples[0]!;
  let fPrev = npv(prev);
  for (let i = 1; i < samples.length; i += 1) {
    const r = samples[i]!;
    const fr = npv(r);
    if (Number.isFinite(fPrev) && Number.isFinite(fr) && fPrev * fr <= 0) return [prev, r];
    prev = r;
    fPrev = fr;
  }
  return null;
}
