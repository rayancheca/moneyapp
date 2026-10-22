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
  /** of `recordedBalanceDocuments`, those an OFX parser read (`isOfxDownload`): what lets the footer say "downloads" */
  readonly recordedBalanceDownloads: number;
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
 * it proves nothing here: no opening was printed, so nothing could fail of an account's first, and the days of a later
 * one reconcile nothing (`openingNote`).
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

/**
 * ⛔ "On an account it declares": one download can print two accounts and record a balance on one of them only — then
 * it is named here for the other, and in `recordedBalanceNote` for that one (`statementEvidence`). 🔴 Review of 74f25fb
 * (2026-10-14): "left the ledger no balance of its own" was false of such a file.
 */
function downloadNote({ downloadDocuments: n }: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  return (
    `${n} imported ${one ? "download" : "downloads"} left the ledger no balance of ${one ? "its" : "their"} own ` +
    `on an account ${one ? "it declares" : "they declare"} and printed no opening one, so ${one ? "its" : "their"} ` +
    `days reconcile nothing — ${one ? "it is" : "they are"} neither a period above nor in the counts.`
  );
}

/**
 * ⛔ "Downloads" only when an OFX parser read every one counted, as `downloadNote`'s are; a mixed count says what all of
 * them are, documents. 🔴 Review of 74f25fb (2026-10-14): on a copy of data/e2e.db the footer read "9 imported
 * downloads …" over "18 imported documents recorded a balance …", every one of the 27 a QFX download.
 */
function recordedBalanceNote({
  recordedBalanceDocuments: n,
  recordedBalanceDownloads,
}: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  const noun = recordedBalanceDownloads === n ? (one ? "download" : "downloads") : one ? "document" : "documents";
  return (
    `${n} imported ${noun} recorded a balance but no opening one, so the days ` +
    `${one ? "it declares" : "they declare"} reconcile nothing — ${one ? "it is" : "they are"} neither a period ` +
    "above nor in the counts."
  );
}

/**
 * ⛔ "First" — and with it "nothing could have failed" — only when it is true of every one counted: a mixed count
 * says what all of them share, that the days they declare reconcile nothing. 🔴 Review of 74f25fb (2026-10-14): a
 * later statement that printed no opening kept "nothing in it could have failed", false once a balance comes before
 * it — the chain replays onto its close from that balance, and can miss it (provenance.ts `NO_OPENING_TO_RECONCILE`).
 * The sheets say the same of each (provenance.ts `openingStatementWhy`).
 */
function openingNote({ openingStatements: n, firstStatements }: BalanceLessCounts): string | null {
  if (n === 0) return null;
  const one = n === 1;
  const neither = `— ${one ? "it is" : "they are"} neither a period above nor in the counts.`;
  if (firstStatements !== n) {
    return (
      `${n} ${one ? "statement" : "statements"} printed no opening balance, so the days ` +
      `${one ? "it declares" : "they declare"} reconcile nothing ${neither}`
    );
  }
  const what = one
    ? "1 statement was an account's first and printed no opening balance"
    : `${n} statements were each an account's first and printed no opening balance`;
  return `${what}, so nothing in ${one ? "it" : "them"} could have failed ${neither}`;
}
