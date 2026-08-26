/**
 * REAL-DB WRITE. The China trip, sorted out of the buckets Chase's merchant
 * code guessed it into. 89 rows change category; no amount, no balance and no
 * series link is touched.
 *
 * The mapping and its evidence live in `weixin-plan.ts`, imported here so the
 * plan that gets reviewed is literally the plan that gets applied.
 *
 * ## Why this is not "recategorise 113 rows"
 *
 * `WEIXIN*` is WeChat Pay — a payment RAIL, not a merchant. All 202 rows sit on
 * Chase Sapphire inside one 2025-06-29 → 2025-07-17 window, and Chase's
 * merchant-category code guessed the rail rather than the shop behind it. It
 * scattered the trip across a bare `Shopping` (113), `Personal Care` (10) and
 * `Travel` — so the SAME KIND OF THING landed in different buckets depending on
 * nothing at all. Two metro fares from this trip were in `Travel`; three more,
 * on the Shanghai transit card, were in `Personal Care`.
 *
 * The owner's rule, chosen 2026-08-26: **file by what it actually is.** Metro
 * and Didi are Transport, museums and temples are Entertainment, only rail and
 * Ctrip stay Travel.
 *
 * 🔴 That rule is applied to the WHOLE TRIP, not only to the 113 rows the task
 * named. Moving `WEIXIN*subway operatio` to `Transport > Public Transit` while
 * leaving `WEIXIN*Hangang Metro` in `Travel` would leave his own metro taps
 * split by which wrong bucket the bank happened to pick — the same
 * one-merchant-two-categories defect corrected for RAM'S VILLAGE last pass.
 *
 * ## What is deliberately NOT touched
 *
 * ⛔ **45 rows stay in bare `Shopping`, by his explicit instruction**, and a
 * guard asserts they did not move. 23 are literally `WEIXIN*Scan QR code fo` —
 * WeChat's placeholder for a merchant that never registered a name — and the
 * rest are truncated past recognition (`Zhengzhou Cit`, `Sanchong Player`,
 * `Stroll in the C`). The descriptor is hard-truncated at 22 characters, so the
 * ledger holds no further evidence and a category here would be invented.
 *
 * ⛔ 4 `Personal Care` rows he did not approve (`Yunnan goods`, `Mai Mo Tansh`,
 * `Fubaobao`, `Cream Story`) and 2 `Travel` rows reading `Foreign affai` stay
 * put — all genuinely ambiguous.
 *
 * ⛔ The Rocket Money export is not consulted. It labels the entire rail
 * "Dining & Drinks", metro fares included — a string-match error, and the
 * reason these rows were excluded from the previous pass.
 *
 * ## Numerically inert, and asserted rather than assumed
 *
 * Every source and target category resolves to an `expense`-kind root, so total
 * spending cannot move — only its split. The guard measures the expense-kind
 * signed total before and after and requires them EQUAL. If that guard ever
 * fails, a row crossed a kind boundary and the plan is wrong.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { WEIXIN_PLAN, WEIXIN_SCOPE } from "./weixin-plan";

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const num = (q: string): number => one<{ v: number }>(q).v;
const str = (q: string): string => one<{ v: string }>(q).v;

const netCents = () => num("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
const rowCount = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active'");
const links = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(recurring_series_id,'-') x FROM transactions ORDER BY id)");
const balances = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)");
const catMap = (): Map<string, string> =>
  new Map((db.all(sql.raw("SELECT id, COALESCE(category_id,'-') c FROM transactions ORDER BY id")) as { id: string; c: string }[])
    .map((r) => [r.id, r.c]));
const kindTotal = (kind: string) =>
  num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
       JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
       WHERE t.status='active' AND COALESCE(p.kind, c.kind)='${kind}'`);

const catId = (p: string): string => {
  const [a, b] = p.split(" > ");
  const q = b
    ? `SELECT c.id v FROM categories c JOIN categories pp ON pp.id=c.parent_id WHERE c.name='${b}' AND pp.name='${a}'`
    : `SELECT id v FROM categories WHERE name='${a}' AND parent_id IS NULL`;
  const row = one<{ v: string } | undefined>(q);
  if (!row) throw new Error(`no category "${p}"`);
  return row.v;
};

type Row = { id: string; amount_cents: number; raw_description: string; cat: string };
const rowsFor = (where: string): Row[] =>
  db.all(sql.raw(`SELECT t.id, t.amount_cents, t.raw_description,
      COALESCE(NULLIF(pp.name,'')||' > ','')||COALESCE(c.name,'?') cat
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories pp ON pp.id=c.parent_id
    WHERE ${WEIXIN_SCOPE} AND (${where})`)) as Row[];

// ── restore point ────────────────────────────────────────────────────
const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-weixin.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

// ── resolve the plan BEFORE writing; the guard re-checks these exact ids ──
const planned = WEIXIN_PLAN.map((p) => ({ ...p, rows: rowsFor(p.where).filter((r) => r.cat !== p.to) }));
const claimed = new Map<string, string>();
for (const p of planned) {
  for (const r of p.rows) {
    const prior = claimed.get(r.id);
    if (prior) throw new Error(`row ${r.id} (${r.raw_description}) claimed by both "${prior}" and "${p.to}"`);
    claimed.set(r.id, p.to);
  }
}
const allWeixin = rowsFor("1=1");
const untouched = allWeixin.filter((r) => !claimed.has(r.id));
const leftInShopping = untouched.filter((r) => r.cat === "Shopping");

console.log(`${allWeixin.length} WEIXIN rows · ${claimed.size} moving · ${untouched.length} left alone`);
console.log(`  of those left alone, ${leftInShopping.length} stay in bare Shopping (his call)\n`);

const before = {
  net: netCents(),
  rows: rowCount(),
  links: links(),
  balances: balances(),
  cats: catMap(),
  expense: kindTotal("expense"),
  income: kindTotal("income"),
  categories: num("SELECT COUNT(*) v FROM categories"),
  weixinCount: allWeixin.length,
};

// ── apply ────────────────────────────────────────────────────────────
let moved = 0;
for (const p of planned) {
  if (p.rows.length === 0) throw new Error(`plan entry "${p.to}" matched nothing — a predicate has gone stale`);
  const to = catId(p.to);
  const ids = p.rows.map((r) => `'${r.id}'`).join(",");
  moved += db.run(
    sql.raw(`UPDATE transactions SET category_id='${to}', categorization_source='user', needs_review=0,
             updated_at='${new Date().toISOString()}' WHERE id IN (${ids})`),
  ).changes as number;
  const amt = p.rows.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  console.log(`  ${String(p.rows.length).padStart(3)} rows ${("$" + (amt / 100).toFixed(2)).padStart(9)}  → ${p.to.padEnd(27)} ${p.why}`);
}
console.log();

// ── guards ───────────────────────────────────────────────────────────
const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(32)} ${detail}`);
  if (!ok) failures.push(name);
};

const after = catMap();
const changedIds = [...before.cats.entries()].filter(([id, c]) => after.get(id) !== c).map(([id]) => id);

guard("rows moved", moved === claimed.size, `${moved} of ${claimed.size}`);
guard("net worth", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("no row re-linked", before.links === links(), "every series link unchanged");
guard("daily_balances", before.balances === balances(), "untouched");
guard("categories", before.categories === num("SELECT COUNT(*) v FROM categories"), "none created");
guard(
  "only the planned rows moved",
  changedIds.length === claimed.size && changedIds.every((id) => claimed.has(id)),
  `${changedIds.length} category changes, all expected`,
);
for (const p of planned) {
  const to = catId(p.to);
  guard(`→ ${p.to}`.slice(0, 32), p.rows.every((r) => after.get(r.id) === to), `${p.rows.length} rows landed`);
}
// Every source and target is expense-kind, so the SPLIT moves and the TOTAL cannot.
guard("SPENDING unchanged", before.expense === kindTotal("expense"), formatCents(-kindTotal("expense")));
guard("INCOME unchanged", before.income === kindTotal("income"), formatCents(kindTotal("income")));
// His explicit instruction: the unidentifiable rows stay where they are.
guard(
  "45 unknowns left in Shopping",
  leftInShopping.length === 45 && leftInShopping.every((r) => after.get(r.id) === before.cats.get(r.id)),
  `${leftInShopping.length} rows, $${(leftInShopping.reduce((s, r) => s + Math.abs(r.amount_cents), 0) / 100).toFixed(2)} — untouched`,
);
guard(
  "no WEIXIN row lost",
  rowsFor("1=1").length === before.weixinCount,
  `${before.weixinCount} rows still present`,
);
guard(
  "trip transit is no longer split",
  num(`SELECT COUNT(DISTINCT c.id) v FROM transactions t JOIN categories c ON c.id=t.category_id
       WHERE ${WEIXIN_SCOPE} AND (t.raw_description LIKE '%Metro%' OR t.raw_description LIKE '%subway operatio%'
       OR t.raw_description LIKE '%One-Ca%' OR t.raw_description LIKE '%Shanghai public%')`) === 1,
  "every metro/transit-card row shares one category",
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
