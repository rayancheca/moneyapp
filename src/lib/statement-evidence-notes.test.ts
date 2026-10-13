import { describe, expect, test } from "vitest";
import { balanceLessNotes } from "./statement-evidence-notes";

/**
 * The footer under /imports' "What the statements proved": what each period it leaves out IS. The counts come from
 * `statementEvidence` (services/statement-evidence.test.ts), split by `balanceLessKind` — the statement schedule's own
 * rule for an opening statement, and the ledger's balances for a file that recorded one.
 */
describe("balanceLessNotes", () => {
  test("his ledger, 2026-10-12: three documents that are no statement, two opening statements the schedule counts", () => {
    expect(balanceLessNotes({ reportDocuments: 3, recordedBalanceDocuments: 0, openingStatements: 2 })).toEqual([
      "3 imported documents carried no balance to check — a spending report, an export without a closing figure — and " +
        "are neither a period above nor in the counts.",
      "2 statements were each an account's first and printed no opening balance — the statement schedule counts them, " +
        "but nothing in them could have failed, so they are neither a period above nor in the counts.",
    ]);
  });

  test("🔴 an opening statement is never called a spending report or an export", () => {
    const [only, ...rest] = balanceLessNotes({ reportDocuments: 0, recordedBalanceDocuments: 0, openingStatements: 1 });
    expect(rest).toEqual([]);
    expect(only).toBe(
      "1 statement was an account's first and printed no opening balance — the statement schedule counts it, but " +
        "nothing in it could have failed, so it is neither a period above nor in the counts.",
    );
    expect(only).not.toMatch(/spending report|export|document/);
  });

  /**
   * 🔴 The review of 601f155, on a copy of data/e2e.db (2026-10-12): "27 imported documents carried no balance to check
   * — a spending report, an export without a closing figure" of 27 OFX downloads, 18 of which own the balance they
   * recorded (LEDGERBAL) on the account they declare. A document that recorded a balance is named as one that did, and
   * why it still proves nothing here: no opening one, so its days reconcile nothing.
   */
  test("🔴 a document that recorded a balance is never called an export without a closing figure", () => {
    expect(balanceLessNotes({ reportDocuments: 9, recordedBalanceDocuments: 18, openingStatements: 0 })).toEqual([
      "9 imported documents carried no balance to check — a spending report, an export without a closing figure — and " +
        "are neither a period above nor in the counts.",
      "18 imported documents recorded a balance but no opening one, so the days they declare reconcile nothing — they " +
        "are neither a period above nor in the counts.",
    ]);
    const [only] = balanceLessNotes({ reportDocuments: 0, recordedBalanceDocuments: 1, openingStatements: 0 });
    expect(only).toBe(
      "1 imported document recorded a balance but no opening one, so the days it declares reconcile nothing — it is " +
        "neither a period above nor in the counts.",
    );
    expect(only).not.toMatch(/carried no balance|without a closing figure|spending report/);
  });

  test("one document, singular", () => {
    expect(balanceLessNotes({ reportDocuments: 1, recordedBalanceDocuments: 0, openingStatements: 0 })).toEqual([
      "1 imported document carried no balance to check — a spending report, an export without a closing figure — and " +
        "is neither a period above nor in the counts.",
    ]);
  });

  test("nothing left out, nothing said", () => {
    expect(balanceLessNotes({ reportDocuments: 0, recordedBalanceDocuments: 0, openingStatements: 0 })).toEqual([]);
  });
});
