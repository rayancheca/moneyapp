/** READ-ONLY probe against a FRESH e2e seed — which merchant page a baseline should capture. */
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
const { merchantIntelligence } = await import("@/services/merchants");
const { merchantInsights } = await import("@/services/merchant-insights");
const { topMerchants } = await import("@/services/spending");
const { resolvePeriod } = await import("@/lib/period");
const db = getDb();
const p = resolvePeriod({ period: "month" }, E2E_FAKE_TODAY);

for (const e of topMerchants(db, { from: p.from, to: p.to }).entries.filter((x) => x.kind === "merchant")) {
  const intel = merchantIntelligence(db, e.id!);
  const ins = merchantInsights(db, e.id!);
  console.log(
    `${e.name.padEnd(22)} txns=${String(e.txnCount).padStart(3)}  intel=${intel ? "yes" : "no"}  strip=${ins ? `${ins.insights.length} lines` : "(none)"}`,
  );
  if (ins) for (const i of ins.insights) console.log(`      · ${i.text}`);
}
fs.rmSync(dir, { recursive: true, force: true });
