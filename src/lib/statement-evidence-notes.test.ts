import { describe, expect, test } from "vitest";
import { balanceLessNotes, type BalanceLessCounts } from "./statement-evidence-notes";

/**
 * The footer under /imports' "What the statements proved": what each period it leaves out IS. The counts come from
 * `statementEvidence` (services/statement-evidence.test.ts), split by `balanceLessKind` — the statement schedule's own
 * rule for an opening statement, and the ledger's balances for a file that recorded one — and by what read the file.
 */
const NONE: BalanceLessCounts = {
  reportDocuments: 0,
  downloadDocuments: 0,
  recordedBalanceDocuments: 0,
  recordedBalanceDownloads: 0,
  openingStatements: 0,
  firstStatements: 0,
};

describe("balanceLessNotes", () => {
  test("his ledger, 2026-10-13: three documents no statement at all, two statements each its account's first", () => {
    expect(balanceLessNotes({ ...NONE, reportDocuments: 3, openingStatements: 2, firstStatements: 2 })).toEqual([
      "3 imported documents carried no balance to check — a spending report, an export without a closing figure — and " +
        "are neither a period above nor in the counts.",
      "2 statements were each an account's first and printed no opening balance, so nothing in them could have " +
        "failed — they are neither a period above nor in the counts.",
    ]);
  });

  test("🔴 an opening statement is never called a spending report or an export", () => {
    const [only, ...rest] = balanceLessNotes({ ...NONE, openingStatements: 1, firstStatements: 1 });
    expect(rest).toEqual([]);
    expect(only).toBe(
      "1 statement was an account's first and printed no opening balance, so nothing in it could have failed — it " +
        "is neither a period above nor in the counts.",
    );
    expect(only).not.toMatch(/spending report|export|document/);
  });

  /**
   * 🔴 The note said "the statement schedule counts them", and nothing checked it: measured on a copy of his ledger,
   * 2026-10-13, Robinhood Cash's schedule row reads its last 12 closes (Sep 2025 → Aug 2026), and its opening
   * statement — Dec 2023 — is not among them. Nor did anything check "an account's first": the parser knows only that
   * the statement printed `N/A` for its opening. It says "first" now only of statements no earlier period of their
   * account precedes (`firstOnAccount`), and names the schedule not at all.
   */
  test("🔴 \"an account's first\" only of statements that are, and the schedule never", () => {
    for (const counts of [
      { ...NONE, openingStatements: 2, firstStatements: 2 },
      { ...NONE, openingStatements: 1, firstStatements: 1 },
    ]) {
      expect(balanceLessNotes(counts).join(" ")).not.toMatch(/schedule/);
    }
    expect(balanceLessNotes({ ...NONE, openingStatements: 2, firstStatements: 1 })).toEqual([
      "2 statements printed no opening balance, so the days they declare reconcile nothing — they are neither a " +
        "period above nor in the counts.",
    ]);
    const [one] = balanceLessNotes({ ...NONE, openingStatements: 1, firstStatements: 0 });
    expect(one).toBe(
      "1 statement printed no opening balance, so the days it declares reconcile nothing — it is neither a period " +
        "above nor in the counts.",
    );
    expect(one).not.toMatch(/first|schedule/);
  });

  /**
   * 🔴 Review of 74f25fb (2026-10-14): a later statement that printed no opening kept "so nothing in it could have
   * failed" — false once a balance comes before it, as provenance.ts says of a download (`NO_OPENING_TO_RECONCILE`):
   * the chain replays onto its close from the balance before, and can miss it. Only an account's first has no balance
   * before it; the rest say what is true of every one counted — the days they declare reconcile nothing.
   */
  test("🔴 \"nothing could have failed\" only of statements that are each their account's first", () => {
    expect(balanceLessNotes({ ...NONE, openingStatements: 2, firstStatements: 2 })[0]).toMatch(/could have failed/);
    for (const counts of [
      { ...NONE, openingStatements: 2, firstStatements: 1 },
      { ...NONE, openingStatements: 1, firstStatements: 0 },
    ]) {
      expect(balanceLessNotes(counts)[0]).not.toMatch(/could have failed/);
    }
  });

  /**
   * 🔴 The review of 601f155, on a copy of data/e2e.db (2026-10-12): "27 imported documents carried no balance to check
   * — a spending report, an export without a closing figure" of 27 OFX downloads, 18 of which own the balance they
   * recorded (LEDGERBAL) on the account they declare. A document that recorded a balance is named as one that did, and
   * why it still proves nothing here: no opening one, so its days reconcile nothing.
   */
  test("🔴 a document that recorded a balance is never called an export without a closing figure", () => {
    expect(balanceLessNotes({ ...NONE, recordedBalanceDocuments: 18 })).toEqual([
      "18 imported documents recorded a balance but no opening one, so the days they declare reconcile nothing — they " +
        "are neither a period above nor in the counts.",
    ]);
    const [only] = balanceLessNotes({ ...NONE, recordedBalanceDocuments: 1 });
    expect(only).toBe(
      "1 imported document recorded a balance but no opening one, so the days it declares reconcile nothing — it is " +
        "neither a period above nor in the counts.",
    );
    expect(only).not.toMatch(/carried no balance|without a closing figure|spending report/);
  });

  /**
   * 🔴 …and the other nine still read "carried no balance to check — a spending report, an export without a closing
   * figure". Each printed a LEDGERBAL on its last day (Chase Savings' quarterly QFX, Sep 30, 2024 on), and its
   * quarter's CSV re-recorded that day — the ledger keeps one `ofx_ledger` balance per account and day, the last
   * writer's, so the download owns none (⚖️ anchor ownership as shipped, handoff 2026-10-13 §6A). Measured on a copy of
   * data/e2e.db 2026-10-13. A download is named as one, by what the ledger keeps of it — never as a report, and never
   * as a file that carried no balance, which it may well have printed.
   */
  test("🔴 a download the ledger keeps no balance of is never called a report, nor one that carried none", () => {
    expect(
      balanceLessNotes({ ...NONE, downloadDocuments: 9, recordedBalanceDocuments: 18, recordedBalanceDownloads: 18 }),
    ).toEqual([
      "9 imported downloads left the ledger no balance of their own on an account they declare and printed no " +
        "opening one, so their days reconcile nothing — they are neither a period above nor in the counts.",
      "18 imported downloads recorded a balance but no opening one, so the days they declare reconcile nothing — " +
        "they are neither a period above nor in the counts.",
    ]);
    const [only] = balanceLessNotes({ ...NONE, downloadDocuments: 1 });
    expect(only).toBe(
      "1 imported download left the ledger no balance of its own on an account it declares and printed no opening " +
        "one, so its days reconcile nothing — it is neither a period above nor in the counts.",
    );
    expect(only).not.toMatch(/carried no balance|without a closing figure|spending report|export/);
  });

  /**
   * 🔴 Review of 74f25fb (2026-10-14): "left the ledger no balance of its own" was false of a download printing two
   * accounts that recorded a balance on one — named in this sentence for the other (`statementEvidence`) — so it says
   * which: on an account it declares. And the sentence beside it called the same kind of file a "document": a file
   * that recorded a balance is a download where an OFX parser read every one counted, and a document otherwise.
   */
  test("🔴 one download, two accounts, a balance on one: both sentences true of it, and both call it a download", () => {
    expect(
      balanceLessNotes({ ...NONE, downloadDocuments: 1, recordedBalanceDocuments: 1, recordedBalanceDownloads: 1 }),
    ).toEqual([
      "1 imported download left the ledger no balance of its own on an account it declares and printed no opening " +
        "one, so its days reconcile nothing — it is neither a period above nor in the counts.",
      "1 imported download recorded a balance but no opening one, so the days it declares reconcile nothing — it is " +
        "neither a period above nor in the counts.",
    ]);
    // a bank export with a running balance among them: what every one counted shares
    expect(balanceLessNotes({ ...NONE, recordedBalanceDocuments: 2, recordedBalanceDownloads: 1 })[0]).toMatch(
      /^2 imported documents recorded a balance/,
    );
  });

  test("one document, singular", () => {
    expect(balanceLessNotes({ ...NONE, reportDocuments: 1 })).toEqual([
      "1 imported document carried no balance to check — a spending report, an export without a closing figure — and " +
        "is neither a period above nor in the counts.",
    ]);
  });

  test("nothing left out, nothing said", () => {
    expect(balanceLessNotes(NONE)).toEqual([]);
  });
});
