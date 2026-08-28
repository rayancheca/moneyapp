import { and, eq, gte, lte, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { RECONCILE_STATUSES, periodVerdict } from "@/lib/reconciliation";
import { sumCents } from "@/lib/money";

/**
 * PASS 74 — re-grading a statement period against the ledger as it stands NOW.
 *
 * ⛔ `reconciliation` and `gap_cents` used to be written once, at import, and
 * nothing revisited them. A later change to the transactions — a status flip, a
 * bulk edit, a duplicate resolved, a row deleted — left a period asserting a
 * number that was true once and is not true now, and the UI had no way to tell.
 * That is not hypothetical: a hand-entered +$3,579.67 plug held July 2026 at a
 * stored gap of $231.85 while the real figure was $3,811.52.
 *
 * `pnpm ledger-check` already DETECTS that (`isVerdictStale`). This is the half
 * that stops it happening: `rebuildAccount` re-grades, so every path that can
 * change a balance re-grades with it.
 *
 * ## ⛔ Why this is NOT `reconcileAccounts`
 *
 * `reconcileAccounts` does two jobs: it grades, and it QUARANTINES — flipping
 * the period's own file's rows between `active` and `quarantined` on the way.
 * That second job is why calling it from `rebuildAccount` would be unsafe:
 *
 *  - `rebuildAccount` is called BY the paths that change statuses (bulk edit,
 *    duplicate resolution, manual rows). Grading from inside it would let a
 *    rebuild change more statuses, which nothing would then rebuild for — a
 *    cascade with no fixed point.
 *  - Quarantine is a decision about a FILE: these rows came in together and
 *    hold together until the period is understood. A later edit that opens a
 *    gap is the owner's own change, and hiding rows behind his back during a
 *    rebuild he did not ask for is a surprise, not a safeguard.
 *
 * So the two jobs are separated. The verdict is kept honest everywhere; the
 * quarantine stays where the file that owns the rows is known — at import.
 *
 * ⚠️ `reconcileAccounts` still writes its own verdict, in the same transaction
 * as the quarantine it belongs with — splitting that would let a crash leave a
 * verdict without the status change it implies. What is NOT duplicated is the
 * RULE: both paths go through `periodVerdict`, which is the single definition,
 * for the same reason `ledger-check` recomputes with it rather than its own
 * copy. A test asserts the two agree — after `reconcileAccounts` has run, this
 * function must find nothing to change — so "two paths, one answer" is
 * enforced rather than promised.
 */

/** What a re-grade did, so a caller can assert nothing else moved. */
export interface RegradeResult {
  /** periods whose stored verdict was replaced */
  changed: number;
  /** periods examined — graded or not */
  examined: number;
}

/**
 * Re-grade every gradeable period on one account. Statuses are never touched.
 *
 * ⚠️ `accepted` is skipped, exactly as `reconcileAccounts` skips it: a period
 * the owner has explicitly accepted is a decision, and re-grading would undo it
 * on the next rebuild.
 */
export function regradeStatementPeriods(db: AppDatabase, accountId: string): RegradeResult {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return { changed: 0, examined: 0 };

  const periods = db
    .select()
    .from(statementPeriods)
    .where(eq(statementPeriods.accountId, accountId))
    .all();

  let changed = 0;
  let examined = 0;
  for (const period of periods) {
    if (period.reconciliation === "accepted") continue;
    if (period.beginningBalanceCents === null || period.endingBalanceCents === null) continue;
    examined += 1;

    const rows = db
      .select({ amountCents: transactions.amountCents })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          // 'excluded' hides a row from ANALYTICS — the money still moved, so
          // reconciliation and balances must include it
          inArray(transactions.status, [...RECONCILE_STATUSES]),
          gte(transactions.postedOn, period.periodStart),
          lte(transactions.postedOn, period.periodEnd),
        ),
      )
      .all();

    const verdict = periodVerdict(period, sumCents(rows.map((r) => r.amountCents)), {
      isInvestment: account.type === "investment",
    });
    if (
      verdict.reconciliation === period.reconciliation &&
      verdict.gapCents === period.gapCents &&
      verdict.marketChangeCents === period.marketChangeCents
    ) {
      continue;
    }
    db.update(statementPeriods)
      .set({
        reconciliation: verdict.reconciliation,
        gapCents: verdict.gapCents,
        marketChangeCents: verdict.marketChangeCents,
      })
      .where(eq(statementPeriods.id, period.id))
      .run();
    changed += 1;
  }
  return { changed, examined };
}
