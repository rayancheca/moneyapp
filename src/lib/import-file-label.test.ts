import { describe, expect, test } from "vitest";
import { importRowQualifiers, importRowSubject, withheldNoticeOf, withheldSectionNotice } from "./import-file-label";

describe("withheldSectionNotice", () => {
  const AGENTIC_AUGUST = {
    accountName: "Robinhood Agentic",
    last4: "9651",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    reason: "it shows $26.22 of securities, and this account is read as cash only",
  };

  test("names the account, the statement's window and why — and says the account is not checked for those days", () => {
    expect(withheldSectionNotice(AGENTIC_AUGUST)).toBe(
      "Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — it shows $26.22 of securities, " +
        "and this account is read as cash only. Nothing from that section is in the ledger, so the account is not checked for those days.",
    );
  });

  test("an account the ledger cannot name is still named by its number", () => {
    expect(withheldSectionNotice({ ...AGENTIC_AUGUST, accountName: null })).toMatch(/^Not imported: the account ····9651's statement for Aug 1 – 31, 2026 — /);
  });
});

describe("withheldNoticeOf", () => {
  const notice = "Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — …";

  test("a parsed file's error is what it withheld", () => {
    expect(withheldNoticeOf({ status: "parsed", error: notice })).toBe(notice);
  });

  test("a clean parse withheld nothing, and a failure is not a withheld section", () => {
    expect(withheldNoticeOf({ status: "parsed", error: null })).toBeNull();
    expect(withheldNoticeOf({ status: "failed", error: "[robinhood-brokerage-statement-pdf] No account number found" })).toBeNull();
    expect(withheldNoticeOf({ status: "superseded", error: notice })).toBeNull();
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
