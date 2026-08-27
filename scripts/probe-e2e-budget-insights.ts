/** READ-ONLY probe against a FRESH e2e seed — /budgets and /spending, measured. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_FAKE_TODAY, seedE2eDatabase } from "../e2e/seed-helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-e2eprobe-"));
const dbPath = path.join(dir, "e2e.db");
process.env.MONEYAPP_DB_PATH = dbPath;
process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;
await seedE2eDatabase(dbPath);

const { getDb } = await import("@/db/client");
const { budgetInsights } = await import("@/services/budget-insights");
const { budgetStatuses } = await import("@/services/budgets");
const { provenanceFor } = await import("@/services/provenance");
const db = getDb();

console.log("budgets:", budgetStatuses(db, E2E_FAKE_TODAY).map((s) => `${s.categoryPath}/${s.budget.period}/${s.budget.amountCents}${s.budget.rolloverEnabled ? " ROLL" : ""}`).join(", "));
const r = budgetInsights(db, E2E_FAKE_TODAY);
if (!r) console.log("\n/budgets strip: (withheld)");
else {
  console.log(`\n/budgets [${r.windowLabel}]\n   note: ${r.windowNote}`);
  for (const i of r.insights) console.log(`   · ${i.text}   → ${i.provenance.verdict} "${i.provenance.badgeWord}"`);
}
for (const s of budgetStatuses(db, E2E_FAKE_TODAY).slice(0, 2)) {
  const p = provenanceFor(db, { kind: "budgetPlan", id: s.budget.id, label: s.categoryPath })!;
  console.log(`\n   plan badge ${s.categoryPath}: "${p.badgeWord}" — ${p.headline.slice(0, 150)}…`);
}

const t0 = performance.now();
const sp = provenanceFor(db, { kind: "allSpend", from: "2026-07-01", to: "2026-07-31", label: "Jul 2026" })!;
console.log(`\n/spending "Where it went" badge [${(performance.now() - t0).toFixed(0)}ms] ${sp.verdict} "${sp.badgeWord ?? ""}"\n   ${sp.headline}`);
fs.rmSync(dir, { recursive: true, force: true });
