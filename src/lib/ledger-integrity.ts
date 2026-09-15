import { formatCents } from "./money";

/**
 * The rules behind `pnpm ledger-check`.
 *
 * WHY THIS EXISTS. Three arbiters already grade this ledger — `daily_balances.
 * basis`, `statement_periods.reconciliation`, and the per-account coverage
 * grade — and a hand-entered +$3,579.67 row on Robinhood Cash walked past all
 * three. It was status `excluded`, so no spend or income view showed it; it had
 * no import file, so no statement supported it; and because a stored
 * reconciliation verdict is written once at import time and never revisited, it
 * left July 2026 asserting a $231.85 gap when the real figure was $3,811.52.
 *
 * Every one of those arbiters answers "is this period right?". None of them
 * answers the two questions that would have caught it:
 *
 *   1. does the STORED verdict still describe the ledger underneath it?
 *   2. how much of the money in the balance chain has no source document?
 *
 * Neither can be answered by looking at a period in isolation, which is why
 * they live in a check rather than in the import path.
 *
 * The baseline is deliberately EXACT, not a threshold. This ledger has nine
 * known breaks; a check that tolerated "about nine" would have said nothing
 * when a tenth arrived, and a break that changes size is a different break.
 */

export interface ChainPair {
  from: string;
  to: string;
  fromCents: number;
  movementCents: number;
  toCents: number;
}

/** A consecutive chain-grade anchor pair that was walked — its identity, not its money. */
export interface ChainWindow {
  from: string;
  to: string;
}

export interface ChainBreak extends ChainWindow {
  /** printed closing balance minus the replayed one; sign says which way */
  offByCents: number;
}

export interface StaleVerdict {
  account: string;
  periodStart: string;
  storedGapCents: number | null;
  freshGapCents: number | null;
}

/**
 * PASS 73 — one investment period's printed market value against the app's own.
 *
 * ⛔ This is the arbiter `Robinhood Brokerage` never had. Its holdings were
 * rebuilt from an activity CSV and nothing had ever checked them against a
 * document; the statements print `Total Securities` at both ends of every
 * month, and the app can value its own holdings on the same day.
 *
 * ⚠️ An investment period can never be graded `gap` (`periodVerdict`), and that
 * is right — a residual there is market movement, not missing money. So this
 * check is NOT the same question: it compares the two sides' opinion of the
 * SAME instant, where any disagreement is a disagreement about the holdings or
 * about a price, and one of the two is wrong.
 */
export interface ValueAnchor {
  account: string;
  /** the day the statement priced, and the day the app was asked about */
  on: string;
  printedCents: number;
  /** null when the app has no valuation for that day at all */
  derivedCents: number | null;
}

export interface ValueAnchorDrift {
  on: string;
  /** the app's valuation minus the printed one; sign says which way */
  offByCents: number;
}

/**
 * What the ledger said, AND what was asked of it.
 *
 * ⛔ `breaks`, `valueAnchors` and `syntheticNetCents` list only what DISAGREES,
 * so on their own an absence means two different things: the witness was
 * measured and now agrees, or the witness is gone and nothing was measured.
 * `accounts`, `chainWindows` and `valuedAnchorDays` are the denominators that
 * tell those apart. Measured on a copy of the owner's ledger (2026-09-15):
 * un-importing one Robinhood Brokerage statement took the value anchors from 43
 * to 42 and the check reported the vanished day's disagreement as one that "now
 * agrees — remove it from the baseline".
 */
export interface LedgerObservation {
  /** every account the check read, by name */
  accounts: readonly string[];
  /** every chain window walked per account, closing or not — consecutive, so abutting ones measure their span */
  chainWindows: Record<string, readonly ChainWindow[]>;
  breaks: Record<string, ChainBreak[]>;
  /** net cents of replay-status rows with no import file, per account */
  syntheticNetCents: Record<string, number>;
  staleVerdicts: StaleVerdict[];
  /** every statement day the app valued per account, agreeing or not (`findValueAnchorDrift`'s `valued`) */
  valuedAnchorDays: Record<string, readonly string[]>;
  /** printed-vs-derived market value, per account (pass 73) */
  valueAnchors: Record<string, ValueAnchorDrift[]>;
  /** every statement the app could NOT value (`findValueAnchorDrift`'s `unpriced`) — each one a finding */
  unpricedAnchors: readonly ValueAnchor[];
  /**
   * every statement period whose stored verdict was re-graded, per account.
   *
   * ⛔ `staleVerdicts` lists only the periods that no longer match, so a period
   * that was removed reads exactly like one that still agrees. This is its
   * denominator, floored by `src/lib/witness-floor.ts`.
   */
  gradedPeriods: Record<string, readonly GradedPeriod[]>;
}

/** A statement period's identity — its account is the key it is listed under. */
export interface GradedPeriod {
  periodStart: string;
  periodEnd: string;
}

export interface LedgerBaseline {
  breaks: Record<string, ChainBreak[]>;
  syntheticNetCents: Record<string, number>;
  valueAnchors: Record<string, ValueAnchorDrift[]>;
}

export type LedgerFailure = {
  kind:
    | "new-break"
    | "changed-break"
    | "fixed-break"
    | "split-break"
    | "unmeasured-break"
    | "synthetic-drift"
    | "unmeasured-synthetic"
    | "stale-verdict"
    | "new-value-drift"
    | "changed-value-drift"
    | "fixed-value-drift"
    | "unmeasured-value-drift"
    | "unpriced-anchor"
    | "witness-drop";
  account: string;
  detail: string;
};

/**
 * A cent, and no more.
 *
 * ⛔ Deliberately not a percentage. A tolerance that scaled with the position
 * would be loosest exactly where the money is, and the three largest
 * disagreements on this ledger are a stock split — a 10× error that a
 * percentage band would have to be absurd to catch. A cent is what a rounding
 * difference between two people multiplying the same quantity by the same price
 * can produce; anything larger is a different opinion about the holdings.
 */
export const VALUE_ANCHOR_TOLERANCE_CENTS = 1;

/** One day of the app's own valuation of an account (`portfolioSeries`'s points). */
export interface ValuedDay {
  day: string;
  valueCents: number;
}

/**
 * The app's answer for an account on a statement's day — `derivedCents`.
 *
 * ⚠️ OUTSIDE the book is zero; INSIDE it and missing is unknown.
 *
 * `portfolioSeries` starts on the account's first holding day, so a statement
 * that predates it is a statement from before anything was held — and the
 * app's answer for that day is $0.00, not "no idea". Reporting it as unvalued
 * made seven $0.00 anchors on Robinhood Crypto read as findings when the two
 * sides agreed exactly. A gap in the MIDDLE of the book is a different thing
 * and stays unknown.
 *
 * ⛔ `null` for the series means the app does not value this account AT ALL,
 * and that is not an empty book. Both arrive from `portfolioSeries` as zero
 * points; only the caller knows which it asked. Measured on a copy of the
 * owner's ledger (2026-09-15): a deactivated Robinhood Brokerage read as an
 * empty book valued every one of its 25 statements at $0.00 — 21 drifts the
 * size of the whole printed amount.
 */
export function statementDayValuation(
  series: readonly ValuedDay[] | null,
): (day: string) => number | null {
  if (series === null) return () => null;
  const byDay = new Map(series.map((p) => [p.day, p.valueCents]));
  const first = series[0]?.day ?? null;
  const last = series[series.length - 1]?.day ?? null;
  return (day) => {
    const hit = byDay.get(day);
    if (hit !== undefined) return hit;
    if (first === null || last === null) return 0;
    return day < first || day > last ? 0 : null;
  };
}

/**
 * Every anchor whose two sides disagree by more than a cent.
 *
 * ⚠️ An anchor the app cannot value at all is NOT a drift — it is a missing
 * answer, and calling it a drift of `printedCents` would make an absent
 * valuation look like a total loss. It is reported separately.
 */
export function findValueAnchorDrift(
  anchors: readonly ValueAnchor[],
  toleranceCents: number = VALUE_ANCHOR_TOLERANCE_CENTS,
): {
  drifts: Record<string, ValueAnchorDrift[]>;
  unpriced: ValueAnchor[];
  /** every day compared, agreeing or not — the denominator of `drifts` */
  valued: Record<string, string[]>;
} {
  const drifts: Record<string, ValueAnchorDrift[]> = {};
  const unpriced: ValueAnchor[] = [];
  const valued: Record<string, string[]> = {};
  for (const a of anchors) {
    if (a.derivedCents === null) {
      unpriced.push(a);
      continue;
    }
    (valued[a.account] ??= []).push(a.on);
    const offByCents = a.derivedCents - a.printedCents;
    if (Math.abs(offByCents) <= toleranceCents) continue;
    (drifts[a.account] ??= []).push({ on: a.on, offByCents });
  }
  for (const list of Object.values(drifts)) list.sort((x, y) => x.on.localeCompare(y.on));
  for (const days of Object.values(valued)) days.sort();
  return { drifts, unpriced, valued };
}

/**
 * Every consecutive anchor pair whose replay does not land on the printed
 * closing balance. Exact — a one-cent break is a break, because a penny that
 * cannot be explained is a penny of unexplained money, and on this ledger two
 * of them hold 59 days at `gap`.
 */
export function findChainBreaks(pairs: readonly ChainPair[]): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  for (const p of pairs) {
    const offByCents = p.toCents - (p.fromCents + p.movementCents);
    if (offByCents !== 0) breaks.push({ from: p.from, to: p.to, offByCents });
  }
  return breaks;
}

/** The WINDOW is a break's identity; the amount is what can drift inside it. */
const windowKey = (b: ChainWindow): string => `${b.from}→${b.to}`;

/**
 * The walked windows that tile `from → to` exactly, in order — or null when the
 * walk does not stop on both days with no hole between them.
 *
 * ⛔ A recorded window is measured when its SPAN is, not only when the same pair
 * is walked again. The usual fix for a break is the missing statement ARRIVING,
 * and its anchor lands inside the window: that exact pair is never walked again,
 * but both halves are, and replay adds up across windows that abut. Measured on
 * a copy of the owner's ledger (2026-09-15, review): with Robinhood Cash's
 * -$8,562.85 over 2026-04-30 → 2026-06-30 recorded and the June statement
 * present, asking only for the identical pair said "find which anchor left"
 * about an anchor that had arrived, over halves that both close.
 */
export function windowsSpanning(walked: readonly ChainWindow[], from: string, to: string): ChainWindow[] | null {
  const startingOn = new Map(walked.map((w) => [w.from, w]));
  const span: ChainWindow[] = [];
  let at = from;
  while (at < to) {
    const next = startingOn.get(at);
    if (next === undefined || next.to <= at) return null;
    span.push(next);
    at = next.to;
  }
  return at === to && span.length > 0 ? span : null;
}

/**
 * Observation vs recorded baseline.
 *
 * A DISAPPEARING break fails too. That reads odd — a fixed break is good news —
 * but a baseline listing a break that no longer exists is a baseline that has
 * stopped describing the ledger, and the next time that break returns the check
 * would call it expected. Good news still has to be written down.
 *
 * ⛔ And a disappearance is only good news when the witness was MEASURED. Every
 * baseline entry lands in exactly one of four places:
 *
 *   seen, same size        → expected, silent
 *   seen, different size   → `changed-*`
 *   measured, not seen     → `fixed-*` — "remove it from the baseline"
 *   NOT measured           → `unmeasured-*` — the anchor pair, the statement
 *                            day or the account is gone, so nothing was asked
 *
 * The last two used to be one branch. Following `fixed-*`'s advice for an
 * unmeasured entry deletes the record of a disagreement nobody resolved, on the
 * hook that runs before every commit — a witness lost, reported as a fix.
 *
 * A break has one case more. An anchor that ARRIVED inside its window divides
 * it, and the halves still measure the whole: `fixed-break` when they add up to
 * zero, `split-break` when they do not.
 */
export function compareToBaseline(
  observed: LedgerObservation,
  baseline: LedgerBaseline,
): LedgerFailure[] {
  const failures: LedgerFailure[] = [];

  const accounts = new Set([...Object.keys(observed.breaks), ...Object.keys(baseline.breaks)]);
  for (const account of [...accounts].sort()) {
    const seen = new Map((observed.breaks[account] ?? []).map((b) => [windowKey(b), b]));
    const known = new Map((baseline.breaks[account] ?? []).map((b) => [windowKey(b), b]));

    for (const [key, b] of seen) {
      const before = known.get(key);
      if (before === undefined) {
        failures.push({
          kind: "new-break",
          account,
          detail: `${b.from} → ${b.to} does not close, off by ${formatCents(b.offByCents)}`,
        });
      } else if (before.offByCents !== b.offByCents) {
        failures.push({
          kind: "changed-break",
          account,
          detail:
            `${b.from} → ${b.to} is a known break, but its size moved ` +
            `${formatCents(before.offByCents)} → ${formatCents(b.offByCents)}`,
        });
      }
    }
    const walked = observed.chainWindows[account] ?? [];
    for (const [key, b] of known) {
      if (seen.has(key)) continue;
      const span = windowsSpanning(walked, b.from, b.to);
      if (span === null) {
        failures.push({
          kind: "unmeasured-break",
          account,
          detail:
            `${b.from} → ${b.to} (${formatCents(b.offByCents)}) is recorded as a known break, but the walk no ` +
            `longer stops on both of those days — nothing was measured across it, so it has not closed. Find ` +
            `which anchor left before touching the baseline`,
        });
        continue;
      }
      const spanOffByCents = span.reduce((sum, w) => sum + (seen.get(windowKey(w))?.offByCents ?? 0), 0);
      if (spanOffByCents !== 0) {
        failures.push({
          kind: "split-break",
          account,
          detail:
            `${b.from} → ${b.to} is recorded as a known break of ${formatCents(b.offByCents)}, but an anchor ` +
            `inside it now divides it into ${span.length} windows that together are still off by ` +
            `${formatCents(spanOffByCents)} — it has not closed. Record the windows that do not close in its place`,
        });
        continue;
      }
      failures.push({
        kind: "fixed-break",
        account,
        detail:
          `${b.from} → ${b.to} (${formatCents(b.offByCents)}) is recorded as a known break but now closes — ` +
          `remove it from the baseline so its return would be noticed`,
      });
    }
  }

  const synthAccounts = new Set([
    ...Object.keys(observed.syntheticNetCents),
    ...Object.keys(baseline.syntheticNetCents),
  ]);
  const readAccounts = new Set(observed.accounts);
  for (const account of [...synthAccounts].sort()) {
    const then = baseline.syntheticNetCents[account] ?? 0;
    // an account nobody read has no total at all — `?? 0` below would invent one
    if (observed.syntheticNetCents[account] === undefined && !readAccounts.has(account)) {
      failures.push({
        kind: "unmeasured-synthetic",
        account,
        detail:
          `${formatCents(then)} of money with no source document is recorded for this account, but no account ` +
          `by this name was read — renamed or removed? Money nobody counted has not gone`,
      });
      continue;
    }
    const now = observed.syntheticNetCents[account] ?? 0;
    if (now === then) continue;
    failures.push({
      kind: "synthetic-drift",
      account,
      detail:
        `money in the balance chain with no source document moved ` +
        `${formatCents(then)} → ${formatCents(now)} (${formatCents(now - then)})`,
    });
  }

  /*
   * Same four-way comparison as a chain break, and for the same reason: a
   * baseline that listed a disagreement which has since been fixed has stopped
   * describing the ledger, and would call that disagreement expected the next
   * time it returned — while one whose statement day was never valued has not
   * been fixed at all.
   */
  const anchorAccounts = new Set([
    ...Object.keys(observed.valueAnchors),
    ...Object.keys(baseline.valueAnchors),
  ]);
  for (const account of [...anchorAccounts].sort()) {
    const seen = new Map((observed.valueAnchors[account] ?? []).map((d) => [d.on, d]));
    const known = new Map((baseline.valueAnchors[account] ?? []).map((d) => [d.on, d]));
    for (const [on, d] of seen) {
      const before = known.get(on);
      if (before === undefined) {
        failures.push({
          kind: "new-value-drift",
          account,
          detail: `on ${on} the ledger values the holdings ${formatCents(d.offByCents)} away from what the statement printed`,
        });
      } else if (before.offByCents !== d.offByCents) {
        failures.push({
          kind: "changed-value-drift",
          account,
          detail:
            `${on} is a known disagreement, but its size moved ` +
            `${formatCents(before.offByCents)} → ${formatCents(d.offByCents)}`,
        });
      }
    }
    const valued = new Set(observed.valuedAnchorDays[account] ?? []);
    // a statement the app could not value is still THERE — `unpriced-anchor` below says so, once
    const unvalued = new Set(observed.unpricedAnchors.filter((a) => a.account === account).map((a) => a.on));
    for (const [on, d] of known) {
      if (seen.has(on)) continue;
      if (unvalued.has(on)) continue;
      if (!valued.has(on)) {
        failures.push({
          kind: "unmeasured-value-drift",
          account,
          detail:
            `${on} (${formatCents(d.offByCents)}) is recorded as a known disagreement, but no statement on that ` +
            `day was valued — the witness is gone, not the disagreement. Find what removed it (an un-import, a ` +
            `renamed account) before touching the baseline`,
        });
        continue;
      }
      failures.push({
        kind: "fixed-value-drift",
        account,
        detail:
          `${on} (${formatCents(d.offByCents)}) is recorded as a known disagreement but now agrees — ` +
          `remove it from the baseline so its return would be noticed`,
      });
    }
  }

  for (const s of observed.staleVerdicts) {
    failures.push({
      kind: "stale-verdict",
      account: s.account,
      detail:
        `${s.periodStart} stores a gap of ${formatCents(s.storedGapCents ?? 0)} but recomputes to ` +
        `${formatCents(s.freshGapCents ?? 0)} — the ledger changed after the verdict was written`,
    });
  }

  /*
   * An anchor the app cannot value is its own finding. It is not a drift — a
   * missing valuation reported as a drift of the whole printed amount would read
   * as a total loss — and it is not nothing, because an anchor nobody can check
   * is an anchor that is not doing its job.
   *
   * ⛔ ONE line per statement. Measured on a copy of the owner's ledger
   * (2026-09-15, review): with this finding built in the script and the
   * baseline's unmeasured branch built here, a deactivated Robinhood Brokerage
   * printed 29 findings for 25 statements, four of them saying "the witness is
   * gone" about statements that were still there.
   */
  for (const a of observed.unpricedAnchors) {
    const recorded = baseline.valueAnchors[a.account]?.find((d) => d.on === a.on);
    failures.push({
      kind: "unpriced-anchor",
      account: a.account,
      detail:
        `${a.on} prints ${formatCents(a.printedCents)} of securities and the ledger has no valuation for that day` +
        (recorded === undefined
          ? ""
          : ` — its recorded disagreement of ${formatCents(recorded.offByCents)} was not re-measured, so it has not agreed`),
    });
  }

  return failures;
}

export function formatLedgerFailures(failures: readonly LedgerFailure[]): string {
  return failures.map((f) => `  [${f.kind}] ${f.account}: ${f.detail}`).join("\n");
}
