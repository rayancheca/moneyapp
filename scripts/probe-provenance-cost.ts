/** READ-ONLY. How expensive is a categorySpend provenance, and does it scale? */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { provenanceFor } from "@/services/provenance";
import { accountCoverage } from "@/services/coverage";

const db = getDb();
const time = (label: string, fn: () => void, n = 1): number => {
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(1)}ms${n > 1 ? `  (${(ms / n).toFixed(1)}ms each)` : ""}`);
  return ms;
};

const cats = db.all(sql.raw(
  "SELECT c.id FROM categories c JOIN transactions t ON t.category_id=c.id AND t.status='active' GROUP BY c.id ORDER BY COUNT(*) DESC LIMIT 10",
)) as { id: string }[];

time("accountCoverage alone", () => void accountCoverage(db));
time("one categorySpend (biggest category)", () =>
  void provenanceFor(db, { kind: "categorySpend", categoryId: cats[0]!.id, from: "2026-01-01", to: "2026-08-26" }));
time("10 categorySpend calls — what /budgets would cost", () => {
  for (const c of cats) provenanceFor(db, { kind: "categorySpend", categoryId: c.id, from: "2026-08-01", to: "2026-08-26" });
});
time("netWorth", () => void provenanceFor(db, { kind: "netWorth" }));
