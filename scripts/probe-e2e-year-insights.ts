/** READ-ONLY probe against a FRESH e2e seed — what /summary/[year] renders, measured. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_FAKE_TODAY, seedE2eDatabase } from "../e2e/seed-helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-e2eprobe-"));
const dbPath = path.join(dir, "e2e.db");
process.env.MONEYAPP_DB_PATH = dbPath;
process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;

const summary = await seedE2eDatabase(dbPath);
console.log(`seeded ${summary.txns} txns, fake today ${E2E_FAKE_TODAY}\n`);

const { getDb } = await import("@/db/client");
const { summaryYears } = await import("@/services/year-summary");
const { yearInsights } = await import("@/services/year-insights");
const { observationFrontier } = await import("@/services/observation-frontier");
const { ledgerFirstDay } = await import("@/services/spending");
const db = getDb();
console.log(`ledger starts ${ledgerFirstDay(db)}`);
console.log(`frontiers: ${[...observationFrontier(db).byAccount.values()].sort().join(", ")}\n`);
for (const y of summaryYears(db).slice().sort()) {
  const r = yearInsights(db, y);
  if (!r) { console.log(`${y}: (withheld)`); continue; }
  console.log(`${y}  [${r.windowLabel}]\n   note: ${r.windowNote}`);
  for (const i of r.insights) console.log(`   · ${i.text}   → ${i.provenance.verdict}${i.provenance.badgeWord ? ` "${i.provenance.badgeWord}"` : ""}`);
}
fs.rmSync(dir, { recursive: true, force: true });
