/**
 * REAL-DB WRITE, one-off. Relabels three cash deposits from the owner's answers,
 * 2026-08-25.
 *
 * ⚠️ NUMERICALLY INERT, and that is worth saying plainly. Every category
 * involved — Gifts received, Family pass-through, Loans, Internal Transfer —
 * sits under `Transfers`, whose kind is `transfer`, so none of these rows counts
 * toward income or spending either before or after. This corrects what the
 * ledger SAYS about the money, not what it computes from it. The two rows that
 * actually reach his income figure are the $1,047.00 and $400.00 Miami deposits
 * already filed as Income > Salary.
 *
 *   Jul 21  $6,600 + $300  Family pass-through → Gifts received
 *     "mom gave me 7k cash. i put in 6600 then 300 then kept 100 that wasnt
 *     getting accepted." Money given TO him, not routed THROUGH him — which is
 *     what `Family pass-through` means, and why his dad's wires carry it.
 *
 *   May 15  $300           Internal Transfer  → Gifts received
 *     A Bronx ATM in a month he was still living there: "i only moved to miami
 *     last month so before that my dad gave me some money i think". Its four
 *     Bronx siblings this year are already Gifts received; this one was the odd
 *     one out.
 *
 * The $100 he could not deposit is physical cash and stays out of the ledger:
 * Cash on Hand is a float tracked from 2026-08-03 and its earlier history must
 * not be backfilled.
 *
 * NOT CHANGED: the $3,000 across May 12 and May 18, still `Transfers > Loans`.
 * His account of it — "my girl giving me money to send to her but i had to take
 * it back out cause she changed her mind" — is a pass-through, and the only
 * category shaped for that is named `Family pass-through`, which she is not.
 * Widening that name is a decision for him, not a rename to slip into a script.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { formatCents } from "@/lib/money";

const GIFTS_RECEIVED = "019f76f2-e24d-7000-ad49-ba589fc97e8b";

const PLAN = [
  { on: "2026-07-21", cents: 660000, note: "Cash from mum — she gave $7,000; $6,600 and $300 banked, $100 refused by the ATM (owner, 2026-08-25)." },
  { on: "2026-07-21", cents: 30000, note: "Cash from mum — the second half of the $7,000 (owner, 2026-08-25)." },
  { on: "2026-05-15", cents: 30000, note: "Cash from dad, deposited in the Bronx before the Miami move (owner, 2026-08-25)." },
];

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const num = (q: string) => one<{ v: number }>(q).v;
const str = (q: string) => one<{ v: string }>(q).v;
const netCents = () => num("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
const rowCount = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active'");
const cats = () => str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(category_id,'-') x FROM transactions ORDER BY id)");
const links = () => str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(recurring_series_id,'-') x FROM transactions ORDER BY id)");
/** Everything the app treats as income, which must not move by a cent. */
const incomeCents = () =>
  num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
       JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE t.status='active' AND COALESCE(p.kind, c.kind) = 'income'`);

const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-cash-deposits.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

const before = { net: netCents(), rows: rowCount(), cats: cats(), links: links(), income: incomeCents() };

let changed = 0;
db.transaction((tx) => {
  for (const item of PLAN) {
    const hits = tx
      .select({ id: transactions.id, raw: transactions.rawDescription })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, "active"),
          eq(transactions.postedOn, item.on),
          eq(transactions.amountCents, item.cents),
        ),
      )
      .all()
      .filter((r) => /CASH DEPOSIT/i.test(r.raw));
    if (hits.length !== 1) {
      throw new Error(`${item.on} ${formatCents(item.cents)}: expected 1 cash deposit, found ${hits.length}`);
    }
    tx.update(transactions)
      .set({ categoryId: GIFTS_RECEIVED, categorizationSource: "user", needsReview: false, notes: item.note })
      .where(eq(transactions.id, hits[0]!.id))
      .run();
    changed += 1;
    console.log(`  ${item.on}  ${formatCents(item.cents).padStart(10)}  → Transfers > Gifts received`);
  }
});

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(26)} ${detail}`);
  if (!ok) failures.push(name);
};

console.log("");
guard("rows relabelled", changed === PLAN.length, `${changed} of ${PLAN.length}`);
guard("net worth", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("INCOME unchanged", before.income === incomeCents(), formatCents(incomeCents()));
guard("no row re-linked", before.links === links(), "every series link unchanged");
const catChanges = before.cats.split(",").filter((p, i) => p !== cats().split(",")[i]).length;
guard("only these rows moved", catChanges === PLAN.length, `${catChanges} category changes`);

if (failures.length > 0) throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
console.log("\nall guards held.");
