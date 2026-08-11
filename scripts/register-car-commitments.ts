import path from "node:path";
import { eq } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { categories, recurringSeries } from "@/db/schema";
import { todayIso } from "@/lib/dates";
import { budgetPaceStatuses } from "@/services/budgets";

/**
 * Registers the car lease and its insurance as recurring series, so the `Car`
 * budget can see money it has never been charged.
 *
 * This is the first user of `recurring_series.user_category_id` (migration
 * 0010). Without that column these two rows would be invisible to budgets:
 * `recurringSeriesIdsForCategory` derives a series' category from its POSTED
 * transactions, and neither of these has posted anything — the lease does not
 * charge until 2026-09-11, and the account it charges (Wells Fargo) does not
 * exist yet.
 *
 * Owner's figures, given directly on 2026-08-11 and confirmed when two sessions
 * had been told different numbers:
 *   lease      $559.89  on the 11th, 2026-09-11 .. 2028-08-11 (24 payments)
 *   insurance  $361.49  on the 11th, 6 payments 2026-08-11 .. 2027-01-11
 *              #1 already paid TODAY on Venture X; #2-6 from Wells Fargo
 *
 * `accountId` is left NULL on purpose. Both charge Wells Fargo, which has no
 * account row yet — deliberately, because an account with no statement reads
 * permanently unverified on every coverage surface. Bind them when its first
 * statement lands.
 *
 * ⚠️ Known limitation, NOT fixed here: the schema has no end date for a series
 * (only a `status`), so both will project past their real last payment — the
 * lease past 2028-08-11 and the insurance past 2027-01-11. Inside a monthly
 * budget this is harmless (budgetTail only projects to periodEnd), but a
 * long-range forecast would over-count. Flagged in the handoff.
 *
 *   pnpm tsx scripts/register-car-commitments.ts            # dry run
 *   pnpm tsx scripts/register-car-commitments.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

interface Commitment {
  readonly name: string;
  readonly categoryName: string;
  readonly amountCents: number;
  readonly nextExpectedOn: string;
  /** last payment — a lease is not "monthly forever" (migration 0011) */
  readonly endsOn: string;
  readonly note: string;
}

const COMMITMENTS: readonly Commitment[] = [
  {
    name: "Car lease",
    categoryName: "Car Payment",
    amountCents: -55_989,
    nextExpectedOn: "2026-09-11",
    endsOn: "2028-08-11",
    note: "24 payments, 2026-09-11 .. 2028-08-11, from Wells Fargo",
  },
  {
    name: "Car insurance",
    categoryName: "Car Insurance",
    amountCents: -36_149,
    // #1 was paid today on Venture X; the next one the ledger should EXPECT is
    // September's. Starting the projection at today would forecast a charge he
    // has already made.
    nextExpectedOn: "2026-09-11",
    // #1 was 2026-08-11 on Venture X, so the last of the six is 2027-01-11
    endsOn: "2027-01-11",
    note: "6 payments 2026-08-11 .. 2027-01-11; #1 paid on Venture X, #2-6 Wells Fargo",
  },
];

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const categoryId = (name: string): string => {
    const row = db.select().from(categories).where(eq(categories.name, name)).get();
    if (!row) throw new Error(`No "${name}" category`);
    return row.id;
  };

  const planned = COMMITMENTS.map((c) => {
    const existing = db.select().from(recurringSeries).where(eq(recurringSeries.name, c.name)).get();
    return { ...c, categoryId: categoryId(c.categoryName), existingId: existing?.id ?? null };
  });

  console.log(`db=${DB_PATH}`);
  for (const p of planned) {
    console.log(
      `  ${p.existingId ? "EXISTS (skip)" : "create"}  ${p.name.padEnd(14)} ` +
        `$${(Math.abs(p.amountCents) / 100).toFixed(2)}/mo  next ${p.nextExpectedOn}  -> ${p.categoryName}`,
    );
    console.log(`      ${p.note}`);
  }

  const toCreate = planned.filter((p) => p.existingId === null);
  // rows created before migration 0011 have no end date; back-fill them so a
  // second run is a no-op rather than leaving a lease projecting forever
  const toEnd = planned.filter((p) => p.existingId !== null);
  if (toCreate.length === 0 && toEnd.length === 0) {
    console.log("\nNothing to do.");
    sqlite.close();
    return;
  }
  for (const p of toEnd) console.log(`  set end date ${p.endsOn} on existing "${p.name}"`);

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  withPreMutationSnapshot(db, "register-car-commitments", () => {
    for (const p of toEnd) {
      db.update(recurringSeries)
        .set({ userEndsOn: p.endsOn, userCategoryId: p.categoryId })
        .where(eq(recurringSeries.id, p.existingId!))
        .run();
      console.log(`ended "${p.name}" on ${p.endsOn}`);
    }
    for (const p of toCreate) {
      db.insert(recurringSeries)
        .values({
          name: p.name,
          kind: "bill",
          cadence: "monthly",
          intervalDaysAvg: 30,
          amountCentsAvg: p.amountCents,
          nextExpectedOn: p.nextExpectedOn,
          nextExpectedAmountCents: p.amountCents,
          // the owner stated these amounts; they are not detection's guess
          userAmountCents: p.amountCents,
          userCategoryId: p.categoryId,
          userEndsOn: p.endsOn,
          // he told us directly — this is not a candidate awaiting confirmation
          status: "confirmed",
          confidence: 1,
          accountId: null,
        })
        .run();
      console.log(`created "${p.name}"`);
    }
  });

  // prove the point of the whole migration: the Car budget can now see them
  const car = budgetPaceStatuses(db, todayIso()).find((s) => s.budget.categoryId === categoryId("Car"));
  if (car) {
    console.log(
      `\nCar budget tail now: $${(car.tail.reduce((sum, t) => sum + t.amountCents, 0) / 100).toFixed(2)} ` +
        `across ${car.tail.length} series`,
    );
    for (const t of car.tail) console.log(`  ${t.name}  $${(t.amountCents / 100).toFixed(2)}`);
  }

  sqlite.close();
}

main();
