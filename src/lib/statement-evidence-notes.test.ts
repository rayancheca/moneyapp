import { describe, expect, test } from "vitest";
import { balanceLessNotes } from "./statement-evidence-notes";

/**
 * The footer under /imports' "What the statements proved": what each period it leaves out IS. The counts come from
 * `statementEvidence` (services/statement-evidence.test.ts), split by the statement schedule's own rule.
 */
describe("balanceLessNotes", () => {
  test("his ledger, 2026-10-12: three documents that are no statement, two opening statements the schedule counts", () => {
    expect(balanceLessNotes({ reportDocuments: 3, openingStatements: 2 })).toEqual([
      "3 imported documents carried no balance to check — a spending report, an export without a closing figure — and " +
        "are neither a period above nor in the counts.",
      "2 statements were each an account's first and printed no opening balance — the statement schedule counts them, " +
        "but nothing in them could have failed, so they are neither a period above nor in the counts.",
    ]);
  });

  test("🔴 an opening statement is never called a spending report or an export", () => {
    const [only, ...rest] = balanceLessNotes({ reportDocuments: 0, openingStatements: 1 });
    expect(rest).toEqual([]);
    expect(only).toBe(
      "1 statement was an account's first and printed no opening balance — the statement schedule counts it, but " +
        "nothing in it could have failed, so it is neither a period above nor in the counts.",
    );
    expect(only).not.toMatch(/spending report|export|document/);
  });

  test("one document, singular", () => {
    expect(balanceLessNotes({ reportDocuments: 1, openingStatements: 0 })).toEqual([
      "1 imported document carried no balance to check — a spending report, an export without a closing figure — and " +
        "is neither a period above nor in the counts.",
    ]);
  });

  test("nothing left out, nothing said", () => {
    expect(balanceLessNotes({ reportDocuments: 0, openingStatements: 0 })).toEqual([]);
  });
});
