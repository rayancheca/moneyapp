/** The two counts `statementEvidence` (services/statement-evidence.ts) gives the footer. */
export interface BalanceLessCounts {
  readonly reportDocuments: number;
  readonly openingStatements: number;
}

/**
 * The footer under /imports' "What the statements proved": one sentence per kind of period the list leaves out, so
 * the list, its older-periods line and these add up to the periods imported, and each says what it counts.
 *
 * 🔴 One sentence used to cover both, and called a Robinhood opening statement "a spending report, an export without
 * a closing figure" while the statement schedule above counted it as a statement (his ledger, 2026-10-12: "5 imported
 * documents …", two of them opening statements). An opening statement is named as what the schedule takes it for —
 * a statement, an account's first — and why it proves nothing here: no opening was printed, so nothing could fail.
 */
export function balanceLessNotes({ reportDocuments, openingStatements }: BalanceLessCounts): string[] {
  const notes: string[] = [];
  if (reportDocuments > 0) {
    const one = reportDocuments === 1;
    notes.push(
      `${reportDocuments} imported ${one ? "document" : "documents"} carried no balance to check — a spending report, ` +
        `an export without a closing figure — and ${one ? "is" : "are"} neither a period above nor in the counts.`,
    );
  }
  if (openingStatements > 0) {
    const one = openingStatements === 1;
    notes.push(
      one
        ? "1 statement was an account's first and printed no opening balance — the statement schedule counts it, but " +
            "nothing in it could have failed, so it is neither a period above nor in the counts."
        : `${openingStatements} statements were each an account's first and printed no opening balance — the statement ` +
            "schedule counts them, but nothing in them could have failed, so they are neither a period above nor in the " +
            "counts.",
    );
  }
  return notes;
}
