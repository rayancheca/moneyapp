import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods, type ReconciliationState } from "@/db/schema/imports";
import { carriesBalances, countsAsStatement } from "./statements-by-account";

/** One `statement_periods` row as /imports lists it. */
export interface ImportsPeriod {
  readonly id: string;
  readonly importFileId: string;
  readonly accountName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reconciliation: ReconciliationState;
  readonly gapCents: number | null;
  readonly marketChangeCents: number | null;
  /** the parser that read its file — what tells an opening statement from a report (`countsAsStatement`) */
  readonly parserProfile: string | null;
}

export interface StatementEvidence {
  /** every period, newest close first — the three tiles count their verdicts */
  readonly periods: ImportsPeriod[];
  /** the ones that printed balances (`carriesBalances`), in the same order — "What the statements proved" lists these */
  readonly evidence: ImportsPeriod[];
  /** imported DOCUMENTS whose balance-less periods are no statement at all: a Spending Report, a balance-less export */
  readonly reportDocuments: number;
  /** balance-less periods that ARE statements (`countsAsStatement`): an account's first, printed without an opening */
  readonly openingStatements: number;
}

/**
 * What /imports' "What the statements proved" reads of `statement_periods`: the periods that printed balances, and —
 * for its footer — what each period it leaves out IS, by the rule the statement schedule and Statements you do not
 * have read (`countsAsStatement`), so the page cannot call a statement the schedule counts anything but a statement.
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-12: the footer counted `periods.length - evidence.length` and called
 * all five "a spending report, an export without a closing figure" — two Chase Spending Reports and a Rocket Money
 * export, yes, but also Robinhood Cash's opening statement (Dec 2023) and Robinhood Agentic's (Jun 2026), both on
 * the schedule above it as statements. It now reads "3 imported documents …" and "2 statements were each an
 * account's first …" (`balanceLessNotes`, lib/statement-evidence-notes.ts).
 *
 * ⚠️ Reports are counted as DOCUMENTS, the word the footer uses: one OFX download can print two accounts with no
 * balance, two periods of one file. Opening statements are counted as statements — Agentic's came out of a PDF that
 * also printed Robinhood Cash's and the brokerage book's balances, so it is a statement without balances inside a
 * document that had them.
 */
export function statementEvidence(db: AppDatabase): StatementEvidence {
  const periods: ImportsPeriod[] = db
    .select({
      id: statementPeriods.id,
      importFileId: statementPeriods.importFileId,
      accountName: accounts.name,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
      reconciliation: statementPeriods.reconciliation,
      gapCents: statementPeriods.gapCents,
      marketChangeCents: statementPeriods.marketChangeCents,
      parserProfile: importFiles.parserProfile,
    })
    .from(statementPeriods)
    .innerJoin(accounts, eq(statementPeriods.accountId, accounts.id))
    // a left join, as `statementsByAccount`'s: a period is never dropped for want of its file row
    .leftJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
    .orderBy(desc(statementPeriods.periodEnd))
    .all();

  const evidence = periods.filter((p) => carriesBalances(p.reconciliation));
  const balanceLess = periods.filter((p) => !carriesBalances(p.reconciliation));
  const openingStatements = balanceLess.filter((p) => countsAsStatement(p)).length;
  const reportDocuments = new Set(balanceLess.filter((p) => !countsAsStatement(p)).map((p) => p.importFileId)).size;
  return { periods, evidence, reportDocuments, openingStatements };
}
