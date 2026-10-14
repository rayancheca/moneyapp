import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods, type ReconciliationState } from "@/db/schema/imports";
import type { BalanceLessCounts } from "@/lib/statement-evidence-notes";
import { fileRecordedBalanceOnSql } from "./file-recorded-balance";
import { balanceLessKind, carriesBalances, firstOnAccountSql, type BalanceLessKind } from "./statements-by-account";

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
  /** the newest balance its file recorded for the account (`fileRecordedBalanceOn`) — what tells a download from a
   *  report */
  readonly recordedOn: string | null;
  /** no period of its account starts before it (`firstOnAccount`) — what lets the footer say "an account's first" */
  readonly firstOnAccount: boolean;
}

export interface StatementEvidence {
  /** every period, newest close first — the three tiles count their verdicts */
  readonly periods: ImportsPeriod[];
  /** the ones that printed balances (`carriesBalances`), in the same order — "What the statements proved" lists these */
  readonly evidence: ImportsPeriod[];
  /** what the rest are, one count per `balanceLessKind` — the footer's (`balanceLessNotes`) */
  readonly balanceLess: BalanceLessCounts;
}

/**
 * What /imports' "What the statements proved" reads of `statement_periods`: the periods that printed balances, and —
 * for its footer — what each period it leaves out IS (`balanceLessKind`): by the rule the statement schedule and
 * Statements you do not have read (`countsAsStatement`), so the page cannot call a statement the schedule counts
 * anything but a statement, and by what its file recorded (`fileRecordedBalanceOn`), so it cannot call a download that
 * recorded a balance "an export without a closing figure".
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-12: the footer counted `periods.length - evidence.length` and called
 * all five "a spending report, an export without a closing figure" — two Chase Spending Reports and a Rocket Money
 * export, yes, but also Robinhood Cash's opening statement (Dec 2023) and Robinhood Agentic's (Jun 2026), both on
 * the schedule above it as statements. It now reads "3 imported documents …" and "2 statements were each an
 * account's first …" (`balanceLessNotes`, lib/statement-evidence-notes.ts).
 *
 * 🔴 …and the split still read the rest off the state. The review of 601f155, on a copy of data/e2e.db: "27 imported
 * documents carried no balance to check — a spending report, an export without a closing figure" of 27 OFX downloads,
 * 18 owning the balance each recorded on its account. Not reachable on his ledger today (its three own none, measured
 * on the copy); it is the day he imports a Chase QFX download.
 *
 * 🔴 …and the other nine still read "carried no balance to check — a spending report, an export without a closing
 * figure": each printed a LEDGERBAL on its last day that its quarter's CSV re-recorded, and the ledger keeps one
 * `ofx_ledger` balance per account and day, the last writer's (⚖️ anchor ownership as shipped, handoff 2026-10-13
 * §6A). A period an OFX parser read whose file owns no balance on the account (`download_no_balance`) is counted as a
 * DOWNLOAD, named by what the ledger keeps of it — never as a report, nor as one that printed none.
 *
 * 🔴 …and that split read the parser HERE, beside `balanceLessKind`, so the sheets that read the kind still called
 * the same nine "this file carries no balances" (a copy of data/e2e.db, 2026-10-14: Chase8721_Activity_2026-04-01_
 * 2026-06-30.QFX's period sheet, and the period line on its rows' and Chase Savings' days' sheets). The kind tells a
 * download from a report now, and this counts kinds.
 *
 * ⚠️ Reports and downloads are counted as DOCUMENTS, the word the footer uses: one OFX download can print two
 * accounts with no balance, two periods of one file — and one that recorded a balance on one account and none on the
 * other is named in both sentences, each true of one of them. Opening statements are counted as statements —
 * Agentic's came out of a PDF that also printed Robinhood Cash's and the brokerage book's balances, so it is a
 * statement without balances inside a document that had them — and those no earlier period of their account precedes
 * (`firstOnAccount`) as their account's first.
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
      recordedOn: fileRecordedBalanceOnSql(db, statementPeriods),
      firstOnAccount: firstOnAccountSql(db, statementPeriods),
    })
    .from(statementPeriods)
    .innerJoin(accounts, eq(statementPeriods.accountId, accounts.id))
    // a left join, as `statementsByAccount`'s: a period is never dropped for want of its file row
    .leftJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
    .orderBy(desc(statementPeriods.periodEnd))
    .all();

  const evidence = periods.filter((p) => carriesBalances(p.reconciliation));
  // one reading with the period line on a row's and a day's sheet and the period's own sheet (`balanceLessKind`)
  const ofKind = (kind: BalanceLessKind) => periods.filter((p) => balanceLessKind(p) === kind);
  const documents = (kind: BalanceLessKind) => new Set(ofKind(kind).map((p) => p.importFileId)).size;
  const opening = ofKind("opening_statement");
  return {
    periods,
    evidence,
    balanceLess: {
      reportDocuments: documents("no_balance"),
      downloadDocuments: documents("download_no_balance"),
      recordedBalanceDocuments: documents("balance_recorded"),
      openingStatements: opening.length,
      firstStatements: opening.filter((p) => p.firstOnAccount).length,
    },
  };
}
