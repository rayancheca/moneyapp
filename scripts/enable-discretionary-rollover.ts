import path from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "@/db/client";
import { budgets, categories } from "@/db/schema";
import { carryInto, setBudgetRollover } from "@/services/budgets";
import { latestBalances } from "@/services/derivation";

/**
 * Turns rollover on for the DISCRETIONARY budgets, owner-instructed 2026-08-21.
 *
 * ⚠️ It does NOT quiet the over-allocation warning, and the note that suggested
 * it implied otherwise. `/budgets` compares `totalBudgetedCents` against
 * `incomeExpectation`; `carryInto` touches neither. What rollover actually buys
 * is that an underspent month funds the next one, which matters for categories
 * whose spending is lumpy — and after cutting Food from $2,065.00 to $560.00,
 * lumpy is exactly what they will be.
 *
 * WHICH BUDGETS, and why the other three are excluded:
 *
 *   - **Housing and Car are fully committed.** Their amounts ARE their
 *     contracts — Car's $921.38 is lease $559.89 + insurance $361.49 exactly —
 *     so planned surplus is $0.00 every month and a carry could only ever be
 *     zero. `carryInto`'s own docstring makes this point about the Car.
 *   - **Utilities is mostly committed and already under-funded**: $74.21 against
 *     $115.38 of typical usage, so it will overrun rather than bank.
 *
 * WHY `rolloverStartsOn` IS SET rather than left null. The amounts changed today
 * and `carryInto` has no notion of amount history — it applies the CURRENT
 * amount to every closed period it walks. Left unbounded it would grade July and
 * August, months lived under a $7,639.21 plan, against the $4,506.29 one that
 * replaced them. Measured today every such carry is $0.00 (the new amounts sit
 * below actual spend, and the balance floors at zero), so this changes no number
 * now — it is there so a back-dated import into a closed period cannot turn one
 * into a surplus later. September is the first month fully lived under this
 * plan, so the first carry lands in October.
 *
 *   pnpm tsx scripts/enable-discretionary-rollover.ts            # dry run
 *   pnpm tsx scripts/enable-discretionary-rollover.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

/** No contractual commitment sits inside these, so a surplus is possible. */
const DISCRETIONARY = [
  "Food",
  "Shopping",
  "Cash & ATM",
  "Transport",
  "Travel",
  "Health",
  "Subscriptions",
  "Entertainment",
  "Fees",
];

/** First month lived entirely under the income-based plan. */
const ROLLOVER_STARTS_ON = "2026-09-01";
const CURRENT_PERIOD_START = "2026-08-01";

const money = (c: number): string =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));
  console.log(`db=${DB_PATH}`);

  const rows = db
    .select({
      id: budgets.id,
      name: categories.name,
      categoryId: budgets.categoryId,
      amountCents: budgets.amountCents,
      period: budgets.period,
      startsOn: budgets.startsOn,
      rolloverEnabled: budgets.rolloverEnabled,
      rolloverStartsOn: budgets.rolloverStartsOn,
      rolloverCapCents: budgets.rolloverCapCents,
    })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .all();

  const missing = DISCRETIONARY.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) throw new Error(`No budget for: ${missing.join(", ")}`);

  const targets = rows.filter((r) => DISCRETIONARY.includes(r.name));
  console.log(`\n${targets.length} discretionary budgets; ${rows.length - targets.length} left alone:`);
  for (const r of rows) {
    const inSet = DISCRETIONARY.includes(r.name);
    console.log(
      `  ${r.name.padEnd(15)} ${money(r.amountCents).padStart(10)}  ` +
        `${r.rolloverEnabled ? "ON " : "off"} -> ${inSet ? "ON " : "off"}  ` +
        `${inSet ? `from ${ROLLOVER_STARTS_ON}` : "(committed — a carry could only be zero)"}`,
    );
  }

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backup = path.join("data", "backups", `pre-${stamp}-discretionary-rollover.db`);
  await sqlite.backup(path.resolve(process.cwd(), backup));
  console.log(`\nrestore point: ${backup}`);

  const balancesBefore = [...latestBalances(db).entries()]
    .map(([id, b]) => `${id}:${b.balanceCents ?? "null"}`)
    .sort()
    .join("|");
  const budgetedBefore = rows.reduce((s, r) => s + r.amountCents, 0);

  for (const r of targets) {
    setBudgetRollover(db, r.id, { enabled: true, startsOn: ROLLOVER_STARTS_ON });
  }

  const after = db
    .select({
      id: budgets.id,
      name: categories.name,
      categoryId: budgets.categoryId,
      amountCents: budgets.amountCents,
      period: budgets.period,
      startsOn: budgets.startsOn,
      rolloverEnabled: budgets.rolloverEnabled,
      rolloverStartsOn: budgets.rolloverStartsOn,
      rolloverCapCents: budgets.rolloverCapCents,
    })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .all();

  const balancesAfter = [...latestBalances(db).entries()]
    .map(([id, b]) => `${id}:${b.balanceCents ?? "null"}`)
    .sort()
    .join("|");
  const budgetedAfter = after.reduce((s, r) => s + r.amountCents, 0);

  /*
   * The property that matters: turning rollover ON must not move a single
   * budget's amount, and must not bank a carry into the period being graded
   * right now. Both are asserted rather than assumed.
   */
  if (balancesBefore !== balancesAfter) throw new Error("an account's latest balance moved");
  if (budgetedBefore !== budgetedAfter) {
    throw new Error(`budgeted total moved: ${budgetedBefore} -> ${budgetedAfter}`);
  }
  const carried = after
    .filter((r) => r.rolloverEnabled)
    .map((r) => ({ name: r.name, cents: carryInto(db, r, CURRENT_PERIOD_START) }))
    .filter((c) => c.cents !== 0);
  if (carried.length > 0) {
    throw new Error(
      `a carry appeared in the open period: ${carried.map((c) => `${c.name} ${money(c.cents)}`).join(", ")}`,
    );
  }

  const on = after.filter((r) => r.rolloverEnabled).length;
  console.log(`\nok — rollover on for ${on} of ${after.length} budgets, total still ${money(budgetedAfter)},`);
  console.log(`     every balance unchanged, and no carry banked into the open period.`);
  sqlite.close();
}

void main();
