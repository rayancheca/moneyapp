/**
 * REAL-DB WRITE. Gives the ledger two words it did not have: `Taxes` and
 * `Government`.
 *
 * Owner-approved, 2026-08-27, from a measured list. Nine rows — $2,761.19 — of
 * money paid to a government were scattered across five categories, none of
 * which meant "a government charged me this":
 *
 *   | row                                    | was        | is now     |
 *   |----------------------------------------|------------|------------|
 *   | 2026-04-16 NYS DTF PIT Tax Paymnt      | Fees       | Taxes      |
 *   | 2026-04-10 NYS DTF BILL PAYMENT        | Transfers  | Taxes      |
 *   | 2026-04-10 WF4 NYSTAX *SERVICE FEE     | Fees       | Taxes      |
 *   | 2026-06-24 USCIS ELIS I907 W/I765      | Education  | Government |
 *   | 2024-08-26 IMMIGRATION CANADA ONLI     | Fees       | Government |
 *   | 2025-11-21 IMMIGRATION CANADA ONLINE   | Utilities  | Government |
 *   | 2023-05-31 New York State Dmv          | Bank Fees  | Government |
 *   | 2023-06-23 New York State Dmv          | Bank Fees  | Government |
 *   | 2023-09-07 New York State Dmv          | Bank Fees  | Government |
 *
 * Three things about that table are the reason this is a write and not a note:
 *
 *  1. **$76.60 of state income tax was in `Transfers`**, whose kind is
 *     `transfer` — so it counted as neither spending nor income and appeared
 *     nowhere. It is the ONLY row here that changes the expense total, and the
 *     guard below asserts the change is exactly $76.60 and nothing else.
 *  2. **A $2,250.00 USCIS filing fee was `Education`.** It is by far the largest
 *     of the nine and was never a tuition payment.
 *  3. **`Fees` is the card headed "what the banks charge you".** Of the $429.60
 *     it held from this group, $0.00 was a bank charge.
 *
 * ⛔ And the live one: the merchant map gave **New York State Department of
 * Taxation and Finance** a default category of `Other Income`. That is not a
 * display bug — the next NYS statement to land would have been auto-filed as
 * INCOME, against a figure that has been stable for six passes. All three
 * merchant defaults are corrected here, so the fix reaches the next import and
 * not only the rows already in the ledger.
 *
 * DMV under `Government` rather than `Car`: all three predate the lease by more
 * than three years (the car starts 2026-09-11), so they are licence and permit
 * fees, not a vehicle cost.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { createCategory } from "@/services/category-edit";

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const num = (q: string): number => one<{ v: number }>(q).v;
const str = (q: string): string => one<{ v: string }>(q).v;

const netCents = () => num("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
const rowCount = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active'");
const links = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(recurring_series_id,'-')||':'||COALESCE(transfer_group_id,'-') x FROM transactions ORDER BY id)");
const balances = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)");
const catMap = (): Map<string, string> =>
  new Map((db.all(sql.raw("SELECT id, COALESCE(category_id,'-') c FROM transactions ORDER BY id")) as { id: string; c: string }[])
    .map((r) => [r.id, r.c]));
const merchantMap = (): Map<string, string> =>
  new Map((db.all(sql.raw("SELECT id, COALESCE(default_category_id,'-') c FROM merchants ORDER BY id")) as { id: string; c: string }[])
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

/*
 * The nine rows are addressed by their descriptions, not their ids — a
 * predicate that has gone stale is then a loud failure ("matched 0 rows")
 * rather than a silent no-op on a row that has since been re-imported with a
 * new id. Each entry states the count it must match.
 */
const PLAN: { to: "Taxes" | "Government"; why: string; where: string; expect: number }[] = [
  {
    to: "Taxes",
    why: "New York State income tax, its bill payment and the processor's fee",
    where: `(t.raw_description LIKE '%NYS DTF%' OR t.raw_description LIKE '%NYSTAX%')`,
    expect: 3,
  },
  {
    to: "Government",
    why: "a USCIS filing fee, two Canadian immigration charges, three NY DMV fees",
    where: `(t.raw_description LIKE '%USCIS%' OR t.raw_description LIKE '%IMMIGRATION CANADA%'
             OR t.raw_description LIKE '%New York State Dmv%')`,
    expect: 6,
  },
];

/** merchant default → the category the NEXT import should reach for */
const MERCHANT_PLAN: { canonical: string; to: "Taxes" | "Government"; from: string }[] = [
  { canonical: "New York State Department of Taxation and Finance", to: "Taxes", from: "Other Income" },
  { canonical: "New York State Tax Service Fee", to: "Taxes", from: "Fees" },
  { canonical: "Immigration Canada Online", to: "Government", from: "Fees" },
];

type Row = { id: string; amount_cents: number; raw_description: string; cat: string };
const rowsFor = (where: string): Row[] =>
  db.all(sql.raw(`SELECT t.id, t.amount_cents, t.raw_description, COALESCE(c.name,'(none)') cat
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
    WHERE t.status='active' AND (${where})`)) as Row[];

// ── restore point ────────────────────────────────────────────────────
const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-taxes-gov.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

const planned = PLAN.map((p) => ({ ...p, rows: rowsFor(p.where) }));
const claimed = new Map<string, string>();
for (const p of planned) {
  if (p.rows.length !== p.expect) {
    throw new Error(`"${p.to}" matched ${p.rows.length} rows, expected ${p.expect} — a predicate has gone stale`);
  }
  for (const r of p.rows) {
    const prior = claimed.get(r.id);
    if (prior) throw new Error(`row ${r.id} claimed by both "${prior}" and "${p.to}"`);
    claimed.set(r.id, p.to);
  }
}

/*
 * What the expense pool is about to gain, computed from the rows themselves
 * rather than asserted as a constant: only rows arriving from a NON-expense
 * kind move the total, because an expense row moving between two expense
 * categories is invisible to it.
 */
const priorKind = new Map(
  (db.all(sql.raw(`SELECT t.id, COALESCE(p.kind,c.kind) k FROM transactions t
     JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
     WHERE t.id IN (${[...claimed.keys()].map((id) => `'${id}'`).join(",")})`)) as { id: string; k: string }[])
    .map((r) => [r.id, r.k]),
);
const arriving = planned.flatMap((p) => p.rows).filter((r) => priorKind.get(r.id) !== "expense");
const expenseDelta = arriving.reduce((s, r) => s + r.amount_cents, 0);

const before = {
  net: netCents(),
  rows: rowCount(),
  links: links(),
  balances: balances(),
  cats: catMap(),
  merchants: merchantMap(),
  expense: kindTotal("expense"),
  income: kindTotal("income"),
  transfer: kindTotal("transfer"),
  categories: num("SELECT COUNT(*) v FROM categories"),
  reviewQueue: num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND needs_review=1"),
};

for (const p of planned) {
  console.log(`${p.to}  (${p.why})`);
  for (const r of p.rows) {
    console.log(`  ${formatCents(r.amount_cents).padStart(11)}  ${r.cat.padEnd(12)} → ${p.to.padEnd(11)} ${r.raw_description.slice(0, 44)}`);
  }
}
console.log();

// ── the write ────────────────────────────────────────────────────────
const created = PLAN.map((p) => p.to).map((name) => createCategory(db, { name, kind: "expense" }));
for (const c of created) console.log(`  created category  ${c.name.padEnd(12)} (top-level, expense)  ${c.id}`);

const now = new Date().toISOString();
let moved = 0;
for (const p of planned) {
  const to = catId(p.to);
  const ids = p.rows.map((r) => `'${r.id}'`).join(",");
  moved += db.run(
    sql.raw(`UPDATE transactions SET category_id='${to}', categorization_source='user', needs_review=0,
             updated_at='${now}' WHERE id IN (${ids})`),
  ).changes as number;
}
let remapped = 0;
for (const m of MERCHANT_PLAN) {
  const to = catId(m.to);
  remapped += db.run(
    sql.raw(`UPDATE merchants SET default_category_id='${to}', mapping_source='user', updated_at='${now}'
             WHERE canonical_name='${m.canonical.replace(/'/g, "''")}'`),
  ).changes as number;
  console.log(`  merchant default  ${m.canonical.slice(0, 50).padEnd(52)} ${m.from} → ${m.to}`);
}
console.log();

// ── guards ───────────────────────────────────────────────────────────
const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(34)} ${detail}`);
  if (!ok) failures.push(name);
};

const afterCats = catMap();
const changedIds = [...before.cats.entries()].filter(([id, c]) => afterCats.get(id) !== c).map(([id]) => id);
const afterMerchants = merchantMap();
const changedMerchants = [...before.merchants.entries()].filter(([id, c]) => afterMerchants.get(id) !== c);

guard("rows filed", moved === claimed.size, `${moved} of ${claimed.size}`);
guard("merchant defaults remapped", remapped === MERCHANT_PLAN.length, `${remapped} of ${MERCHANT_PLAN.length}`);
// the SUM of every active row, not net worth — no balance or holding is in it
guard("ledger row sum", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("no row re-linked", before.links === links(), "every series and transfer link unchanged");
guard("daily_balances", before.balances === balances(), "untouched");
guard("two categories created", num("SELECT COUNT(*) v FROM categories") === before.categories + 2, `${before.categories} → ${num("SELECT COUNT(*) v FROM categories")}`);
guard(
  "only the planned rows moved",
  changedIds.length === claimed.size && changedIds.every((id) => claimed.has(id)),
  `${changedIds.length} category changes, all expected`,
);
guard(
  "only the planned merchants moved",
  changedMerchants.length === MERCHANT_PLAN.length,
  `${changedMerchants.length} merchant defaults changed`,
);
for (const p of planned) {
  const to = catId(p.to);
  guard(`→ ${p.to}`, p.rows.every((r) => afterCats.get(r.id) === to), `${p.rows.length} rows landed`);
}
guard(
  "spending moves by the rows' own sum",
  kindTotal("expense") === before.expense + expenseDelta,
  `${formatCents(-before.expense)} → ${formatCents(-kindTotal("expense"))}  (${formatCents(-expenseDelta)} arrived from a non-expense kind)`,
);
guard(
  "transfers give up exactly that",
  kindTotal("transfer") === before.transfer - expenseDelta,
  `${formatCents(before.transfer)} → ${formatCents(kindTotal("transfer"))}`,
);
guard("INCOME unchanged", before.income === kindTotal("income"), formatCents(kindTotal("income")));
guard(
  "review queue unchanged",
  before.reviewQueue === num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND needs_review=1"),
  String(before.reviewQueue),
);
guard(
  "Taxes + Government hold $2,761.19",
  num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t JOIN categories c ON c.id=t.category_id
       WHERE t.status='active' AND c.name IN ('Taxes','Government') AND c.parent_id IS NULL`) === -276119,
  formatCents(num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t JOIN categories c ON c.id=t.category_id
       WHERE t.status='active' AND c.name IN ('Taxes','Government') AND c.parent_id IS NULL`)),
);
guard(
  "no government row left in Fees",
  num(`SELECT COUNT(*) v FROM transactions t JOIN categories c ON c.id=t.category_id
       LEFT JOIN categories p ON p.id=c.parent_id
       WHERE t.status='active' AND COALESCE(p.name,c.name)='Fees'
         AND (t.raw_description LIKE '%NYS DTF%' OR t.raw_description LIKE '%NYSTAX%'
              OR t.raw_description LIKE '%IMMIGRATION CANADA%' OR t.raw_description LIKE '%New York State Dmv%')`) === 0,
  "the Fees card is bank charges again",
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
