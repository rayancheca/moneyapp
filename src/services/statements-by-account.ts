import { asc } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { statementPeriods, type ReconciliationState } from "@/db/schema/imports";
import type { StatementPeriodRef } from "@/lib/statement-holes";

/**
 * Which `statement_periods` rows are STATEMENTS — the one reading of them that /imports' statement schedule
 * (`statementPulls`), its Missing statements panel (`statementGaps`) and its "What the statements proved" list
 * all take.
 *
 * ⛔ `not_applicable` periods are not statements, and leaving them out is load-bearing. That state means "no
 * printed balances": what a Chase *Spending Report* parses into — the real ledger holds two on Chase Sapphire,
 * 2025-01-01 → 2025-12-31 and 2026-01-01 → 2026-07-10 — and what a balance-less export declares (a Rocket Money
 * CSV on Wells Fargo, 2026-07-27 → 2026-08-24). Neither is issued on the account's cycle:
 *
 *   - as a CLOSE, the Jul 10 report's end is the newest on Sapphire, so counting it would report the cycle as
 *     closing on the 10th (it closes on the 2nd) and the August statement, already imported, as outstanding;
 *   - as COVERAGE, a report spans many cycles, so a statement missing under it would read as present.
 *
 * Every other state IS a statement: `reconciled` and `accepted` are ones that balanced or were signed off, `gap`
 * is one that did not, and `value_anchor` is an investment statement priced rather than reconciled. All four
 * arrive on the account's cycle, which is the property both panels read.
 *
 * ⚠️ The state is a proxy, and on this ledger it is wrong twice: Robinhood prints no balances on an account's
 * OPENING statement (Robinhood Cash, Dec 2023; Robinhood Agentic, Jun 2026), so each account's first statement is
 * left out. Neither panel moves today — it is the oldest close, with no hole before it — but a SECOND statement
 * missing behind one would sit before the first statement counted, where no hole is looked for. Telling an
 * opening statement from a report needs the file's kind, not its balances, and nothing records that yet.
 *
 * 🔴 Two callers, and only one of them applied it. Missing statements read every row, so its hole walk's frontier
 * jumped to a report's end: measured by the review on a copy of his ledger, 2026-10-08, drop any of Sapphire's
 * statements from Mar 2025 to Jun 2026 and the panel listed nothing — nor did the schedule, whose last close is a
 * later statement — and drop the one closing Aug 2, 2026 and it read Jul 11 – Aug 2, the report's last day
 * standing in for a close. Dropping each of the copy's 256 statements in turn, those 17 now read as the statement
 * missing; the two behind Robinhood's opening statements (above) no longer show, nor does a one-day Wells Fargo
 * window (Aug 25) the Rocket Money CSV's end opened; the other 236 read as before.
 */
export function countsAsStatement(reconciliation: ReconciliationState): boolean {
  return reconciliation !== "not_applicable";
}

/** Every account's statements (`countsAsStatement`), oldest first — the rows both statement panels read. */
export function statementsByAccount(db: AppDatabase): Map<string, StatementPeriodRef[]> {
  const rows = db
    .select({
      accountId: statementPeriods.accountId,
      start: statementPeriods.periodStart,
      end: statementPeriods.periodEnd,
      reconciliation: statementPeriods.reconciliation,
    })
    .from(statementPeriods)
    .orderBy(asc(statementPeriods.periodStart), asc(statementPeriods.periodEnd))
    .all();
  const out = new Map<string, StatementPeriodRef[]>();
  for (const row of rows) {
    if (!countsAsStatement(row.reconciliation)) continue;
    out.set(row.accountId, [...(out.get(row.accountId) ?? []), { start: row.start, end: row.end }]);
  }
  return out;
}
