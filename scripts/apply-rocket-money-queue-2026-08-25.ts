/**
 * REAL-DB WRITE. The second slice of the Rocket Money reconciliation — items 2–4
 * of the owner-approved queue in `docs/HANDOFF-2026-08-25-calendar-and-rocket-money.md`,
 * plus the `Family pass-through` rename he approved in conversation.
 *
 * 100 rows change category; one category is renamed. No amount, no balance and
 * no series link is touched.
 *
 * ## 1. `Dining & Drinks → Shopping` (81 rows, item 2)
 *
 * The queue said 101 rows and named "RAM'S VILLAGE, CASTAWAYS — a bodega and a
 * bar". Measured, the pair is 88 unique matches spanning 12 descriptor groups,
 * and the interesting part is what the export did NOT explain:
 *
 * **RAM'S VILLAGE is already filed both ways in this ledger.** 61 rows on
 * Venture X, Discover and Chase Checking are `Food > Dining`, set by hand
 * (`user`, `claude`, `merchant_map`). All 78 on Chase Sapphire are `Shopping`
 * and every one of them came from `bank_category` — Chase's own merchant code.
 * So this is not "Rocket Money is right"; it is "the owner already told this
 * ledger the answer on three cards, and one card's bank feed overrode him".
 *
 * That is why the move is MERCHANT-level (78) and not limited to the 72 rows
 * the export matched uniquely on (date, amount): the six extra rows are the same
 * merchant, same account, same descriptor, wrong for the same reason. Matching
 * row-by-row would leave the merchant split for no reason.
 *
 * ⚠️ 13 `WEIXIN*` rows in the same pair are DELIBERATELY NOT MOVED. WeChat Pay
 * is a payment rail, not a merchant: 202 rows, all Chase Sapphire, all inside
 * one 2025-06-29 → 2025-07-17 trip, which this ledger has already split ten ways
 * (Travel, Food, Personal Care, Utilities…). Rocket Money labels the whole rail
 * "Dining & Drinks". Six of the 13 are `Guangzhou Qi 'a` at ~$0.24 each and one
 * is `WEIXIN*subway operatio` at $0.42 — a metro fare their matcher read as a
 * sandwich shop. Copying that in would be exactly what the owner warned against:
 * "just use this as a guide dont just change everythign to what it say here."
 *
 * ## 2. Cash rows (item 3)
 *
 * Item 3 asked for ATM withdrawals categorised by what the cash bought. **The
 * export cannot deliver that**: of 81 ATM rows it leaves 50 as plain "Cash &
 * Checks" and the ~12 it labels otherwise are mostly this ledger's own
 * misfilings showing through. The 13 purposeful ones (Weed) were already applied
 * in `apply-rocket-money-2026-08-25.ts`. What is left is real, and two of the
 * three findings are defects rather than categorisation:
 *
 *   a. **2 casino ATMs → `Gambling`** ($355.20). `ATM EVI* EMPIRE CITY YONKE`
 *      and `ATM FALLSVIEW CASINO`. The one purpose a descriptor can prove is
 *      location. Owner confirmed. Gambling previously saw only DraftKings.
 *
 *   b. **5 ATM cash deposits → `Transfers > Internal Transfer`** (+$393). They
 *      sat in the bare `Cash & ATM` category, whose kind is `expense` — money
 *      coming IN filed as an expense. All 46 of their siblings are hand-filed
 *      into transfer/income categories; these five were `merchant_map` leftovers.
 *      Owner's call: "my own cash".
 *
 *   c. **7 `VENMO CASHOUT` inflows → `Transfers > Internal Transfer`** (+$94.50).
 *      Every Venmo row going OUT is `Transfers > Internal Transfer` (15 rows,
 *      $1,219). Every Venmo row coming IN was `Cash & ATM > ATM Withdrawals` —
 *      the same rail filed two different ways by direction, and the inbound leg
 *      called an ATM withdrawal when it is neither an ATM nor a withdrawal.
 *
 * 🔴 (b) and (c) are why total spending MOVES in this pass. `spendingBucket`
 * admits any row under an expense-kind root regardless of sign, and
 * `monthlySpending` accumulates `-amountCents`, so those 12 inflows were netting
 * against real ATM withdrawals as if they were refunds of them. They were not.
 * Removing them raises measured spending by exactly $487.50, asserted below.
 *
 * ## 3. `Uncategorized → Transfers > Reimbursements` (item 4) — CONFIRMED, no change
 *
 * 719 rows, 360 in / 359 out, netting +$1,957.22 over three years, every one a
 * Zelle to or from a named individual. His export left them blank because Rocket
 * Money does not know who Adam Fordham is. Nothing to do — as the queue expected.
 *
 * ## 4. A defect found inside item 4 (2 rows)
 *
 * The prior handoff recorded "Carson Lama is his own Wells Fargo Zelle handle".
 * Half true, and the half that is false had already moved two rows.
 *
 * Cross-checking Zelle REF numbers between the two legs of the export settles it
 * exactly. Five Chase payments "TO CARSON LAMA" arrive at his own Wells Fargo
 * account — `JPM99CQXLSRM`, `JPM99CQXLN8W`, `JPM99CSO5OZR`, `JPM99CU779B3`,
 * `JPM99CU77AM7`, each matching a WF row reading `ZELLE FROM RAYAN KARIM CHECA`
 * with the same reference. Those are genuinely internal.
 *
 * But Carson Lama transactions run from **2024-10-04**, twenty-one months before
 * that account was opened (2026-07-27), across ~110 small peer-to-peer splits.
 * The two rows moved here — 2026-08-05 $50 and 2026-08-06 $15 — carry Chase's
 * person-contact ids (`30296212096`, `30299747493`), not a `JPM99…` Zelle
 * reference; no Wells Fargo arrival exists on either date; and on 2026-08-13
 * Carson sent back exactly $65, a row already sitting in `Reimbursements`.
 * They are a reimbursement round-trip. `merchant_map` had guessed otherwise.
 *
 * ## 5. `Family pass-through` → `Pass-through` (owner-approved)
 *
 * $3,000 across 2026-05-12 and 2026-05-18 sat in `Transfers > Loans`. His
 * account: "my girl giving me money to send to her but i had to take it back out
 * cause she changed her mind." A pass-through — but the only category shaped for
 * it was named `Family`, which she is not. He chose "Rename to 'Pass-through'",
 * and the three rows move into it.
 *
 * ⚠️ The rename is NOT a display-only change and `renameCategory()` REFUSES it:
 * transfer-kind categories keep their names because the transfer detector
 * resolves them by name. `src/services/year-summary.ts` did exactly that for
 * this category, so it is updated in the same commit — renaming the row alone
 * would have silently dropped $36,963 of pass-through off `/summary/[year]`.
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
const catMap = (): Map<string, string> =>
  new Map((db.all(sql.raw("SELECT id, COALESCE(category_id,'-') c FROM transactions ORDER BY id")) as { id: string; c: string }[])
    .map((r) => [r.id, r.c]));
const balances = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)");
/** Everything the app treats as income. Must not move by a cent. */
const incomeCents = () =>
  num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
       JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
       WHERE t.status='active' AND COALESCE(p.kind, c.kind)='income'`);
/** Signed total over every expense-kind root — what `spendingBucket` admits. */
const expenseCents = () =>
  num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
       JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
       WHERE t.status='active' AND COALESCE(p.kind, c.kind)='expense'`);
const accountCount = () => num("SELECT COUNT(*) v FROM accounts");
const categoryCount = () => num("SELECT COUNT(*) v FROM categories");

const catId = (path: string): string => {
  const [a, b] = path.split(" > ");
  const q = b
    ? `SELECT c.id v FROM categories c JOIN categories p ON p.id=c.parent_id WHERE c.name='${b}' AND p.name='${a}'`
    : `SELECT id v FROM categories WHERE name='${a}' AND parent_id IS NULL`;
  const row = one<{ v: string } | undefined>(q);
  if (!row) throw new Error(`no category "${path}"`);
  return row.v;
};

/** Each move states its own SELECT, so the guard can re-derive the same set. */
const MOVES: { label: string; to: string; where: string; expect: number; expectCents: number }[] = [
  {
    label: "bodega + bar → Food > Dining",
    to: "Food > Dining",
    where: `c.name='Shopping' AND c.parent_id IS NULL AND (
              t.raw_description LIKE 'RAM%VILLAGE%' OR t.raw_description LIKE 'CASTAWAYS%'
              OR t.raw_description LIKE '%42ND STREET%' OR t.raw_description LIKE 'HEX %')`,
    expect: 81,
    expectCents: -71654,
  },
  {
    label: "casino ATMs → Gambling",
    to: "Gambling",
    where: `c.name='ATM Withdrawals' AND (t.raw_description LIKE '%EMPIRE CITY%' OR t.raw_description LIKE '%FALLSVIEW CASINO%')`,
    expect: 2,
    expectCents: -35520,
  },
  {
    label: "ATM cash deposits → Internal",
    to: "Transfers > Internal Transfer",
    where: `c.name='Cash & ATM' AND c.parent_id IS NULL`,
    expect: 5,
    expectCents: 39300,
  },
  {
    label: "VENMO CASHOUT → Internal",
    to: "Transfers > Internal Transfer",
    where: `c.name='ATM Withdrawals' AND t.raw_description LIKE '%VENMO%' AND t.amount_cents > 0`,
    expect: 7,
    expectCents: 9450,
  },
  {
    label: "Carson Aug 5/6 → Reimbursements",
    to: "Transfers > Reimbursements",
    where: `c.name='Internal Transfer' AND t.raw_description LIKE '%Carson%' AND t.posted_on IN ('2026-08-05','2026-08-06')`,
    expect: 2,
    expectCents: -6500,
  },
  {
    label: "$3,000 → Pass-through",
    to: "Transfers > Pass-through",
    where: `c.name='Loans' AND t.raw_description LIKE 'ATM CASH DEPOSIT%' AND t.posted_on IN ('2026-05-12','2026-05-18')`,
    expect: 3,
    expectCents: 300000,
  },
];

const idsFor = (where: string): { id: string; amount_cents: number }[] =>
  db.all(sql.raw(`SELECT t.id, t.amount_cents FROM transactions t JOIN categories c ON c.id=t.category_id
                  WHERE t.status='active' AND (${where})`)) as { id: string; amount_cents: number }[];

// ── restore point ────────────────────────────────────────────────────
const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-rocket-queue.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

// ── measure BEFORE ───────────────────────────────────────────────────
const passthroughId = catId("Transfers > Family pass-through");
const before = {
  net: netCents(),
  rows: rowCount(),
  links: links(),
  balances: balances(),
  income: incomeCents(),
  expense: expenseCents(),
  accounts: accountCount(),
  categories: categoryCount(),
  cats: catMap(),
  passthroughRows: num(`SELECT COUNT(*) v FROM transactions WHERE status='active' AND category_id='${passthroughId}'`),
};

// The move sets, resolved BEFORE anything is written — the guard re-checks these
// exact ids afterwards rather than re-running the (now stale) predicates.
const planned = MOVES.map((m) => ({ ...m, rows: idsFor(m.where) }));
for (const p of planned) {
  const cents = p.rows.reduce((s, r) => s + r.amount_cents, 0);
  if (p.rows.length !== p.expect) throw new Error(`${p.label}: expected ${p.expect} rows, found ${p.rows.length}`);
  if (cents !== p.expectCents) throw new Error(`${p.label}: expected ${p.expectCents}c, found ${cents}c`);
}
const allIds = new Set(planned.flatMap((p) => p.rows.map((r) => r.id)));
if (allIds.size !== planned.reduce((s, p) => s + p.rows.length, 0)) throw new Error("a row appears in two move sets");

// ── 1. the rename (renameCategory() refuses transfer-kind, so this is direct) ──
db.run(sql.raw(`UPDATE categories SET name='Pass-through' WHERE id='${passthroughId}'`));
console.log(`  rename    Transfers > Family pass-through → Pass-through`);

// ── 2. the moves ─────────────────────────────────────────────────────
let movedTotal = 0;
for (const p of planned) {
  const to = catId(p.to);
  const ids = p.rows.map((r) => `'${r.id}'`).join(",");
  const changes = db.run(
    sql.raw(`UPDATE transactions SET category_id='${to}', categorization_source='user', needs_review=0,
             updated_at='${new Date().toISOString()}' WHERE id IN (${ids})`),
  ).changes as number;
  movedTotal += changes;
  console.log(`  moved     ${String(changes).padStart(3)} rows  ${p.label.padEnd(34)} ${formatCents(p.rows.reduce((s, r) => s + r.amount_cents, 0))}`);
}
console.log();

// ── guards ───────────────────────────────────────────────────────────
const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(30)} ${detail}`);
  if (!ok) failures.push(name);
};

const after = catMap();
const changedIds = [...before.cats.entries()].filter(([id, c]) => after.get(id) !== c).map(([id]) => id);

guard("rows moved", movedTotal === 100, `${movedTotal} of 100`);
guard("net worth", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("no row re-linked", before.links === links(), "every series link unchanged");
guard("daily_balances", before.balances === balances(), "untouched");
guard("accounts", before.accounts === accountCount(), `${accountCount()} — none added`);
guard("categories", before.categories === categoryCount(), `${categoryCount()} — renamed, not created`);
guard(
  "only the planned rows moved",
  changedIds.length === allIds.size && changedIds.every((id) => allIds.has(id)),
  `${changedIds.length} category changes, all expected`,
);
for (const p of planned) {
  const to = catId(p.to);
  guard(
    `→ ${p.to}`.slice(0, 30),
    p.rows.every((r) => after.get(r.id) === to),
    `${p.rows.length} rows landed`,
  );
}
guard("INCOME unchanged", before.income === incomeCents(), formatCents(incomeCents()));
// The 12 inflows (+$487.50) leave the expense pool, so the signed expense total
// falls by exactly that much and measured SPENDING rises by it.
guard(
  "spending +$487.50 exactly",
  expenseCents() === before.expense - 48750,
  `${formatCents(-before.expense)} → ${formatCents(-expenseCents())}`,
);
guard(
  "no 'Family pass-through' left",
  num("SELECT COUNT(*) v FROM categories WHERE name='Family pass-through'") === 0,
  "renamed",
);
guard(
  "Pass-through keeps its history",
  num(`SELECT COUNT(*) v FROM transactions WHERE status='active' AND category_id='${passthroughId}'`)
    === before.passthroughRows + 3,
  `${before.passthroughRows} + 3 = ${before.passthroughRows + 3} rows`,
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
