/**
 * READ-ONLY. Why `notices`, `car` and `income` return null on the e2e fixture.
 *
 * §7 of the pass-72c handoff put these three on the open list: they are the only
 * decision cards with no pixel coverage anywhere, and no spec change can give it
 * to them — the fixture has to produce them first. This says what each one is
 * actually waiting for, so the seed change is aimed rather than guessed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_FAKE_TODAY, seedE2eDatabase } from "../e2e/seed-helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cards-"));
const dbPath = path.join(dir, "e2e.db");
process.env.MONEYAPP_DB_PATH = dbPath;
process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;
await seedE2eDatabase(dbPath);

const { getDb } = await import("@/db/client");
const db = getDb();
const T = E2E_FAKE_TODAY;

const { noticesCard, FIRST_CHARGE_FLOOR_CENTS, MIN_VISITS_FOR_USUAL, OUTLIER_MULTIPLE, OUTLIER_FLOOR_CENTS } =
  await import("@/services/notices-card");
const { carCard } = await import("@/services/committed");
const { incomeCard } = await import("@/services/income-card");
const { cashEarningsReadings } = await import("@/services/cash-earnings");
const { loadCategoryIndex } = await import("@/services/analytics");
const { accountCoverage } = await import("@/services/coverage");
const { transactions } = await import("@/db/schema/transactions");
const { merchants } = await import("@/db/schema/merchants");
const { recurringSeries } = await import("@/db/schema/recurring");
const { eq, sql } = await import("drizzle-orm");

console.log(`today = ${T}`);
console.log(`notices: ${noticesCard(db, T) ? "RENDERS" : "null"}`);
console.log(`car:     ${carCard(db, T) ? "RENDERS" : "null"}`);
console.log(`income:  ${incomeCard(db, T) ? "RENDERS" : "null"}`);

console.log(`\n── notices ──`);
console.log(`  FIRST_CHARGE_FLOOR = $${(FIRST_CHARGE_FLOOR_CENTS / 100).toFixed(2)}, window 90 days back from ${T}`);
const idx = loadCategoryIndex(db);
const names = new Map(db.select().from(merchants).all().map((m) => [m.id, m.canonicalName]));
const byMerchant = new Map<string, { day: string; cents: number }[]>();
for (const t of db.select().from(transactions).where(eq(transactions.status, "active")).all()) {
  if (t.merchantId === null || t.categoryId === null || t.amountCents >= 0) continue;
  if (idx.topLevelOf(t.categoryId).kind !== "expense") continue;
  const list = byMerchant.get(t.merchantId) ?? [];
  list.push({ day: t.postedOn, cents: -t.amountCents });
  byMerchant.set(t.merchantId, list);
}
const singles = [...byMerchant.entries()]
  .filter(([, rows]) => rows.length === 1)
  .map(([id, rows]) => ({ name: names.get(id) ?? id, ...rows[0]! }))
  .sort((a, b) => b.cents - a.cents);
console.log(`  merchants with exactly one expense charge: ${singles.length}`);
for (const s of singles.slice(0, 6)) {
  console.log(`    ${s.day}  $${(s.cents / 100).toFixed(2)}  ${s.name}   ${s.cents >= FIRST_CHARGE_FLOOR_CENTS ? "(above floor)" : "(below floor)"}`);
}
console.log(`  outliers need >= ${MIN_VISITS_FOR_USUAL} visits, >= ${OUTLIER_MULTIPLE}x the median and >= $${(OUTLIER_FLOOR_CENTS / 100).toFixed(2)}`);

console.log(`\n── car ──`);
const car = [...idx.byId.values()].find((c) => c.parentId === null && c.name === "Car");
console.log(`  top-level "Car" category: ${car ? car.id : "ABSENT — this alone returns null"}`);

console.log(`\n── income ──`);
const readings = cashEarningsReadings(db, { from: "2026-01-01", to: T, today: T });
console.log(`  cashEarningsReadings: ${readings.length}`);
for (const r of readings.slice(0, 5)) console.log(`    ${JSON.stringify(r).slice(0, 160)}`);
const series = db.select().from(recurringSeries).all();
console.log(`  series: ${series.map((s) => `${s.name}[${s.kind}/${s.status}]`).join(", ")}`);
const linked = db.all(sql`SELECT recurring_series_id AS s, COUNT(*) AS n FROM transactions WHERE recurring_series_id IS NOT NULL GROUP BY 1`) as { s: string; n: number }[];
console.log(`  transactions linked to a series: ${linked.length === 0 ? "NONE" : JSON.stringify(linked)}`);
console.log(`  accountCoverage verifiedThrough:`);
for (const c of accountCoverage(db, T)) console.log(`    ${c.accountId.slice(0, 8)}  ${c.grade}  verifiedThrough=${c.verifiedThrough}`);

console.log(`\n── what the three cards say ──`);
const { periodTotals } = await import("@/services/spending");
const all = periodTotals(db, { from: "2000-01-01", to: "2099-12-31" });
const rowCount = (db.all(sql`SELECT COUNT(*) v FROM transactions WHERE status='active'`) as { v: number }[])[0]!.v;
console.log(`  ledger: income $${(all.earnedCents / 100).toFixed(2)}  spending $${(all.spentCents / 100).toFixed(2)}  rows ${rowCount}`);
const n = noticesCard(db, T);
if (n) for (const notice of n.notices) console.log(`  notice: ${notice.text}`);
const c = carCard(db, T);
if (c) console.log(`  car: ${JSON.stringify(c.cost)}`);
const i = incomeCard(db, T);
if (i) console.log(`  income: ${JSON.stringify(i).slice(0, 400)}`);

fs.rmSync(dir, { recursive: true, force: true });
