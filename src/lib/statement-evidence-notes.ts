/** The counts `statementEvidence` (services/statement-evidence.ts) gives the footer, one per `balanceLessKind`. */
export interface BalanceLessCounts {
  /** documents that recorded no balance for the account they declare, no OFX download among them: a Spending Report,
   *  a balance-less export */
  readonly reportDocuments: number;
  /** OFX downloads the ledger keeps no balance of on the account they declare (`download_no_balance`): a LEDGERBAL
   *  another file re-recorded that day, or none printed — the ledger cannot tell which */
  readonly downloadDocuments: number;
  /** documents that recorded the account's balance but no opening one: an OFX download's LEDGERBAL */
  readonly recordedBalanceDocuments: number;
  /** statements printed without an opening */
  readonly openingStatements: number;
  /** of `openingStatements`, those no earlier period of their account precedes (`firstOnAccount`) */
  readonly firstStatements: number;
}

/**
 * The footer under /imports' "What the statements proved": one sentence per kind of period the list leaves out, so
 * every period the list does not show is named by one of them, and each says what it counts. ⚠️ They do not add up
 * to the periods left out: reports and downloads are counted as DOCUMENTS — one OFX download can declare two
 * accounts' periods, and one that recorded a balance on one of them and none on the other is named twice
 * (`statementEvidence`) — and only opening statements one by one.
 *
 * 🔴 One sentence used to cover both, and called a Robinhood opening statement "a spending report, an export without
 * a closing figure" while the statement schedule above counted it as a statement (his ledger, 2026-10-12: "5 imported
 * documents …", two of them opening statements). An opening statement is named as what it is — a statement — and why
 * it proves nothing here: no opening was printed, so nothing could fail.
 *
 * 🔴 …and that sentence said two things nothing checked. "An account's first": the parser knows only that the
 * statement printed `N/A` for its opening — it is said now only when no earlier period of each account precedes it
 * (`firstStatements`). "The statement schedule counts them": measured on a copy of his ledger 2026-10-13, Robinhood
 * Cash's row reads its last 12 closes, Sep 2025 → Aug 2026, and its opening statement closed Dec 2023 — so the
 * schedule is not named at all.
 *
 * 🔴 …and called a download that recorded a closing balance "an export without a closing figure": the review of
 * 601f155, on a copy of data/e2e.db (2026-10-12), "27 imported documents carried no balance to check" of 27 OFX
 * downloads, 18 owning the balance each recorded. One is named as what it recorded, and why its days prove nothing
 * here — no opening one, so they reconcile nothing; the sheet's period line makes the same claims of it (provenance.ts
 * `periodDetail`). The other nine printed a LEDGERBAL their quarter's CSV re-recorded, and the ledger keeps the last
 * writer's: each is named as a download the ledger keeps no balance of (`downloadDocuments`), never as a report or a
 * file that carried none — and the sheets make the same claims of it (provenance.ts `periodDetail`, `rowHeadline`).
 */
export function balanceLessNotes(counts: BalanceLessCounts): string[] {
  return [reportNote(counts), downloadNote(counts), recordedBalanceNote(counts), openingNote(counts)].filter(
    (note): note is string => note !== null,
  );
}

function reportNote({ reportDocuments: n }: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  return (
    `${n} imported ${one ? "document" : "documents"} carried no balance to check — a spending report, an export ` +
    `without a closing figure — and ${one ? "is" : "are"} neither a period above nor in the counts.`
  );
}

function downloadNote({ downloadDocuments: n }: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  return (
    `${n} imported ${one ? "download" : "downloads"} left the ledger no balance of ${one ? "its" : "their"} own and ` +
    `printed no opening one, so the days ${one ? "it declares" : "they declare"} reconcile nothing — ` +
    `${one ? "it is" : "they are"} neither a period above nor in the counts.`
  );
}

function recordedBalanceNote({ recordedBalanceDocuments: n }: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  return (
    `${n} imported ${one ? "document" : "documents"} recorded a balance but no opening one, so the days ` +
    `${one ? "it declares" : "they declare"} reconcile nothing — ${one ? "it is" : "they are"} neither a period ` +
    "above nor in the counts."
  );
}

function openingNote({ openingStatements: n, firstStatements }: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  // "first" only when it is true of every one counted: a mixed count says what all of them share
  const what =
    firstStatements !== n
      ? `${n} ${one ? "statement" : "statements"} printed no opening balance`
      : one
        ? "1 statement was an account's first and printed no opening balance"
        : `${n} statements were each an account's first and printed no opening balance`;
  return (
    `${what}, so nothing in ${one ? "it" : "them"} could have failed — ${one ? "it is" : "they are"} neither a ` +
    "period above nor in the counts."
  );
}
