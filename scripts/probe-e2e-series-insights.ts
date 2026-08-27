/** READ-ONLY probe against a FRESH e2e seed — what the fixture renders, measured. */
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
const { listSeries } = await import("@/services/recurring");
const { recurringInsights } = await import("@/services/recurring-insights");
const db = getDb();
let n = 0;
for (const s of listSeries(db, E2E_FAKE_TODAY)) {
  const r = recurringInsights(db, s.id, E2E_FAKE_TODAY);
  if (!r) continue;
  n++;
  console.log(`/recurring/${s.id}   ${s.name}  [${s.status}/${s.kind}]`);
  console.log(`   note: ${r.windowNote}`);
  for (const i of r.insights) console.log(`   · ${i.text}`);
}
console.log(`\n${n} of ${listSeries(db, E2E_FAKE_TODAY).length} series render a strip.`);
fs.rmSync(dir, { recursive: true, force: true });
