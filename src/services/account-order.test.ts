import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { seedDatabase } from "@/db/seed";
import { listAccountOptions } from "./accounts";
import { commandEntityGroups } from "./command-index";
import { accountCoverage } from "./coverage";
import { statementGaps } from "./statement-gaps";
import { statementPulls } from "./statement-pulls";

/**
 * Every surface that lists accounts lists them in THE order: institution, then
 * the within-institution `displayOrder` a drag-reorder writes, then name.
 *
 * 🔴 Measured on the owner's ledger 2026-09-15. Every account carries
 * `display_order` 0 except Chase Checking (1), Robinhood Cash (1) and Robinhood
 * Crypto (2), so a list ordered by `displayOrder` alone reads nine accounts
 * alphabetically and then appends those three after Wells Fargo:
 *
 *   - the dashboard net-worth popover, and ConcentrationCard's copy of it,
 *     via `accountCoverage`: "… Venture X · Wells Fargo Everyday Checking ·
 *     Chase Checking · Robinhood Cash · Robinhood Crypto"
 *   - the dashboard Statements teaser, via `statementPulls`: "SoFi Checking /
 *     SoFi Savings / Chase Checking", where /imports prints Chase first
 *
 * and the ⌘K palette sorted by institution then NAME, ignoring the drag-reorder
 * outright: "Chase Checking (Chase) | Chase Sapphire (Chase)".
 *
 * ⛔ The fixture has to make the three orders DISAGREE, or it cannot tell them
 * apart. The e2e seed gives all eight of its accounts `display_order` 0 and
 * names each after its institution, so every one of these orders sorts it
 * identically, and no Playwright run could ever have caught this.
 */

let dir: string;
let bundle: DbBundle;
let seq = 0;

const TODAY = "2026-09-15";

/*
 *   id          institution          displayOrder
 *   sapphire    Alder Credit Union   0
 *   checking    Alder Credit Union   1
 *   card        Birch Bank           0
 *
 * THE order:                   sapphire, checking, card
 * displayOrder alone:          card, sapphire, checking
 * institution, then name:      checking, sapphire, card
 */
const THE_ORDER = ["sapphire", "checking", "card"];

function addInstitution(name: string): string {
  return bundle.db.insert(institutions).values({ name }).returning({ id: institutions.id }).get().id;
}

function addAccount(id: string, institutionId: string, name: string, displayOrder: number): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: "credit",
      currency: "USD",
      isActive: true,
      displayOrder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function addPeriod(accountId: string, institutionId: string, start: string, end: string): void {
  seq += 1;
  const fileId = `f-${seq}`;
  bundle.db
    .insert(importFiles)
    .values({
      id: fileId,
      fileName: `s-${seq}.pdf`,
      fileSha256: `sha-${seq}`,
      format: "pdf",
      institutionId,
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
      reconciliation: "reconciled",
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** monthly closes on the 18th with September absent — a statement close AND a hole */
function addStatementsWithAHole(accountId: string, institutionId: string): void {
  addPeriod(accountId, institutionId, "2024-06-19", "2024-07-18");
  addPeriod(accountId, institutionId, "2024-07-19", "2024-08-18");
  addPeriod(accountId, institutionId, "2024-09-19", "2024-10-18");
  addPeriod(accountId, institutionId, "2024-10-19", "2024-11-18");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-account-order-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  seq = 0;

  const alder = addInstitution("Alder Credit Union");
  const birch = addInstitution("Birch Bank");
  // inserted in neither THE order nor either wrong one, so insertion order cannot pass for a sort
  addAccount("checking", alder, "Checking", 1);
  addAccount("card", birch, "Card", 0);
  addAccount("sapphire", alder, "Sapphire", 0);
  for (const [id, institutionId] of [
    ["checking", alder],
    ["card", birch],
    ["sapphire", alder],
  ] as const) {
    addStatementsWithAHole(id, institutionId);
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("THE account order, wherever accounts are listed", () => {
  test("listAccountOptions is the order the others are held to", () => {
    expect(listAccountOptions(bundle.db).map((a) => a.id)).toEqual(THE_ORDER);
  });

  test("accountCoverage — the net-worth popover's inputs, and ConcentrationCard's", () => {
    expect(accountCoverage(bundle.db, TODAY).map((c) => c.accountId)).toEqual(THE_ORDER);
  });

  test("statementPulls — the dashboard Statements teaser", () => {
    expect(statementPulls(bundle.db, TODAY).map((p) => p.accountId)).toEqual(THE_ORDER);
  });

  test("statementGaps — the /imports missing-statements panel", () => {
    expect(statementGaps(bundle.db).map((g) => g.accountId)).toEqual(THE_ORDER);
  });

  test("commandEntityGroups — the ⌘K palette honours the drag-reorder", () => {
    const group = commandEntityGroups(bundle.db).find((g) => g.label === "Accounts");
    expect(group?.items.map((i) => i.id)).toEqual(THE_ORDER.map((id) => `account-${id}`));
  });
});
