import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods, type ImportStatus, type ReconciliationState } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { seedDatabase } from "@/db/seed";
import { addCalendarMonths, addDays } from "@/lib/dates";
import { recordWithheldSections } from "@/lib/import-file-label";
import { statementGaps } from "./statement-gaps";

/**
 * Which statements are missing — a different question from whether the money
 * closes, and the tests are mostly about what it REFUSES to call missing.
 */

let dir: string;
let bundle: DbBundle;

function addAccount(id: string, name: string): void {
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: "credit",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

let seq = 0;
function addPeriod(
  accountId: string,
  start: string,
  end: string,
  reconciliation: ReconciliationState = "reconciled",
): void {
  seq += 1;
  const fileId = `f-${seq}`;
  bundle.db
    .insert(importFiles)
    .values({
      id: fileId,
      fileName: `s-${seq}.pdf`,
      fileSha256: `sha-${seq}`,
      format: "pdf",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      status: "parsed",
      storagePath: `/tmp/s-${seq}.pdf`,
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  bundle.db
    .insert(statementPeriods)
    .values({
      id: `p-${seq}`,
      accountId,
      importFileId: fileId,
      periodStart: start,
      periodEnd: end,
      reconciliation,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** A file that imported WITHOUT this account's section — the record `settleMember` writes on its row. */
function addWithheldFile(accountId: string, start: string, end: string, status: ImportStatus = "parsed"): string {
  seq += 1;
  const fileName = `w-${seq}.pdf`;
  bundle.db
    .insert(importFiles)
    .values({
      id: `f-${seq}`,
      fileName,
      fileSha256: `sha-${seq}`,
      format: "pdf",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      status,
      error: recordWithheldSections([
        {
          accountId,
          accountName: "Robinhood Agentic",
          last4: "9651",
          periodStart: start,
          periodEnd: end,
          reason: "it shows $26.22 of securities, and this account is read as cash only",
        },
      ]),
      storagePath: `/tmp/${fileName}`,
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return fileName;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-gaps-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what is missing", () => {
  test("names the exact window and how many statements it is", () => {
    // Discover's real shape: monthly periods closing on the 18th, one absent
    addAccount("a-1", "Discover");
    addPeriod("a-1", "2024-06-19", "2024-07-18");
    addPeriod("a-1", "2024-07-19", "2024-08-18");
    addPeriod("a-1", "2024-09-19", "2024-10-18");
    addPeriod("a-1", "2024-10-19", "2024-11-18");

    expect(statementGaps(bundle.db)).toEqual([
      {
        accountId: "a-1",
        accountName: "Discover",
        holes: [{ from: "2024-08-19", to: "2024-09-18", days: 31, closes: 1 }],
        missingCloses: 1,
        missingDays: 31,
        withheld: [],
      },
    ]);
  });

  test("sums across several holes on one account", () => {
    // twelve monthly closes on the 18th with two months absent
    addAccount("a-1", "Discover");
    const months = ["2024-01", "2024-02", "2024-03", "2024-05", "2024-06", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12"];
    for (const m of months) {
      const prev = `${m}-19`;
      const [y, mm] = m.split("-").map(Number);
      const next = mm === 12 ? `${y! + 1}-01-18` : `${y}-${String(mm! + 1).padStart(2, "0")}-18`;
      addPeriod("a-1", prev, next);
    }
    const [g] = statementGaps(bundle.db);
    expect(g!.holes).toHaveLength(2);
    expect(g!.missingCloses).toBe(2);
    expect(g!.missingDays).toBe(g!.holes.reduce((n, h) => n + h.days, 0));
  });

  test("⛔ an account with no rhythm gets exact days and NO statement count", () => {
    /*
     * Three closes 90 and 123 days apart resolve to `every-n-days: 107`, which
     * puts no close inside a 60-day window. The day count is still exact — what
     * is withheld is the number of STATEMENTS, because inventing one from a
     * flat 30-day month would be a figure nobody measured.
     */
    addAccount("a-1", "Irregular");
    addPeriod("a-1", "2024-01-19", "2024-02-18");
    addPeriod("a-1", "2024-04-19", "2024-05-18");
    addPeriod("a-1", "2024-08-19", "2024-09-18");
    const [g] = statementGaps(bundle.db);
    expect(g!.missingCloses).toBeNull();
    expect(g!.missingDays).toBeGreaterThan(0);
    expect(g!.holes.every((h) => h.closes === null)).toBe(true);
  });
});

describe("what it refuses to call missing", () => {
  test("⛔ an account with no statements at all has no holes", () => {
    /*
     * Cash on Hand issues no statements and never will. Reporting "everything
     * since 2022 is missing" for it would be the fourth time this codebase
     * confused EMPTY with BROKEN.
     */
    addAccount("a-1", "Cash on Hand");
    expect(statementGaps(bundle.db)).toEqual([]);
  });

  test("a single statement is not a hole either", () => {
    // there is no window BETWEEN one period and itself
    addAccount("a-1", "Wells Fargo");
    addPeriod("a-1", "2026-07-26", "2026-08-25");
    expect(statementGaps(bundle.db)).toEqual([]);
  });

  test("an account whose statements all abut is absent from the list", () => {
    // absent, not present-with-zero: a row saying "0 missing" is noise on a
    // panel whose whole job is naming what to fetch
    addAccount("a-1", "Chase");
    addPeriod("a-1", "2024-06-19", "2024-07-18");
    addPeriod("a-1", "2024-07-19", "2024-08-18");
    expect(statementGaps(bundle.db)).toEqual([]);
  });

  test("an archived account is not asked about", () => {
    addAccount("a-1", "Old Card");
    addPeriod("a-1", "2024-01-19", "2024-02-18");
    addPeriod("a-1", "2024-04-19", "2024-05-18");
    bundle.db.update(accounts).set({ isActive: false }).run();
    expect(statementGaps(bundle.db)).toEqual([]);
  });

  test("two accounts are reported apart, never pooled", () => {
    addAccount("a-1", "Discover");
    addAccount("a-2", "Venture X");
    addPeriod("a-1", "2024-01-19", "2024-02-18");
    addPeriod("a-1", "2024-04-19", "2024-05-18");
    addPeriod("a-2", "2024-01-15", "2024-02-14");
    addPeriod("a-2", "2024-02-15", "2024-03-14");
    const out = statementGaps(bundle.db);
    expect(out.map((g) => g.accountName)).toEqual(["Discover"]);
  });
});

describe("a statement imported WITHOUT this account's section", () => {
  /**
   * 🔴 Measured by a second reader on copies of the real ledger: a withheld Robinhood Agentic August, then any later
   * statement, and the panel listed Aug 1 – 31, 2026 under "These are files to fetch" — though a re-download is the
   * same bytes, skipped as a duplicate, and fills nothing.
   */
  test("⛔ is not a hole to fetch: it is reported as withheld, naming the file that left it out", () => {
    addAccount("a-1", "Robinhood Agentic");
    addPeriod("a-1", "2026-06-01", "2026-06-30");
    addPeriod("a-1", "2026-07-01", "2026-07-31");
    addPeriod("a-1", "2026-09-01", "2026-09-30");
    // the control: without the file, August is a hole like any other
    expect(statementGaps(bundle.db).map((g) => g.holes.map((h) => [h.from, h.to]))).toEqual([[["2026-08-01", "2026-08-31"]]]);

    const fileName = addWithheldFile("a-1", "2026-08-01", "2026-08-31");

    expect(statementGaps(bundle.db)).toEqual([
      {
        accountId: "a-1",
        accountName: "Robinhood Agentic",
        holes: [],
        missingCloses: null,
        missingDays: 0,
        withheld: [{ from: "2026-08-01", to: "2026-08-31", days: 31, fileName }],
      },
    ]);
  });

  test("only the withheld month leaves a longer hole — the months around it are still files to fetch", () => {
    addAccount("a-1", "Robinhood Agentic");
    addPeriod("a-1", "2026-05-01", "2026-05-31");
    addPeriod("a-1", "2026-06-01", "2026-06-30");
    addPeriod("a-1", "2026-10-01", "2026-10-31");
    const fileName = addWithheldFile("a-1", "2026-08-01", "2026-08-31");

    const [g] = statementGaps(bundle.db);

    expect(g!.holes.map((h) => [h.from, h.to, h.days])).toEqual([
      ["2026-07-01", "2026-07-31", 31],
      ["2026-09-01", "2026-09-30", 30],
    ]);
    expect(g!.missingDays).toBe(61);
    expect(g!.withheld).toEqual([{ from: "2026-08-01", to: "2026-08-31", days: 31, fileName }]);
  });

  test("reported before any later statement arrives, too — that month is not in the ledger either way", () => {
    addAccount("a-1", "Robinhood Agentic");
    addPeriod("a-1", "2026-06-01", "2026-06-30");
    addPeriod("a-1", "2026-07-01", "2026-07-31");
    const fileName = addWithheldFile("a-1", "2026-08-01", "2026-08-31");

    expect(statementGaps(bundle.db)).toEqual([
      {
        accountId: "a-1",
        accountName: "Robinhood Agentic",
        holes: [],
        missingCloses: null,
        missingDays: 0,
        withheld: [{ from: "2026-08-01", to: "2026-08-31", days: 31, fileName }],
      },
    ]);
  });

  /**
   * 🔴 The files asked for were `parsed` ones only, so a file read with Claude's help — in the ledger by the same rule
   * (`isLiveFile`) — left its withheld month listed as a statement to fetch (the review, 2026-10-01).
   */
  test("a file read with Claude's help is imported as a parsed one is: its withheld month is reported, not a hole", () => {
    addAccount("a-1", "Robinhood Agentic");
    addPeriod("a-1", "2026-06-01", "2026-06-30");
    addPeriod("a-1", "2026-07-01", "2026-07-31");
    addPeriod("a-1", "2026-09-01", "2026-09-30");
    const fileName = addWithheldFile("a-1", "2026-08-01", "2026-08-31", "parsed_with_claude");

    expect(statementGaps(bundle.db)).toEqual([
      {
        accountId: "a-1",
        accountName: "Robinhood Agentic",
        holes: [],
        missingCloses: null,
        missingDays: 0,
        withheld: [{ from: "2026-08-01", to: "2026-08-31", days: 31, fileName }],
      },
    ]);
  });

  test("⛔ another account's withheld section, and a superseded or failed file's, cover nothing", () => {
    addAccount("a-1", "Robinhood Agentic");
    addPeriod("a-1", "2026-06-01", "2026-06-30");
    addPeriod("a-1", "2026-07-01", "2026-07-31");
    addPeriod("a-1", "2026-09-01", "2026-09-30");
    addWithheldFile("a-2", "2026-08-01", "2026-08-31");
    addWithheldFile("a-1", "2026-08-01", "2026-08-31", "superseded");
    addWithheldFile("a-1", "2026-08-01", "2026-08-31", "failed");

    const [g] = statementGaps(bundle.db);

    expect(g!.holes.map((h) => [h.from, h.to])).toEqual([["2026-08-01", "2026-08-31"]]);
    expect(g!.withheld).toEqual([]);
  });

  test("a month another file's statement DID prove is no longer listed as withheld", () => {
    addAccount("a-1", "Robinhood Agentic");
    addPeriod("a-1", "2026-07-01", "2026-07-31");
    addWithheldFile("a-1", "2026-08-01", "2026-08-31");
    addPeriod("a-1", "2026-08-01", "2026-08-31");

    expect(statementGaps(bundle.db)).toEqual([]);
  });
});

describe("a document with no printed balances is not a statement", () => {
  /**
   * 🔴 Missing statements read every `statement_periods` row as a statement, while the statement schedule left
   * the `not_applicable` ones out ("the exclusion is load-bearing"). A Chase Spending Report is one: his Chase
   * Sapphire holds two, 2025-01-01 → 2025-12-31 and 2026-01-01 → 2026-07-10. The hole walk's frontier jumped to a
   * report's end, so a statement missing under one vanished from the panel — measured by the review on a copy of
   * his ledger, 2026-10-08: drop any of Sapphire's statements from Mar 2025 to Jun 2026 and it listed nothing.
   */

  /** Chase Sapphire's real statements: one a month, closing on the 2nd, from the `first` close to the `last`. */
  function addSapphireStatements(first: string, last: string, skip: readonly string[] = []): void {
    for (let close = first; close <= last; close = addCalendarMonths(close, 1)) {
      if (!skip.includes(close)) addPeriod("a-1", addDays(addCalendarMonths(close, -1), 1), close);
    }
  }

  test("⛔ a Spending Report over a missing statement does not fill it", () => {
    addAccount("a-1", "Chase Sapphire");
    addSapphireStatements("2025-03-02", "2026-09-02", ["2025-07-02"]);
    const june2025 = { from: "2025-06-03", to: "2025-07-02", days: 30, closes: 1 };
    // the control: without the reports, the statement closing Jul 2, 2025 is a hole like any other
    expect(statementGaps(bundle.db).map((g) => g.holes)).toEqual([[june2025]]);

    addPeriod("a-1", "2025-01-01", "2025-12-31", "not_applicable");
    addPeriod("a-1", "2026-01-01", "2026-07-10", "not_applicable");

    expect(statementGaps(bundle.db).map((g) => g.holes)).toEqual([[june2025]]);
  });

  test("the review's case: three statements skipped, then a year-to-date report over them", () => {
    addAccount("a-1", "Chase Sapphire");
    addSapphireStatements("2025-03-02", "2027-01-02", ["2026-10-02", "2026-11-02", "2026-12-02"]);
    addPeriod("a-1", "2025-01-01", "2025-12-31", "not_applicable");
    addPeriod("a-1", "2026-01-01", "2026-07-10", "not_applicable");
    const missing = { from: "2026-09-03", to: "2026-12-02", days: 91, closes: 3 };
    expect(statementGaps(bundle.db).map((g) => g.holes)).toEqual([[missing]]);

    addPeriod("a-1", "2026-01-01", "2026-12-10", "not_applicable");

    expect(statementGaps(bundle.db)).toEqual([
      {
        accountId: "a-1",
        accountName: "Chase Sapphire",
        holes: [missing],
        missingCloses: 3,
        missingDays: 91,
        withheld: [],
      },
    ]);
  });

  test("a report's last day is not a close: the hole after it opens the day after a statement", () => {
    // the statement closing Aug 2, 2026 is missing, and the Jul 10 report sits over its first week
    addAccount("a-1", "Chase Sapphire");
    addSapphireStatements("2026-02-02", "2026-09-02", ["2026-08-02"]);
    addPeriod("a-1", "2026-01-01", "2026-07-10", "not_applicable");

    // NOT Jul 11 → Aug 2, 23 days: the statement missing covers Jul 3 → Aug 2, and the report replaces none of it
    expect(statementGaps(bundle.db).map((g) => g.holes)).toEqual([
      [{ from: "2026-07-03", to: "2026-08-02", days: 31, closes: 1 }],
    ]);
  });
});
