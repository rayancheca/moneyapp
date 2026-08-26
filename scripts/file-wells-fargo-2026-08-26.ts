/**
 * REAL-DB WRITE. Files the Wells Fargo rows that can be filed, and FLAGS the
 * rest rather than guessing at them.
 *
 * 29 rows were left uncategorized after the import and the v2 re-normalization.
 * They split three ways, and the split is the point:
 *
 *  1. **Nine rows the owner answered himself.** His words, 2026-08-26:
 *     *"rezaul is my dad giving me money for rent. zelles from rayan which is me
 *     are just ransfers from another account duh. monira is my cousin that
 *     gifted me 2k"*.
 *
 *     The dad's $2,022.92 is `Gifts received`, not `Pass-through`: money for
 *     rent that he then SPENDS on rent became his, and pass-through means money
 *     routed onward to someone else (pass a3a780b drew that line). The cousin's
 *     $2,000 is a gift by his own account. Both are transfer-kind, so the
 *     settled income figure cannot move — asserted below.
 *
 *     The five `ZELLE FROM RAYAN KARIM CHECA` rows are the FAR SIDE of transfers
 *     whose Chase legs were REF-matched last pass — `JPM99CQXLN8W`,
 *     `JPM99CSO5OZR`, `JPM99CU77AM7` and the two $1 test sends each appear on
 *     both legs — so filing them `Internal Transfer` also gives the transfer
 *     detector a pair to find.
 *
 *  2. **Ten rows with UNANIMOUS precedent elsewhere in the ledger.** Every one
 *     of these merchants already appears on another card and is filed exactly
 *     one way there: YA-FIT, PURA VIDA and EL COCO LOCO are `Food > Dining`,
 *     FLAMINGO FOOD MARKET is `Food > Groceries`, and 6800 BRICKELL CITY —
 *     which reads like a shop and is a parking garage — is
 *     `Transport > Parking & Tolls`. The ledger is answering from its own
 *     history, not from a guess about a merchant name.
 *
 *  3. **Ten rows FLAGGED FOR REVIEW, not categorized.** ⛔ This is the
 *     deliberate part. TACO STAND, THE EMPANADAS, DONUT GALLERY, WRAP PIT STOP,
 *     OCEAN CINEMAS and MOVE FITNESS have no precedent at all — reading a
 *     category off a merchant's NAME is the same move that put a $0.42 metro
 *     fare in "Dining & Drinks". CANTEEN and SUFRAT DO have precedent and it is
 *     SPLIT (39 Groceries vs 14 Dining; 3 Delivery vs 1 Dining), which is not
 *     evidence, it is a coin toss with extra steps. And the $25 opening deposit
 *     came `FROM CARD ····7782`, a card this ledger does not hold.
 *
 *     They land in the review inbox, where the per-row picker built two passes
 *     ago lets him answer ten questions in a minute — which is the right place
 *     for ten questions only he can answer.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";

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

const SCOPE = `t.status='active' AND a.last4='5481' AND t.category_id IS NULL`;
type Row = { id: string; amount_cents: number; normalized_description: string };
const rowsFor = (where: string): Row[] =>
  db.all(sql.raw(`SELECT t.id, t.amount_cents, t.normalized_description
    FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE ${SCOPE} AND (${where})`)) as Row[];

/** [target, why, predicate over normalized_description] */
const PLAN: { to: string; why: string; where: string }[] = [
  // ── his own answers ────────────────────────────────────────────────
  {
    to: "Transfers > Internal Transfer",
    why: "his own Zelles from Chase — REF-matched on both legs",
    where: `t.normalized_description LIKE 'ZELLE FROM RAYAN KARIM CHECA%'`,
  },
  {
    to: "Transfers > Gifts received",
    why: "dad's rent money, and a cousin's $2k gift",
    where: `(t.normalized_description LIKE 'REZAUL KARIM KHA%' OR t.normalized_description LIKE 'ZELLE FROM MONIRA HOSSAIN%')`,
  },
  { to: "Housing > Rent", why: "Flamingo rent", where: `t.normalized_description LIKE 'FLAMINGO RENT%'` },
  {
    to: "Transfers > Credit Card Payment",
    why: "his Capital One payment",
    where: `t.normalized_description LIKE 'CAPITAL ONE MOBILE PMT%'`,
  },
  // ── unanimous precedent on another card ────────────────────────────
  {
    to: "Food > Dining",
    why: "YA-FIT, PURA VIDA, EL COCO LOCO — one category each, everywhere else",
    where: `(t.normalized_description LIKE 'YA-FIT%' OR t.normalized_description LIKE 'PURA VIDA%'
             OR t.normalized_description LIKE 'EL COCO LOCO%')`,
  },
  { to: "Food > Groceries", why: "Flamingo Food Market", where: `t.normalized_description LIKE 'FLAMINGO FOOD MARK%'` },
  {
    to: "Transport > Parking & Tolls",
    why: "6800 Brickell City is a parking garage — the ledger already says so",
    where: `t.normalized_description LIKE '6800 BRICKELL CITY%'`,
  },
];

// ── restore point ────────────────────────────────────────────────────
const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-file-wf.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

const planned = PLAN.map((p) => ({ ...p, rows: rowsFor(p.where) }));
const claimed = new Map<string, string>();
for (const p of planned) {
  if (p.rows.length === 0) throw new Error(`"${p.to}" matched nothing — a predicate has gone stale`);
  for (const r of p.rows) {
    const prior = claimed.get(r.id);
    if (prior) throw new Error(`row ${r.id} claimed by both "${prior}" and "${p.to}"`);
    claimed.set(r.id, p.to);
  }
}
const uncategorized = rowsFor("1=1");
const toFlag = uncategorized.filter((r) => !claimed.has(r.id));

const before = {
  net: netCents(),
  rows: rowCount(),
  links: links(),
  balances: balances(),
  cats: catMap(),
  expense: kindTotal("expense"),
  income: kindTotal("income"),
  categories: num("SELECT COUNT(*) v FROM categories"),
  reviewQueue: num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND needs_review=1"),
  /**
   * Which rows were ALREADY in the inbox. Filing a row clears its flag, so the
   * queue does not simply grow by the number flagged — six of these Wells Fargo
   * rows were flagged at import and some are among the ones now being filed.
   * Without this the guard's arithmetic is wrong, which is how it failed on the
   * first trial run.
   */
  flaggedIds: new Set(
    (db.all(sql.raw("SELECT id FROM transactions WHERE status='active' AND needs_review=1")) as { id: string }[])
      .map((r) => r.id),
  ),
};
// What the expense pool is about to gain, computed from the rows themselves.
const expenseDelta = planned
  .filter((p) => !p.to.startsWith("Transfers"))
  .flatMap((p) => p.rows)
  .reduce((s, r) => s + r.amount_cents, 0);

console.log(`${uncategorized.length} uncategorized Wells Fargo rows · ${claimed.size} filed · ${toFlag.length} flagged for review\n`);

const now = new Date().toISOString();
let moved = 0;
for (const p of planned) {
  const to = catId(p.to);
  const ids = p.rows.map((r) => `'${r.id}'`).join(",");
  moved += db.run(
    sql.raw(`UPDATE transactions SET category_id='${to}', categorization_source='user', needs_review=0,
             updated_at='${now}' WHERE id IN (${ids})`),
  ).changes as number;
  const amt = p.rows.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  console.log(`  ${String(p.rows.length).padStart(2)} rows ${("$" + (amt / 100).toFixed(2)).padStart(10)}  → ${p.to.padEnd(30)} ${p.why}`);
}
const flagIds = toFlag.map((r) => `'${r.id}'`).join(",");
const flagged = db.run(
  sql.raw(`UPDATE transactions SET needs_review=1, updated_at='${now}' WHERE id IN (${flagIds})`),
).changes as number;
console.log(`  ${String(flagged).padStart(2)} rows ${("$" + (toFlag.reduce((s, r) => s + Math.abs(r.amount_cents), 0) / 100).toFixed(2)).padStart(10)}  → FLAGGED for review, not guessed at\n`);

// ── guards ───────────────────────────────────────────────────────────
const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(32)} ${detail}`);
  if (!ok) failures.push(name);
};

const afterCats = catMap();
const changedIds = [...before.cats.entries()].filter(([id, c]) => afterCats.get(id) !== c).map(([id]) => id);

guard("rows filed", moved === claimed.size, `${moved} of ${claimed.size}`);
guard("rows flagged", flagged === toFlag.length, `${flagged} of ${toFlag.length}`);
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
  guard(`→ ${p.to}`.slice(0, 32), p.rows.every((r) => afterCats.get(r.id) === to), `${p.rows.length} rows landed`);
}
// The rent and the small card purchases are expense-kind; the transfers are not.
guard(
  "spending moves by the rows' own sum",
  kindTotal("expense") === before.expense + expenseDelta,
  `${formatCents(-before.expense)} → ${formatCents(-kindTotal("expense"))}  (${formatCents(-expenseDelta)})`,
);
guard("INCOME unchanged", before.income === kindTotal("income"), formatCents(kindTotal("income")));
/**
 * The queue is a SET, not a counter, and two corrections apply at once: filing
 * a row clears its flag, and some rows being flagged were already in it. Adding
 * `flagged` to the old count double-counts the second group — which is exactly
 * how this guard failed twice before being written as a set operation.
 */
const expectedQueue = new Set([...before.flaggedIds, ...toFlag.map((r) => r.id)]);
for (const id of claimed.keys()) expectedQueue.delete(id);
const queueAfter = num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND needs_review=1");
guard(
  "review queue is exactly the right set",
  queueAfter === expectedQueue.size,
  `${before.reviewQueue} → ${queueAfter} (expected ${expectedQueue.size})`,
);
guard(
  "nothing left both uncategorized and unflagged",
  num(`SELECT COUNT(*) v FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE ${SCOPE} AND t.needs_review=0`) === 0,
  "every remaining unknown is in the inbox",
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
