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

export interface LedgerObservation {
  breaks: Record<string, ChainBreak[]>;
  /** net cents of replay-status rows with no import file, per account */
  syntheticNetCents: Record<string, number>;
  staleVerdicts: StaleVerdict[];
}

export interface LedgerBaseline {
  breaks: Record<string, ChainBreak[]>;
  syntheticNetCents: Record<string, number>;
}

export type LedgerFailure = {
  kind: "new-break" | "changed-break" | "fixed-break" | "synthetic-drift" | "stale-verdict";
  account: string;
  detail: string;
};

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
