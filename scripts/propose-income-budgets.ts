import fs from "node:fs";
import path from "node:path";

/**
 * Re-proposes every budget from INCOME instead of from past spending.
 *
 * The owner, 2026-08-21: *"you have to use my salary as a base… i want to budget
 * based on my income and you know its 1047 a week."*
 *
 * `propose-budgets.ts` stays as it is and still answers a fair question — what
 * does this category usually cost. This answers the different one, and the two
 * are not reconcilable on this ledger: the spend-based rule produced eleven
 * budgets totalling $7,575.00 against $4,537.00 of monthly cash income.
 *
 * Basis, both chosen by the owner with the numbers in front of him:
 *   income  = $1,047/week ANNUALISED — 52 × 1047 ÷ 12 = $4,537.00 a month, not
 *             4 × 1047, which is eleven months of pay a year.
 *   method  = commitments funded exactly and first; whatever income leaves is
 *             split across the rest in proportion to the UNCOMMITTED part of
 *             each category's median trailing spend. Income sets the size,
 *             history sets only the shape.
 *
 * The arithmetic lives in `src/lib/income-budget.ts` under the 100% gate; this
 * script only gathers evidence and prints.
 *
 *   pnpm tsx scripts/propose-income-budgets.ts            # dry run on a copy
 *   pnpm tsx scripts/propose-income-budgets.ts --apply
 */

const APPLY = process.argv.includes("--apply");
const WEEKLY_CENTS = 104_700;
const SRC = "data/moneyapp.db";
const SCRATCH = "/tmp/mp-income-prop";
const DB = APPLY ? SRC : path.join(SCRATCH, "c.db");

if (!APPLY) {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const ext of ["", "-wal", "-shm"]) {
    if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, DB + ext);
  }
}
process.env.MONEYAPP_DB_PATH = DB;

const { createDatabase } = await import("@/db/client");
const { categorySpending, recurringSeriesIdsForCategory } = await import("@/services/analytics");
const { incomeBudgetPlan, monthlyFromWeekly } = await import("@/lib/income-budget");

const { db, sqlite } = createDatabase(DB);
const m = (c: number): string =>
  `${c < 0 ? "-" : ""}$${Math.abs(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The same six trailing full months `propose-budgets` uses, and the same median. */
const MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];

interface BudgetRow {
  id: string;
  amount_cents: number;
  category_id: string;
  name: string;
}

const budgets = sqlite
  .prepare(
    "select b.id, b.amount_cents, b.category_id, c.name from budgets b join categories c on c.id=b.category_id",
  )
  .all() as BudgetRow[];

const categories = budgets.map((b) => {
  const monthly = MONTHS.map((mo) => {
    const start = `${mo}-01`;
    const end = new Date(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)), 0).toISOString().slice(0, 10);
    return Math.abs(categorySpending(db, { categoryId: b.category_id, from: start, to: end }).spentCents);
  }).sort((x, y) => x - y);
  // median of six — robust to the one-off months that are everywhere here
  const trailingCents = Math.round((monthly[2]! + monthly[3]!) / 2);

  /*
   * CONFIRMED monthly commitments in this subtree, exactly as `propose-budgets`
   * measures its floor: `detected` is weaker evidence, and the staleness gate
   * is deliberately NOT applied — what is contractually owed does not depend on
   * whether this month's charge has posted yet.
   */
  const ids = [...recurringSeriesIdsForCategory(db, b.category_id)];
  const committedCents =
    ids.length === 0
      ? 0
      : Math.abs(
          (
            sqlite
              .prepare(
                `select coalesce(sum(coalesce(user_amount_cents, next_expected_amount_cents)), 0) t
                 from recurring_series
                 where status='confirmed' and cadence='monthly'
                   and coalesce(user_amount_cents, next_expected_amount_cents) < 0
                   and id in (${ids.map(() => "?").join(",")})`,
              )
              .get(...ids) as { t: number }
          ).t,
        );

  return { id: b.category_id, name: b.name, committedCents, trailingCents };
});

const incomeBaseCents = monthlyFromWeekly(WEEKLY_CENTS);
const plan = incomeBudgetPlan({ incomeBaseCents, categories });
const currentById = new Map(budgets.map((b) => [b.category_id, b]));
const currentTotal = budgets.reduce((s, b) => s + b.amount_cents, 0);

console.log(`income base   ${m(incomeBaseCents)}  (${m(WEEKLY_CENTS)}/week × 52 ÷ 12)`);
console.log(`committed     ${m(plan.committedCents)}  (${Math.round((plan.committedCents / incomeBaseCents) * 100)}% of income)`);
console.log(`left to split ${m(plan.discretionaryPoolCents)}`);
if (plan.overCommitted) console.log("⛔ commitments alone exceed income — this plan cannot balance");
console.log("");
console.log("category         current   spends   committed   PROPOSED    change      vs spend");
for (const r of plan.rows) {
  const cur = currentById.get(r.id)?.amount_cents ?? 0;
  const d = r.budgetCents - cur;
  console.log(
    `${r.name.padEnd(16)} ${m(cur).padStart(9)} ${m(r.trailingCents).padStart(8)} ` +
      `${m(r.committedCents).padStart(11)} ${m(r.budgetCents).padStart(10)} ` +
      `${(d === 0 ? "=" : m(d)).padStart(11)} ${m(r.deltaVsTrailingCents).padStart(12)}`,
  );
}
console.log("");
console.log(`total          ${m(currentTotal)} → ${m(plan.allocatedCents)}   (income ${m(incomeBaseCents)}, unallocated ${m(plan.unallocatedCents)})`);

if (!APPLY) {
  console.log("\nDRY RUN on a copy — nothing written. Re-run with --apply.");
  sqlite.close();
  process.exit(0);
}

const backup = `data/backups/pre-income-budgets-${Date.now()}.db`;
fs.mkdirSync("data/backups", { recursive: true });
sqlite.prepare("VACUUM INTO ?").run(backup);
console.log(`\nrestore point: ${backup}`);

const update = sqlite.prepare("update budgets set amount_cents=?, updated_at=? where id=?");
const now = new Date().toISOString();
let changed = 0;
for (const r of plan.rows) {
  const b = currentById.get(r.id);
  if (!b || b.amount_cents === r.budgetCents) continue;
  update.run(r.budgetCents, now, b.id);
  changed += 1;
}

const after = (
  sqlite.prepare("select coalesce(sum(amount_cents),0) t from budgets").get() as { t: number }
).t;
if (after !== plan.allocatedCents) {
  throw new Error(`budgets total ${after} does not match the plan's ${plan.allocatedCents}`);
}
console.log(`updated ${changed} budgets; total now ${m(after)}`);
sqlite.close();
