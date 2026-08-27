/** READ-ONLY. What this pass added to each page's server work, on the e2e fixture. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_FAKE_TODAY, seedE2eDatabase } from "../e2e/seed-helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cost-"));
const dbPath = path.join(dir, "e2e.db");
process.env.MONEYAPP_DB_PATH = dbPath;
process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;
await seedE2eDatabase(dbPath);

const { getDb } = await import("@/db/client");
const { provenanceFor } = await import("@/services/provenance");
const { budgetInsights } = await import("@/services/budget-insights");
const { yearInsights } = await import("@/services/year-insights");
const { budgetStatuses } = await import("@/services/budgets");
const db = getDb();

const time = (label: string, fn: () => unknown, runs = 5) => {
  fn(); // warm the statement cache, as a second page view would find it
  const t = performance.now();
  for (let i = 0; i < runs; i++) fn();
  console.log(`${((performance.now() - t) / runs).toFixed(1)}ms  ${label}`);
};

const statuses = budgetStatuses(db, E2E_FAKE_TODAY);
time("/spending — the allSpend badge (one month)", () =>
  provenanceFor(db, { kind: "allSpend", from: "2026-07-01", to: "2026-07-31", label: "Jul 2026" }));
time("/spending — the allSpend badge (twelve months)", () =>
  provenanceFor(db, { kind: "allSpend", from: "2025-08-01", to: "2026-07-31", label: "a year" }));
time(`/budgets — ${statuses.length} budgetPlan badges`, () =>
  statuses.map((s) => provenanceFor(db, { kind: "budgetPlan", id: s.budget.id, label: s.categoryPath })));
time("/budgets — the strip", () => budgetInsights(db, E2E_FAKE_TODAY));
time("/summary/2026 — the strip (2 periodTotals + 3 graded row sets)", () => yearInsights(db, 2026));
fs.rmSync(dir, { recursive: true, force: true });
