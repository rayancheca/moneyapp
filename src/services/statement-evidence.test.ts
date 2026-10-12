import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles, statementPeriods, type ReconciliationState } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "./accounts";
import { statementEvidence } from "./statement-evidence";
import { statementsByAccount } from "./statements-by-account";

/**
 * /imports reads `statement_periods` three ways, and a Robinhood OPENING statement is where they part: the statement
 * schedule and Statements you do not have count it (`countsAsStatement`), "What the statements proved" and its tiles
 * do not (`carriesBalances` — it printed `N/A` for its opening, so nothing in it could have failed), and the list's
 * footer has to say which of the two each left-out period is.
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-12: the footer read "5 imported documents carried no balance to check
 * — a spending report, an export without a closing figure" of two Chase Spending Reports, one Rocket Money export and
 * two Robinhood opening statements (Robinhood Cash, Dec 2023; Robinhood Agentic, Jun 2026), the schedule above it
 * counting those two as statements. Agentic's came out of a PDF that also printed Robinhood Cash's and the brokerage
 * book's balances, so "a document that carried no balance" was not true of its document either. And nothing tested
 * the page's filter at all: it lived in page.tsx, where no unit test reaches.
 */

let dir: string;
let bundle: DbBundle;

function newFile(name: string, parserProfile: string | null): string {
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return bundle.db
    .insert(importFiles)
    .values({
      fileName: name,
      fileSha256: name,
      format: name.endsWith(".pdf") ? "pdf" : name.endsWith(".qfx") ? "qfx" : "csv",
      institutionId: chase.id,
      parserProfile,
      status: "parsed",
      storagePath: `/tmp/${name}`,
      importedAt: "2026-10-12",
    })
    .returning({ id: importFiles.id })
    .get().id;
}

function makeAccount(name: string): string {
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return createAccount(bundle.db, { institutionId: chase.id, name, type: "checking" });
}

function addPeriod(fileId: string, accountId: string, start: string, end: string, reconciliation: ReconciliationState): string {
  return bundle.db
    .insert(statementPeriods)
    .values({ importFileId: fileId, accountId, periodStart: start, periodEnd: end, reconciliation })
    .returning({ id: statementPeriods.id })
    .get().id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-evidence-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** His ledger's shape, 2026-10-12: one Robinhood PDF that opened Agentic beside two sections with balances, a
 *  Spending Report, a balance-less export, and an OFX download whose two accounts both printed none. */
function hisShape() {
  const agentic = makeAccount("Robinhood Agentic");
  const cash = makeAccount("Robinhood Cash");
  const brokerage = makeAccount("Robinhood Brokerage");
  const sapphire = makeAccount("Chase Sapphire");
  const wellsFargo = makeAccount("Wells Fargo Everyday Checking");
  const checking = makeAccount("Chase Checking");

  const june = newFile("747059b1.pdf", "robinhood-brokerage-statement-pdf");
  const opening = addPeriod(june, agentic, "2026-06-01", "2026-06-30", "not_applicable");
  const cashJune = addPeriod(june, cash, "2026-06-01", "2026-06-30", "reconciled");
  const brokerageJune = addPeriod(june, brokerage, "2026-06-01", "2026-06-30", "value_anchor");
  const july = newFile("rh-2026-07.pdf", "robinhood-brokerage-statement-pdf");
  const agenticJuly = addPeriod(july, agentic, "2026-07-01", "2026-07-31", "reconciled");

  addPeriod(newFile("Spending Report PDF (1).pdf", "chase-spending-report-pdf"), sapphire, "2026-01-01", "2026-07-10", "not_applicable");
  const sapphireAug = addPeriod(newFile("sapphire-2026-08.pdf", "chase-card-statement-pdf"), sapphire, "2026-07-03", "2026-08-02", "gap");
  addPeriod(newFile("rocket-money-export.csv", "rocket-money-csv"), wellsFargo, "2026-07-27", "2026-08-24", "not_applicable");
  const ofx = newFile("download.qfx", "ofx-generic");
  addPeriod(ofx, sapphire, "2026-08-03", "2026-08-20", "not_applicable");
  addPeriod(ofx, checking, "2026-08-01", "2026-08-20", "not_applicable");

  return { agentic, opening, cashJune, brokerageJune, agenticJuly, sapphireAug };
}

describe("statementEvidence — what /imports' \"What the statements proved\" lists, and what its footer names", () => {
  test("⛔ a Robinhood opening statement is a statement on the schedule, and not a period the list proves anything by", () => {
    const shape = hisShape();
    const { evidence } = statementEvidence(bundle.db);
    expect(evidence.map((p) => p.id)).not.toContain(shape.opening);
    // the same row, read by the rule the statement schedule and Statements you do not have read
    expect(statementsByAccount(bundle.db).get(shape.agentic)).toEqual([
      { start: "2026-06-01", end: "2026-06-30" },
      { start: "2026-07-01", end: "2026-07-31" },
    ]);
  });

  test("the list is every period that printed balances, newest close first, whatever its verdict", () => {
    const shape = hisShape();
    const { periods, evidence } = statementEvidence(bundle.db);
    expect(periods).toHaveLength(9);
    const ids = evidence.map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual([shape.sapphireAug, shape.agenticJuly]);
    // the June PDF's two sections close the same day; the page never ordered within a day, nor does this
    expect(new Set(ids.slice(2))).toEqual(new Set([shape.cashJune, shape.brokerageJune]));
    expect(evidence.find((p) => p.id === shape.agenticJuly)).toMatchObject({
      accountName: "Robinhood Agentic",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      reconciliation: "reconciled",
    });
  });

  test("🔴 the footer's two counts: documents that are no statement at all, and opening statements — by the schedule's rule", () => {
    hisShape();
    const { periods, evidence, reportDocuments, openingStatements } = statementEvidence(bundle.db);
    // the Spending Report, the Rocket Money export and the OFX download — ONE document, though it printed two accounts
    expect(reportDocuments).toBe(3);
    // Agentic's June section, though the PDF it came out of printed balances for two other accounts
    expect(openingStatements).toBe(1);
    // ⚠️ documents, not periods: five periods are left out of the list, the OFX's two among them
    expect(periods.length - evidence.length).toBe(5);
  });

  test("no balance-less period, nothing to name", () => {
    const account = makeAccount("Chase Checking");
    addPeriod(newFile("a.pdf", "chase-checking-statement-pdf"), account, "2026-08-01", "2026-08-31", "reconciled");
    expect(statementEvidence(bundle.db)).toMatchObject({ reportDocuments: 0, openingStatements: 0 });
  });
});
