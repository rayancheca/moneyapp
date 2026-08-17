import type { ReconciliationState } from "@/db/schema/imports";
import type { TransactionStatus } from "@/db/schema/transactions";

/**
 * What a statement period's printed balances say about the ledger under them.
 *
 * This rule used to live inline inside `reconcileAccounts` (import/service.ts),
 * which was the only thing that ever applied it — and that was fine right up
 * until something else needed to ask the same question. A staleness check has
 * to recompute a verdict to notice a stored one has rotted, and a checker that
 * re-implements the rule is a checker that can disagree with the writer and
 * call a correct verdict stale. So the rule lives here, once, and both call it.
 *
 * ⚠️ The statuses below are NOT the statuses balance replay reads. Replay uses
 * REPLAY_STATUSES (active + excluded); reconciliation additionally counts
 * `quarantined`, because a quarantined row is one whose membership is under
 * review — it was printed on a statement, so the statement's own arithmetic
 * still includes it. The two lists are deliberately different and the test
 * pins that, so a future edit that "tidies" them into one has to argue for it.
 */
export const RECONCILE_STATUSES = [
  "active",
  "quarantined",
  "excluded",
] as const satisfies readonly TransactionStatus[];

export interface PeriodBalances {
  beginningBalanceCents: number | null;
  endingBalanceCents: number | null;
}

export interface Verdict {
  reconciliation: ReconciliationState;
  gapCents: number | null;
  marketChangeCents: number | null;
}

/** What a stored row carries — the two fields a recompute can contradict. */
export interface StoredVerdict {
  reconciliation: ReconciliationState;
  gapCents: number | null;
}

/**
 * Grade one period against the movement posted inside it.
 *
 * `movementCents` is the signed sum of RECONCILE_STATUSES rows whose posted_on
 * falls in [periodStart, periodEnd].
 *
 * An investment period can never be graded `gap`: buys and sells are
 * net-worth-neutral inside the account and market movement is not a
 * transaction, so the residual is not a discrepancy — it IS the market change,
 * and gets recorded as such rather than accused of being missing money.
 */
export function periodVerdict(
  period: PeriodBalances,
  movementCents: number,
  options: { isInvestment: boolean },
): Verdict {
  const { beginningBalanceCents: from, endingBalanceCents: to } = period;
  if (from === null || to === null) {
    return { reconciliation: "not_applicable", gapCents: null, marketChangeCents: null };
  }

  if (options.isInvestment) {
    return {
      reconciliation: "value_anchor",
      gapCents: null,
      marketChangeCents: to - from - movementCents,
    };
  }

  const gap = to - (from + movementCents);
  return {
    reconciliation: gap === 0 ? "reconciled" : "gap",
    gapCents: gap === 0 ? null : gap,
    marketChangeCents: null,
  };
}

/**
 * Has a stored verdict stopped describing the ledger beneath it?
 *
 * `reconciliation` and `gap_cents` are written ONLY at import time. Nothing
 * revisits them — not `rebuildAccount`, not a status flip, not a deletion. So a
 * later change to the transactions can leave a period asserting a number that
 * was true once and is not true now, and the UI has no way to tell.
 *
 * That is not hypothetical: a hand-entered +$3,579.67 plug on Robinhood Cash
 * held July 2026 at a stored gap of $231.85 while the real figure was
 * $3,811.52 — the arbiter under-reporting a hole by 16x, which is the one
 * failure mode a reconciliation arbiter cannot have.
 *
 * `accepted` is exempt: it means a human looked at a break and signed it off,
 * so it is a decision rather than a measurement, and `reconcileAccounts` skips
 * those periods on purpose. Recomputing one and comparing would report every
 * accepted period as permanent drift.
 */
export function isVerdictStale(stored: StoredVerdict, fresh: Verdict): boolean {
  if (stored.reconciliation === "accepted") return false;
  return stored.reconciliation !== fresh.reconciliation || stored.gapCents !== fresh.gapCents;
}
