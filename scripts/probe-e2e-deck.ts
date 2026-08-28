/** READ-ONLY probe against a FRESH e2e seed — which decision cards actually render. */
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
const db = getDb();
const T = E2E_FAKE_TODAY;
const checks: [string, () => unknown][] = [
  ["runway", async () => (await import("@/services/committed")).runwayCard(db, T)],
  ["car", async () => (await import("@/services/committed")).carCard(db, T)],
  ["income", async () => (await import("@/services/income-card")).incomeCard(db, T)],
  ["cards-owed", async () => (await import("@/services/cards-owed")).cardsOwedCard(db, T)],
  ["eating-out", async () => (await import("@/services/eating-out")).eatingOutCard(db, T)],
  ["subscriptions", async () => (await import("@/services/subscriptions-card")).subscriptionsCard(db, T)],
  ["movers", async () => (await import("@/services/movers-card")).moversCard(db, T)],
  ["fees", async () => (await import("@/services/fees-card")).feesCard(db, T)],
  ["transfers", async () => (await import("@/services/transfers-card")).transfersCard(db, T)],
  ["performance", async () => (await import("@/services/performance-card")).performanceCard(db, T)],
  ["concentration", async () => (await import("@/services/concentration-card")).concentrationCard(db, T)],
  ["notices", async () => (await import("@/services/notices-card")).noticesCard(db, T)],
  ["trust", async () => (await import("@/services/trust-card")).trustCard(db, T)],
];
for (const [name, fn] of checks) {
  try {
    const v = await (fn as () => Promise<unknown>)();
    console.log(`${v ? "✅ renders " : "⬜ absent  "} ${name}`);
  } catch (e) {
    console.log(`⚠️  error    ${name}: ${(e as Error).message.slice(0, 60)}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
