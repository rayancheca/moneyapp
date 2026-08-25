/**
 * REAL-DB WRITE. The first slice of the Rocket Money reconciliation, 2026-08-25,
 * limited to what the owner explicitly approved in conversation.
 *
 *   1. A `Weed` category, and the 22 rows his export files under it.
 *   2. A Wells Fargo account — confirmed by the export, opened 2026-07-27, and
 *      the destination of the Zelle transfers filed earlier today.
 *   3. A Capital One 360 Checking account, which he kept.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch the Income column. His export calls parents' money and his
 * own inter-account transfers "Income" — $65,743 of it across 51 rows — and he
 * agreed the ledger's split is the better one: "i was categorisng my parent
 * money as income and youre categorising as transfers or gifts or something
 * else which makes sense".
 *
 * It does not import Wells Fargo's 39 transactions. The account is created so
 * the transfers have somewhere to land; the rows need a Wells Fargo statement or
 * a purpose-built importer, and a secondary export is not a source document.
 *
 * It does not touch Chime. He opened it for a $300 bonus and closed it.
 *
 * ⚠️ Only the 22 rows the export matches UNIQUELY on (date, amount) move. The
 * other 17 collide with same-day, same-amount siblings — several $20 ATM
 * withdrawals on one day — and picking between them would be inventing a link.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { createAccount, createInstitution } from "@/services/accounts";
import { createCategory } from "@/services/category-edit";
import { formatCents } from "@/lib/money";

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const num = (q: string): number => one<{ v: number }>(q).v;
const str = (q: string): string => one<{ v: string }>(q).v;

const netCents = () => num("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
const rowCount = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active'");
const links = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(recurring_series_id,'-') x FROM transactions ORDER BY id)");
const cats = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(category_id,'-') x FROM transactions ORDER BY id)");
const balances = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)");

const weedIds: string[] = JSON.parse(fs.readFileSync("data/weed-ids.json", "utf8"));
if (weedIds.length === 0) throw new Error("no weed ids — run data/weed-map.ts first");

const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-rocket-money.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

const before = {
  net: netCents(),
  rows: rowCount(),
  links: links(),
  balances: balances(),
  accounts: num("SELECT COUNT(*) v FROM accounts"),
  categories: num("SELECT COUNT(*) v FROM categories"),
  cats: cats(),
};

// 1. the category
const weed = createCategory(db, { name: "Weed", kind: "expense" });
console.log(`  category  Weed  (${weed.id})`);

// 2. the rows
const moved = db
  .update(transactions)
  .set({ categoryId: weed.id, categorizationSource: "user", needsReview: false })
  .where(inArray(transactions.id, weedIds))
  .run().changes;
console.log(`  moved     ${moved} rows → Weed`);

// 3. the accounts
const wellsFargoId = createInstitution(db, "Wells Fargo");
const wf = createAccount(db, {
  institutionId: wellsFargoId,
  name: "Wells Fargo Everyday Checking",
  type: "checking",
  last4: "5481",
});
const capOne = db.select({ id: sql<string>`id` }).from(sql`institutions`).where(sql`name = 'Capital One'`).get()!;
const c1 = createAccount(db, {
  institutionId: capOne.id,
  name: "Capital One 360 Checking",
  type: "checking",
});
console.log(`  account   Wells Fargo Everyday Checking (${wf})`);
console.log(`  account   Capital One 360 Checking (${c1})\n`);

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(26)} ${detail}`);
  if (!ok) failures.push(name);
};

guard("rows recategorized", moved === weedIds.length, `${moved} of ${weedIds.length}`);
guard("net worth", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("no row re-linked", before.links === links(), "every series link unchanged");
guard("daily_balances", before.balances === balances(), "untouched");
guard("accounts added", num("SELECT COUNT(*) v FROM accounts") === before.accounts + 2, "+2");
guard("categories added", num("SELECT COUNT(*) v FROM categories") === before.categories + 1, "+1");
// The only categories that may have moved are the ones we moved.
const changedCats = before.cats.split(",").filter((p, i) => p !== cats().split(",")[i]).length;
guard("only the Weed rows moved", changedCats === weedIds.length, `${changedCats} category changes`);
guard(
  "new accounts are empty",
  num(`SELECT COUNT(*) v FROM transactions WHERE account_id IN ('${wf}','${c1}')`) === 0,
  "0 rows — they need a statement",
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
