/**
 * REAL-DB WRITE, one-off. Files the seven Zelle rows in the review queue from
 * the owner's own answers, 2026-08-25.
 *
 * The cluster was one merchant and four counterparties, which is exactly why a
 * group action could not do it:
 *
 *   Carson Lama ×3   → Internal Transfer. Owner: "carson lama is the zele name
 *                      i gave to my wells fargo account". The $1.00 on 07-29 is
 *                      a test transfer ahead of the $199.00 the same day.
 *   Kevin  $300.00   → Food > Dining. "me paying kevin bac for him paying for a
 *                      lot of nights out in new york back in the day". This is
 *                      REAL SPENDING, not a transfer: Kevin's card paid at the
 *                      time, so the money has never left this ledger before now.
 *                      Filing it as a reimbursement would hide it forever.
 *   Ddd    $40.00    → Entertainment. "ddd is my weed dealer so 40 for weed".
 *                      The closest existing bucket; there is no better one, and
 *                      inventing a category is the owner's call, not mine.
 *   Philipe ×2       → Food > Dining. "probably for food or ubers" — his own
 *                      word is "probably", so this is the likelier of two and is
 *                      flagged rather than asserted.
 *
 * Notes are written alongside so the reasoning survives the conversation; a
 * category with no provenance is the thing this whole ledger keeps having to
 * reconstruct.
 *
 * Run: pnpm tsx scripts/file-zelle-review-2026-08-25.ts
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { formatCents } from "@/lib/money";

const INTERNAL_TRANSFER = "019f4c7d-cc8c-7b65-9a52-bb7195e88080";
const FOOD_DINING = "019f4c7d-cc8a-76a3-87e2-e1ad8fbce064";
const ENTERTAINMENT = "019f4c7d-cc8b-77d8-bbf8-21c315864bf4";

const PLAN: { id: string; categoryId: string; note: string; expectCents: number }[] = [
  {
    id: "01a000fe-e33b-700a-ad80-68c7c8ef9258", // 2026-08-11 −$200.00
    categoryId: INTERNAL_TRANSFER,
    note: "Own Wells Fargo — 'Carson Lama' is the Zelle name on it (owner, 2026-08-25).",
    expectCents: -20000,
  },
  {
    id: "01a000fe-e33b-7003-8aa0-30a061d5b866", // 2026-07-29 −$1.00
    categoryId: INTERNAL_TRANSFER,
    note: "Own Wells Fargo — $1.00 test ahead of the $199.00 the same day (owner, 2026-08-25).",
    expectCents: -100,
  },
  {
    id: "01a000fe-e33b-7004-b9f4-d821eb93b049", // 2026-07-29 −$199.00
    categoryId: INTERNAL_TRANSFER,
    note: "Own Wells Fargo — 'Carson Lama' is the Zelle name on it (owner, 2026-08-25).",
    expectCents: -19900,
  },
  {
    id: "01a000fe-e33a-7005-87f0-3ffb248165a4", // 2026-07-16 −$300.00
    categoryId: FOOD_DINING,
    note: "Paying Kevin back for nights out in New York he had covered. Real spending, not a transfer — his card paid at the time (owner, 2026-08-25).",
    expectCents: -30000,
  },
  {
    id: "01a000fe-e33a-7001-8c28-1e23fe5cea51", // 2026-07-15 −$40.00
    categoryId: ENTERTAINMENT,
    note: "Recreational — closest existing category (owner, 2026-08-25).",
    expectCents: -4000,
  },
  {
    id: "01a000fe-e33a-7000-a456-1e49dbf183cf", // 2026-07-14 −$25.00
    categoryId: FOOD_DINING,
    note: "Paying Philipe back, most likely food (owner said 'probably for food or ubers', 2026-08-25).",
    expectCents: -2500,
  },
  {
    id: "01a000fe-e33a-6fff-0000-000000000000", // placeholder, resolved below
    categoryId: FOOD_DINING,
    note: "Paying Philipe back, most likely food (owner said 'probably for food or ubers', 2026-08-25).",
    expectCents: -3800,
  },
];

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;

// The seventh row's id was not captured in the conversation; resolve it by its
// descriptor rather than pasting a guess, and assert exactly one match.
const philipe38 = db.all(
  sql`select id from transactions where status = 'active' and raw_description like '%Philipe Jpm99Cpbeaxj%'`,
) as { id: string }[];
if (philipe38.length !== 1) throw new Error(`expected 1 Philipe $38 row, found ${philipe38.length}`);
PLAN[6]!.id = philipe38[0]!.id;

const fingerprint = (): string =>
  one<{ v: string }>(
    "SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(category_id,'-') x FROM transactions ORDER BY id)",
  ).v;
const netCents = (): number =>
  one<{ v: number }>("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'").v;
const rowCount = (): number =>
  one<{ v: number }>("SELECT COUNT(*) v FROM transactions WHERE status='active'").v;
const balances = (): string =>
  one<{ v: string }>(
    "SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)",
  ).v;

const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-file-zelle.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

const beforeFingerprint = fingerprint();
const beforeNet = netCents();
const beforeRows = rowCount();
const beforeBalances = balances();

db.transaction((tx) => {
  for (const item of PLAN) {
    // Amount is asserted, not trusted: an id pasted from a conversation is the
    // one input here nothing else can check, and filing the wrong row is silent.
    const row = tx
      .select({ amountCents: transactions.amountCents, raw: transactions.rawDescription })
      .from(transactions)
      .where(eq(transactions.id, item.id))
      .get();
    if (!row) throw new Error(`no transaction ${item.id}`);
    if (row.amountCents !== item.expectCents) {
      throw new Error(
        `${item.id}: expected ${formatCents(item.expectCents)}, found ${formatCents(row.amountCents)} (${row.raw})`,
      );
    }
    tx.update(transactions)
      .set({
        categoryId: item.categoryId,
        needsReview: false,
        categorizationSource: "user",
        notes: item.note,
      })
      .where(eq(transactions.id, item.id))
      .run();
  }
});

const changed = beforeFingerprint
  .split(",")
  .filter((pair, i) => pair !== fingerprint().split(",")[i]).length;

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(26)} ${detail}`);
  if (!ok) failures.push(name);
};

guard("rows recategorized", changed === PLAN.length, `${changed} (expected ${PLAN.length})`);
guard("net worth", beforeNet === netCents(), formatCents(netCents()));
guard("active row count", beforeRows === rowCount(), String(rowCount()));
guard("daily_balances", beforeBalances === balances(), "untouched");
guard(
  "review queue drained",
  one<{ v: number }>(
    "SELECT COUNT(*) v FROM transactions WHERE status='active' AND needs_review=1 AND raw_description LIKE 'Zelle Payment To%'",
  ).v === 0,
  "0 Zelle rows left flagged",
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
