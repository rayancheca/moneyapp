import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { importFiles, statementPeriods, type ReconciliationState } from "@/db/schema/imports";
import type { StatementPeriodRef } from "@/lib/statement-holes";

/** What `countsAsStatement` reads of a period: its state, and the parser that read its file (null: none recorded). */
export interface PeriodKind {
  readonly reconciliation: ReconciliationState;
  readonly parserProfile: string | null;
}

/**
 * Which `statement_periods` rows are STATEMENTS — the one reading of them that /imports' statement schedule
 * (`statementPulls`) and its Missing statements panel (`statementGaps`) both take. Its "What the statements
 * proved" list asks a narrower question, which printed balances (`carriesBalances`, below).
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
 * ⛔ …and so is one `not_applicable` kind: an account's OPENING statement from a parser in
 * `OPENING_STATEMENT_PROFILES`. Robinhood prints `N/A` for the opening balance on an account's first statement, so
 * it parses into a balance-less period exactly as a report does (Robinhood Cash, Dec 2023; Robinhood Agentic, Jun
 * 2026 on the real ledger) — yet Robinhood issued it on the account's month-end cycle, and its close is a close. The
 * state cannot tell the two apart; the file's kind (`import_files.parser_profile`) can.
 *
 * 🔴 The state alone left both opening statements out, and with them the frontier the hole walk starts from: a
 * month missing right after one sat before the first statement counted, where no hole is looked for. Measured
 * 2026-10-08: robinhood-parse-context.test.ts — Agentic's June opening statement, July never imported, August
 * imported without its section, September imported — lost July from Missing statements (bisected to 8512476, the
 * commit that gave this rule its one home); on a copy of his ledger, dropping Agentic's July or Robinhood Cash's
 * January 2024 listed nothing, and the schedule read Agentic "unknown", two closes under the bar of three.
 *
 * 🔴 Two callers, and only one of them applied it. Missing statements read every row, so its hole walk's frontier
 * jumped to a report's end: measured by the review on a copy of his ledger, 2026-10-08, drop any of Sapphire's
 * statements from Mar 2025 to Jun 2026 and the panel listed nothing — nor did the schedule, whose last close is a
 * later statement — and drop the one closing Aug 2, 2026 and it read Jul 11 – Aug 2, the report's last day
 * standing in for a close. Dropping each of the copy's 256 statements in turn, those 17 now read as the statement
 * missing; a one-day Wells Fargo window (Aug 25) the Rocket Money CSV's end opened no longer shows; the other 236
 * read as before. The two behind Robinhood's opening statements (above) stopped showing with it, and show again
 * now the file's kind is read: re-measured the same day, those two are the only drops that differ.
 */
export function countsAsStatement(period: PeriodKind): boolean {
  if (carriesBalances(period.reconciliation)) return true;
  return period.parserProfile !== null && OPENING_STATEMENT_PROFILES.has(period.parserProfile);
}

/**
 * The parsers whose balance-less period is an account's OPENING statement, issued on its cycle like every other.
 *
 * ⛔ An allowlist, not a list of reports, because the two mistakes cost differently: a report counted as a statement
 * hides every statement missing under it and moves the close day (above), while an opening statement left out only
 * stops the hole walk looking before it. A new parser's balance-less period is a report until someone shows
 * otherwise. `robinhood-brokerage-statement-pdf` writes one only when a section prints `N/A` for its opening — its
 * cash and its brokerage book alike (`declaredRange`, profiles/robinhood-brokerage-statement-profile.ts).
 */
export const OPENING_STATEMENT_PROFILES: ReadonlySet<string> = new Set(["robinhood-brokerage-statement-pdf"]);

/**
 * Whether a period printed balances — something to reconcile or to price. This is what /imports' "What the
 * statements proved" list and its three tiles count, and it is NOT `countsAsStatement`: an opening statement arrived
 * on the cycle (the panels count it), but with no opening printed nothing in it could have failed.
 */
export function carriesBalances(reconciliation: ReconciliationState): boolean {
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
      parserProfile: importFiles.parserProfile,
    })
    .from(statementPeriods)
    // a left join: a period is never dropped for want of its file row — it is then read by its state alone
    .leftJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
    .orderBy(asc(statementPeriods.periodStart), asc(statementPeriods.periodEnd))
    .all();
  const out = new Map<string, StatementPeriodRef[]>();
  for (const row of rows) {
    if (!countsAsStatement(row)) continue;
    out.set(row.accountId, [...(out.get(row.accountId) ?? []), { start: row.start, end: row.end }]);
  }
  return out;
}
