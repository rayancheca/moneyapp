import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "@/db/client";
import { budgets, categories, recurringSeries } from "@/db/schema";
import { latestBalances } from "@/services/derivation";
import { createBudget } from "@/services/budgets";

/**
 * The two prerequisites the income-budget refactor needs, both owner-instructed
 * on 2026-08-21 ("apply, add the utilities budget, and use 1047").
 *
 * **1. The cash job's rate becomes $1,047.00.** The confirmed series carried
 * `user_amount_cents = 104600` while the June deposit was $1,047.00 and the
 * owner has twice said 1047. One dollar a week is $54.44 a year, but the reason
 * to fix it is not the money — it is that `incomeExpectation`, the forecast and
 * the new budget base would otherwise be built on two different numbers.
 *
 * **2. Utilities gets a budget row.** Breezeline ($50.00) and FPL ($14.21) are
 * confirmed monthly commitments sitting in a category with no budget, so
 * $64.21/month of contractual spend was outside the plan entirely — invisible to
 * "left to allocate" and to every over-allocation warning. It is seeded at the
 * commitment and then RESIZED by `propose-income-budgets`, which is the thing
 * that actually decides the number.
 *
 * ⛔ Neither change moves money. Both are settings a forecast reads, so net
 * worth, every account's latest balance and the transaction count must come out
 * identical; the script asserts that and throws rather than leaving a changed
 * database.
 *
 *   pnpm tsx scripts/prep-income-budgets.ts            # dry run
 *   pnpm tsx scripts/prep-income-budgets.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

const SERIES_NAME = "Cash job (weekly pay)";
const WEEKLY_CENTS = 104_700;
const UTILITIES = "Utilities";
/** seed only — propose-income-budgets sets the real number straight after */
const UTILITIES_SEED_CENTS = 6_421;

const money = (c: number): string =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));
  console.log(`db=${DB_PATH}`);

  const series = db.select().from(recurringSeries).where(eq(recurringSeries.name, SERIES_NAME)).get();
  if (!series) throw new Error(`No series named "${SERIES_NAME}"`);

  const utilities = db.select().from(categories).where(eq(categories.name, UTILITIES)).get();
  if (!utilities) throw new Error(`No "${UTILITIES}" category`);
  const existing = db.select().from(budgets).where(eq(budgets.categoryId, utilities.id)).get();

  console.log(`  1. ${SERIES_NAME}: ${money(series.userAmountCents ?? 0)} -> ${money(WEEKLY_CENTS)} per week`);
  console.log(
    existing
      ? `  2. ${UTILITIES} already has a budget (${money(existing.amountCents)}) — nothing to create`
      : `  2. create a monthly ${UTILITIES} budget seeded at ${money(UTILITIES_SEED_CENTS)}`,
  );

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backup = path.join("data", "backups", `pre-${stamp}-prep-income-budgets.db`);
  await sqlite.backup(path.resolve(process.cwd(), backup));
  console.log(`\nrestore point: ${backup}`);

  const balancesBefore = [...latestBalances(db).entries()]
    .map(([id, b]) => `${id}:${b.balanceCents ?? "null"}`)
    .sort()
    .join("|");
  const txnsBefore = sqlite.prepare("select count(*) n from transactions").get() as { n: number };

  db.update(recurringSeries)
    .set({ userAmountCents: WEEKLY_CENTS })
    .where(eq(recurringSeries.id, series.id))
    .run();
  console.log(`series rate set to ${money(WEEKLY_CENTS)}`);

  if (!existing) {
    const id = createBudget(db, {
      categoryId: utilities.id,
      period: "monthly",
      amountCents: UTILITIES_SEED_CENTS,
    });
    console.log(`${UTILITIES} budget created (${id})`);
  }

  const balancesAfter = [...latestBalances(db).entries()]
    .map(([id, b]) => `${id}:${b.balanceCents ?? "null"}`)
    .sort()
    .join("|");
  const txnsAfter = sqlite.prepare("select count(*) n from transactions").get() as { n: number };

  if (balancesBefore !== balancesAfter) throw new Error("an account's latest balance moved");
  if (txnsBefore.n !== txnsAfter.n) {
    throw new Error(`transaction count moved: ${txnsBefore.n} -> ${txnsAfter.n}`);
  }
  console.log(`\nok — ${txnsAfter.n} transactions and every balance unchanged.`);
  sqlite.close();
}

void main();
