import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "./accounts";
import { statementPulls } from "./statement-pulls";

const TODAY = "2026-08-14";

let dir: string;
let bundle: DbBundle;
let fileId: string;

function addPeriod(
  accountId: string,
  periodEnd: string,
  reconciliation: "reconciled" | "not_applicable" | "value_anchor" | "gap" = "reconciled",
): void {
  bundle.db
    .insert(statementPeriods)
    .values({
      importFileId: fileId,
      accountId,
      periodStart: periodEnd,
      periodEnd,
      reconciliation,
    })
    .run();
}

/** statement_periods is unique on (import_file_id, account_id) — one file each. */
function newFile(name: string): string {
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return bundle.db
    .insert(importFiles)
    .values({
      fileName: name,
      fileSha256: name,
      format: "pdf",
      institutionId: chase.id,
      status: "parsed",
      storagePath: `/tmp/${name}`,
      importedAt: "2026-08-14",
    })
    .returning({ id: importFiles.id })
    .get().id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pulls-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  fileId = newFile("seed.pdf");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeAccount(name: string): string {
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return createAccount(bundle.db, { institutionId: chase.id, name, type: "checking" });
}

describe("statementPulls", () => {
  test("a month-end account with a close behind it is ready to pull", () => {
    const id = makeAccount("Robinhood Crypto");
    for (const end of ["2026-04-30", "2026-05-31", "2026-06-30"]) {
      fileId = newFile(`${end}.pdf`);
      addPeriod(id, end);
    }
    const [pull] = statementPulls(bundle.db, TODAY);
    expect(pull!.accountName).toBe("Robinhood Crypto");
    expect(pull!.status).toBe("due");
    expect(pull!.expectedOn).toBe("2026-07-31");
    expect(pull!.closesDue).toBe(1);
  });

  /**
   * The exclusion this service exists to get right. A Chase *Spending Report*
   * parses into a `not_applicable` period — no printed balances — and the real
   * ledger holds one covering 2026-01-01 → 2026-07-10 on Chase Sapphire.
   *
   * Counting it as a close does two wrong things at once: it reports the cycle
   * as closing on the 10th when it closes on the 2nd, and it makes the already
   * imported August statement look outstanding.
   */
  test("a spending report is not a statement and never moves the cycle", () => {
    const id = makeAccount("Chase Sapphire");
    for (const end of ["2026-05-02", "2026-06-02", "2026-07-02", "2026-08-02"]) {
      fileId = newFile(`${end}.pdf`);
      addPeriod(id, end);
    }
    // dated AFTER the newest statement, which is what a report downloaded today
    // looks like — and the only arrangement in which the exclusion decides
    // anything, since an older one is invisible behind a later close
    fileId = newFile("Spending Report.pdf");
    addPeriod(id, "2026-08-10", "not_applicable");

    const [pull] = statementPulls(bundle.db, TODAY);
    expect(pull!.cadence.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(pull!.lastCloseOn).toBe("2026-08-02"); // NOT 2026-08-10
    expect(pull!.daysSinceLastClose).toBe(12);
    expect(pull!.status).toBe("waiting");
    expect(pull!.expectedOn).toBe("2026-09-02");
  });

  test("a gap or value-anchor period still counts — it arrived on the cycle", () => {
    const id = makeAccount("Robinhood Cash");
    fileId = newFile("a.pdf");
    addPeriod(id, "2026-05-31", "value_anchor");
    fileId = newFile("b.pdf");
    addPeriod(id, "2026-06-30", "gap");
    fileId = newFile("c.pdf");
    addPeriod(id, "2026-07-31", "value_anchor");
    const [pull] = statementPulls(bundle.db, TODAY);
    expect(pull!.cadence.closes).toBe(3);
    expect(pull!.status).toBe("waiting");
  });

  test("an account that has never issued a statement is omitted, not flagged", () => {
    // A cash wallet issues no statements; nagging about them would be invented.
    // Two accounts, because asserting an empty list proves nothing on a seed
    // that ships none — the point is that ONE of them is dropped.
    makeAccount("Cash on Hand");
    const withStatements = makeAccount("Chase Checking");
    for (const end of ["2026-05-31", "2026-06-30", "2026-07-31"]) {
      fileId = newFile(`${end}.pdf`);
      addPeriod(withStatements, end);
    }
    const names = statementPulls(bundle.db, TODAY).map((p) => p.accountName);
    expect(names).toEqual(["Chase Checking"]);
  });

  test("an inactive account is not chased for statements", () => {
    const id = makeAccount("Closed Card");
    for (const end of ["2026-04-30", "2026-05-31", "2026-06-30"]) {
      fileId = newFile(`${end}.pdf`);
      addPeriod(id, end);
    }
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, id)).run();
    expect(statementPulls(bundle.db, TODAY)).toEqual([]);
  });
});
