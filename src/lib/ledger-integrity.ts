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

export interface ChainBreak {
  from: string;
  to: string;
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

export interface LedgerObservation {
  breaks: Record<string, ChainBreak[]>;
  /** net cents of replay-status rows with no import file, per account */
  syntheticNetCents: Record<string, number>;
  staleVerdicts: StaleVerdict[];
  /** printed-vs-derived market value, per account (pass 73) */
  valueAnchors: Record<string, ValueAnchorDrift[]>;
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
    | "synthetic-drift"
    | "stale-verdict"
    | "new-value-drift"
    | "changed-value-drift"
    | "fixed-value-drift"
    | "unpriced-anchor";
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
): { drifts: Record<string, ValueAnchorDrift[]>; unpriced: ValueAnchor[] } {
  const drifts: Record<string, ValueAnchorDrift[]> = {};
  const unpriced: ValueAnchor[] = [];
  for (const a of anchors) {
    if (a.derivedCents === null) {
      unpriced.push(a);
      continue;
    }
    const offByCents = a.derivedCents - a.printedCents;
    if (Math.abs(offByCents) <= toleranceCents) continue;
    (drifts[a.account] ??= []).push({ on: a.on, offByCents });
  }
  for (const list of Object.values(drifts)) list.sort((x, y) => x.on.localeCompare(y.on));
  return { drifts, unpriced };
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
const windowKey = (b: ChainBreak): string => `${b.from}→${b.to}`;

/**
 * Observation vs recorded baseline.
 *
 * A DISAPPEARING break fails too. That reads odd — a fixed break is good news —
 * but a baseline listing a break that no longer exists is a baseline that has
 * stopped describing the ledger, and the next time that break returns the check
 * would call it expected. Good news still has to be written down.
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
    for (const [key, b] of known) {
      if (seen.has(key)) continue;
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
  for (const account of [...synthAccounts].sort()) {
    const now = observed.syntheticNetCents[account] ?? 0;
    const then = baseline.syntheticNetCents[account] ?? 0;
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
   * Same three-way comparison as a chain break, and for the same reason: a
   * baseline that listed a disagreement which has since been fixed has stopped
   * describing the ledger, and would call that disagreement expected the next
   * time it returned.
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
    for (const [on, d] of known) {
      if (seen.has(on)) continue;
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

  return failures;
}

export function formatLedgerFailures(failures: readonly LedgerFailure[]): string {
  return failures.map((f) => `  [${f.kind}] ${f.account}: ${f.detail}`).join("\n");
}
