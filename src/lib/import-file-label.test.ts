import { describe, expect, test } from "vitest";
import {
  acknowledgedSentence,
  importRowQualifiers,
  importRowSubject,
  leftOutNoticesByRead,
  lineLeftOutNotice,
  recordWithheldSections,
  withheldNoticeOf,
  withheldSectionNotice,
  withheldSectionsOf,
  type LineLeftOutFacts,
  type WithheldSectionFacts,
} from "./import-file-label";

const AGENTIC_AUGUST: WithheldSectionFacts = {
  accountId: "0a1b2c3d-agentic",
  accountName: "Robinhood Agentic",
  last4: "9651",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  reason: "it shows $26.22 of securities, and this account is read as cash only",
};

const AGENTIC_AUGUST_NOTICE =
  "Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — it shows $26.22 of securities, " +
  "and this account is read as cash only. Nothing from that section is in the ledger: the activity it lists is missing, " +
  "and the account is not checked for those days unless a later statement's opening balance closes to the cent across them. " +
  // the path — a re-import of the same bytes is skipped, so the notice must not leave that as the obvious next step
  "Importing the same file again changes nothing: the next statement parser version reads the section again, " +
  "and positions it proves go into the account's brokerage book, which the import creates.";

describe("withheldSectionNotice", () => {
  /**
   * 🔴 Measured by a second reader on a copy of the real ledger: a withheld August whose balance did not move, then a
   * September opening at that balance — Robinhood Agentic read verified through 2026-09-30 and ledger-check exited 0,
   * beside a notice that still said "the account is not checked for those days".
   */
  test("names the account, the statement's window and why — and a consequence still true once a later statement closes across it", () => {
    expect(withheldSectionNotice(AGENTIC_AUGUST)).toBe(AGENTIC_AUGUST_NOTICE);
    expect(withheldSectionNotice(AGENTIC_AUGUST)).not.toMatch(/not checked for those days\.$/);
  });

  test("an account the ledger cannot name is still named by its number", () => {
    expect(withheldSectionNotice({ ...AGENTIC_AUGUST, accountId: null, accountName: null })).toMatch(
      /^Not imported: the account ····9651's statement for Aug 1 – 31, 2026 — /,
    );
  });
});

describe("recordWithheldSections → withheldSectionsOf: a parsed file keeps FACTS, not a sentence", () => {
  test("every fact round-trips, and a sentence riding along is not stored", () => {
    const error = recordWithheldSections([{ ...AGENTIC_AUGUST, notice: AGENTIC_AUGUST_NOTICE } as WithheldSectionFacts]);
    expect(error).not.toContain("Not imported");
    expect(withheldSectionsOf({ status: "parsed", error })).toEqual([AGENTIC_AUGUST]);
  });

  test("two sections, in the order they were withheld", () => {
    const july = { ...AGENTIC_AUGUST, periodStart: "2026-07-01", periodEnd: "2026-07-31" };
    expect(withheldSectionsOf({ status: "parsed", error: recordWithheldSections([AGENTIC_AUGUST, july]) })).toEqual([AGENTIC_AUGUST, july]);
  });

  test("only a parsed file's: a failure is why it failed, and a superseded file's contribution has left the ledger", () => {
    const error = recordWithheldSections([AGENTIC_AUGUST]);
    expect(withheldSectionsOf({ status: "failed", error })).toEqual([]);
    expect(withheldSectionsOf({ status: "superseded", error })).toEqual([]);
    expect(withheldSectionsOf({ status: "parsed", error: null })).toEqual([]);
  });

  /**
   * 🔴 `status !== "parsed"` answered "is this read in the ledger?" for half the files whose read is: a file read with
   * Claude's help is live by the rule (`isLiveFile`), and what it left out read as nothing (the review, 2026-10-01).
   */
  test("a file read with Claude's help is in the ledger as a parsed one is: its withheld sections are read the same", () => {
    expect(withheldSectionsOf({ status: "parsed_with_claude", error: recordWithheldSections([AGENTIC_AUGUST]) })).toEqual([AGENTIC_AUGUST]);
  });

  test.each([
    ["plain text", "Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — …"],
    ["a record cut short", recordWithheldSections([AGENTIC_AUGUST]).slice(0, -5)],
    ["a window that is not a day", recordWithheldSections([{ ...AGENTIC_AUGUST, periodEnd: "Aug 31" }])],
    ["a section with no reason", JSON.stringify({ withheld: [{ ...AGENTIC_AUGUST, reason: undefined }] })],
    ["one good section beside a bad one", JSON.stringify({ withheld: [AGENTIC_AUGUST, { ...AGENTIC_AUGUST, last4: 9651 }] })],
    ["no list", JSON.stringify({ withheld: AGENTIC_AUGUST })],
  ])("⛔ %s reads as NO sections, never as some of them", (_, error) => {
    expect(withheldSectionsOf({ status: "parsed", error })).toEqual([]);
  });
});

describe("withheldNoticeOf", () => {
  test("a parsed file's record reads as one sentence per section, built when it is read", () => {
    const july = { ...AGENTIC_AUGUST, periodStart: "2026-07-01", periodEnd: "2026-07-31" };
    expect(withheldNoticeOf({ status: "parsed", error: recordWithheldSections([AGENTIC_AUGUST]) })).toBe(AGENTIC_AUGUST_NOTICE);
    expect(withheldNoticeOf({ status: "parsed", error: recordWithheldSections([AGENTIC_AUGUST, july]) })).toBe(
      `${AGENTIC_AUGUST_NOTICE} ${withheldSectionNotice(july)}`,
    );
  });

  test("a clean parse withheld nothing, and a failure is not a withheld section", () => {
    expect(withheldNoticeOf({ status: "parsed", error: null })).toBeNull();
    expect(withheldNoticeOf({ status: "failed", error: "[robinhood-brokerage-statement-pdf] No account number found" })).toBeNull();
    expect(withheldNoticeOf({ status: "superseded", error: recordWithheldSections([AGENTIC_AUGUST]) })).toBeNull();
  });

  test("⚠️ a parsed file whose error is not a record is shown as it is — never hidden behind plain \"Parsed\"", () => {
    expect(withheldNoticeOf({ status: "parsed", error: "something the import said" })).toBe("something the import said");
  });

  test("a file read with Claude's help says what it left out, as a parsed one does", () => {
    expect(withheldNoticeOf({ status: "parsed_with_claude", error: recordWithheldSections([AGENTIC_AUGUST]) })).toBe(AGENTIC_AUGUST_NOTICE);
    expect(withheldNoticeOf({ status: "parsed_with_claude", error: "something the import said" })).toBe("something the import said");
  });
});

const file = (id: string, fileName: string, importedAt: string) => ({ id, fileName, importedAt });

describe("importRowQualifiers", () => {
  /** ⛔ 218 of the owner's 330 rows are unique and must gain nothing. */
  test("says nothing about a name that appears once", () => {
    const q = importRowQualifiers([
      file("a", "chase-2026-07.pdf", "2026-07-13T21:33:16.940Z"),
      file("b", "discover-2026-07.pdf", "2026-08-05T20:28:48.430Z"),
    ]);
    expect(q.get("a")).toBeNull();
    expect(q.get("b")).toBeNull();
  });

  /**
   * 🔴 The defect, measured 2026-09-09: `20230810-statements-3522-.pdf` is
   * three rows, two of them identical in every visible column, and their
   * un-import confirmations differ by a statement balance.
   */
  test("dates every row of a repeated name, including the first", () => {
    const q = importRowQualifiers([
      file("a", "20230810-statements-3522-.pdf", "2026-07-13T21:33:16.940Z"),
      file("b", "20230810-statements-3522-.pdf", "2026-07-15T10:02:00.000Z"),
      file("c", "20230810-statements-3522-.pdf", "2026-08-05T20:28:48.430Z"),
    ]);
    expect(q.get("a")).toBe("imported 2026-07-13");
    expect(q.get("b")).toBe("imported 2026-07-15");
    expect(q.get("c")).toBe("imported 2026-08-05");
  });

  /**
   * ⚠️ The fallback is the point: a rule that disambiguates by a day it has
   * not checked for collisions has the defect it exists to fix.
   */
  test("falls back to the minute when one day holds two of the same name", () => {
    const q = importRowQualifiers([
      file("a", "same.pdf", "2026-08-05T09:14:00.000Z"),
      file("b", "same.pdf", "2026-08-05T20:28:48.430Z"),
      file("c", "same.pdf", "2026-09-01T11:00:00.000Z"),
    ]);
    expect(q.get("a")).toBe("imported 2026-08-05 09:14");
    expect(q.get("b")).toBe("imported 2026-08-05 20:28");
    // the row on its own day keeps the shorter form — only the clash pays
    expect(q.get("c")).toBe("imported 2026-09-01");
  });

  /** every row gets an answer, so a caller never reads `undefined` as "unique" */
  test("answers for every row it was given", () => {
    const files = [
      file("a", "one.pdf", "2026-07-13T21:33:16.940Z"),
      file("b", "two.pdf", "2026-07-13T21:33:16.940Z"),
      file("c", "two.pdf", "2026-07-14T21:33:16.940Z"),
    ];
    const q = importRowQualifiers(files);
    expect([...q.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  test("an unparseable stamp is echoed rather than sliced into nonsense", () => {
    const q = importRowQualifiers([file("a", "x.pdf", "unknown"), file("b", "x.pdf", "also-unknown")]);
    expect(q.get("a")).toBe("imported unknown");
    expect(q.get("b")).toBe("imported also-unknown");
  });

  /**
   * ⛔ …and through the minute fallback too. Two unreadable stamps collide on
   * the "day" they cannot be parsed into, which is the one path that reaches
   * `minuteOf` with nothing to slice — it must still echo rather than emit
   * "unkn NaN".
   */
  test("two unparseable stamps collide, and are still echoed whole", () => {
    const q = importRowQualifiers([file("a", "x.pdf", "unknown"), file("b", "x.pdf", "unknown")]);
    expect(q.get("a")).toBe("imported unknown");
    expect(q.get("b")).toBe("imported unknown");
  });

  test("no files, no answers", () => {
    expect(importRowQualifiers([]).size).toBe(0);
  });
});

describe("importRowSubject", () => {
  test("a unique name stands alone", () => {
    expect(importRowSubject("chase-2026-07.pdf", null)).toBe("chase-2026-07.pdf");
  });

  test("a repeated one carries the qualifier the row shows", () => {
    expect(importRowSubject("20230810-statements-3522-.pdf", "imported 2026-08-05")).toBe(
      "20230810-statements-3522-.pdf (imported 2026-08-05)",
    );
  });
});

/** The owner's rehearsal of 2026-09-28: a re-read of the export that drops the account's opening deposit. */
const OPENING_LEFT_OUT: LineLeftOutFacts = {
  accountName: "Wells Fargo Everyday Checking",
  printedOn: "2026-07-27",
  amountCents: 2500,
  description: "WFB Opening Deposit From Card",
  printedBy: ["wf-export (1).csv"],
  readBy: "wf-export.csv",
  acknowledged: null,
};

/** what a session wrote, having read the line on its statement (`--reason`) */
const READ_IT = {
  on: "2026-10-05",
  reason: "July statement, page 1: the bank's opening deposit, reversed the same day by the card it came from",
};

describe("lineLeftOutNotice — one sentence for the upload outcome, /imports and ledger-check", () => {
  test("names the money, the day, the words, the account, the file that still prints it and the read that does not", () => {
    expect(lineLeftOutNotice(OPENING_LEFT_OUT)).toBe(
      "Left out of the ledger: +$25.00 on 2026-07-27, WFB Opening Deposit From Card, on Wells Fargo Everyday Checking. " +
        "wf-export (1).csv still prints it; the newest read of wf-export.csv does not, and the row an earlier read " +
        "wrote for it is retired — not written back on a guess.",
    );
  });

  test("a charge reads as money out, and two printers are both named", () => {
    const notice = lineLeftOutNotice({ ...OPENING_LEFT_OUT, amountCents: -1000, printedBy: ["a.csv", "b.csv"] });
    expect(notice).toContain("Left out of the ledger: -$10.00 on 2026-07-27");
    expect(notice).toContain("a.csv, b.csv still print it;");
  });

  test("a line whose read is no longer imported says so, rather than naming a read that is gone", () => {
    expect(lineLeftOutNotice({ ...OPENING_LEFT_OUT, readBy: null })).toContain(
      "wf-export (1).csv still prints it; no read of the file it came from is imported now, and",
    );
  });

  /*
   * ⚖️ Owner, 2026-10-02 (§6A 30): an acknowledged line is still named — and says on what day it was acknowledged.
   * ⛔ And WHY: "an entry without a reason is a check that has been quieted" (ledger-check's BASELINE) — so it says what
   * the session read on the statement, in its own words.
   */
  test("an acknowledged line still says it is left out, on what day it was acknowledged, and what was read", () => {
    expect(lineLeftOutNotice({ ...OPENING_LEFT_OUT, acknowledged: READ_IT })).toBe(
      `${lineLeftOutNotice(OPENING_LEFT_OUT)} Acknowledged on 2026-10-05: July statement, page 1: the bank's opening ` +
        "deposit, reversed the same day by the card it came from",
    );
  });
});

describe("acknowledgedSentence — one phrasing wherever an acknowledgement is printed", () => {
  test("the day, then the reason, exactly as the session gave it", () => {
    expect(acknowledgedSentence(READ_IT)).toBe(`Acknowledged on 2026-10-05: ${READ_IT.reason}`);
  });

  /*
   * 🔴 A stop was added unless the reason ended in . ! or ? — so "(page 1.)" printed "(page 1.).", and a reason ending in
   * a colon printed ":.". The reason is the session's words: printed as given, nothing added, nothing taken.
   */
  test("the reason is printed as given — no stop added, none taken", () => {
    const reasons = [
      "July statement (page 1.)",
      "July statement, page 1:",
      "Printed on the July statement.",
      "Is it the reversal? Yes!",
      "printed once, no stop",
    ];
    for (const reason of reasons) {
      expect(acknowledgedSentence({ on: "2026-10-05", reason })).toBe(`Acknowledged on 2026-10-05: ${reason}`);
    }
  });
});

describe("leftOutNoticesByRead", () => {
  test("each notice sits under the read that left its line out, in order", () => {
    const second = { ...OPENING_LEFT_OUT, printedOn: "2026-07-28", amountCents: -700 };
    const byRead = leftOutNoticesByRead([
      { ...OPENING_LEFT_OUT, readById: "read-1" },
      { ...OPENING_LEFT_OUT, readById: "read-2" },
      { ...second, readById: "read-1" },
    ]);
    expect([...byRead.keys()]).toEqual(["read-1", "read-2"]);
    expect(byRead.get("read-1")).toEqual([lineLeftOutNotice(OPENING_LEFT_OUT), lineLeftOutNotice(second)]);
  });

  test("/imports says an acknowledged line acknowledged, and why, as the upload outcome and ledger-check do", () => {
    const acknowledged = { ...OPENING_LEFT_OUT, acknowledged: READ_IT, readById: "read-1" };
    expect(leftOutNoticesByRead([acknowledged]).get("read-1")).toEqual([lineLeftOutNotice(acknowledged)]);
    expect(leftOutNoticesByRead([acknowledged]).get("read-1")![0]).toContain(`Acknowledged on 2026-10-05: ${READ_IT.reason}`);
  });

  test("a line with no imported read has no row to sit under — ledger-check still names it", () => {
    expect(leftOutNoticesByRead([{ ...OPENING_LEFT_OUT, readBy: null, readById: null }])).toEqual(new Map());
  });
});
