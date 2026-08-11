import path from "node:path";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { categories, transactions } from "@/db/schema";
import { createCategory } from "@/services/category-edit";

/**
 * Gives gambling its own category, so a $60 Entertainment budget stops reading
 * as catastrophically overspent because of it.
 *
 * Owner's decision, 2026-08-11: "own category, gross + net".
 *
 * Measured before: 44 rows staked $1,445.10 under `Games`, 7 rows returned
 * $1,053.82 under `Income > Other Income`, and 2 rows ($320.11) sitting as
 * `Internal Transfer`. So the budget graded the GROSS stake against a $60/mo
 * Entertainment limit while the winnings were counted as income somewhere else
 * — a roughly break-even activity reading as ~$1,148 of overspend.
 *
 * Moves BOTH sides. The stakes were moved first; the winnings needed a separate
 * decision, because relocating them is not a categorisation change — it is an
 * INCOME change, dropping the owner's income total by $1,053.82.
 * `docs/income-ground-truth.md` is hand-maintained and passes 15 and 28 both had
 * to un-contaminate it, so it was put to him with the number attached. He said
 * move them (2026-08-11), and the reasoning holds up: those seven credits are
 * winnings returning from a betting platform, not money he earned. Their
 * presence in `Income > Other Income` was itself the contamination.
 *
 * With both sides in one category, analytics nets positives against negatives
 * automatically — so `Gambling` reports NET while its negative rows still sum to
 * GROSS staked. That is the "gross + net" he asked for, with no new machinery.
 *
 * The 2 `Internal Transfer` rows stay: they are transfer-kind, they move money
 * onto the platform rather than spending it, and re-labelling them as spend
 * would double-count against the stakes they fund.
 *
 *   pnpm tsx scripts/split-out-gambling.ts            # dry run
 *   pnpm tsx scripts/split-out-gambling.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

const CATEGORY = "Gambling";
/** the platforms in this ledger — matched on the raw text the banks print */
const PATTERNS = ["%DRAFTKING%", "%KALSHI%", "%FANDUEL%", "%PRIZEPICK%"];

function money(c: number): string {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const games = db.select().from(categories).where(eq(categories.name, "Games")).get();
  if (!games) throw new Error('No "Games" category');

  // the STAKES: money-out rows filed under Games
  const rows = db
    .select({ id: transactions.id, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        eq(transactions.categoryId, games.id),
        or(...PATTERNS.map((p) => like(transactions.rawDescription, p))),
      ),
    )
    .all()
    .filter((r) => r.amountCents < 0);

  const staked = rows.reduce((sum, r) => sum - r.amountCents, 0);

  // the WINNINGS: money-in rows still sitting in Income > Other Income
  const otherIncome = db.select().from(categories).where(eq(categories.name, "Other Income")).get();
  const wins = otherIncome
    ? db
        .select({ id: transactions.id, amountCents: transactions.amountCents })
        .from(transactions)
        .where(
          and(
            eq(transactions.status, "active"),
            eq(transactions.categoryId, otherIncome.id),
            or(...PATTERNS.map((p) => like(transactions.rawDescription, p))),
          ),
        )
        .all()
        .filter((r) => r.amountCents > 0)
    : [];
  const returned = wins.reduce((sum, r) => sum + r.amountCents, 0);

  const existing = db.select().from(categories).where(eq(categories.name, CATEGORY)).get();

  console.log(`db=${DB_PATH}`);
  console.log(`${CATEGORY} category: ${existing ? "exists" : "will be created (top level, expense)"}`);
  console.log(`stakes to move  : ${rows.length} rows, ${money(staked)} out of "Games"`);
  console.log(`winnings to move: ${wins.length} rows, ${money(returned)} out of "Income > Other Income"`);
  // net is measured from the category's FINAL contents, not from this run's
  // deltas — the stakes may already have moved in an earlier run
  const alreadyIn = existing
    ? db
        .select({ amountCents: transactions.amountCents })
        .from(transactions)
        .where(and(eq(transactions.status, "active"), eq(transactions.categoryId, existing.id)))
        .all()
        .reduce((sum, r) => sum - r.amountCents, 0)
    : 0;
  console.log(`  => income falls by ${money(returned)}`);
  console.log(`  => ${CATEGORY} net after this run: ${money(alreadyIn + staked - returned)}`);

  if (rows.length === 0 && wins.length === 0) {
    console.log("\nNothing to move.");
    sqlite.close();
    return;
  }
  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  withPreMutationSnapshot(db, "split-out-gambling", () => {
    const categoryId =
      existing?.id ??
      createCategory(db, { name: CATEGORY, parentId: null, kind: "expense" }).id;
    const ids = [...rows, ...wins].map((r) => r.id);
    if (ids.length > 0) {
      db.update(transactions)
        .set({ categoryId, categorizationSource: "user", categorizationConfidence: 1 })
        .where(inArray(transactions.id, ids))
        .run();
    }
    console.log(`moved ${rows.length} stakes + ${wins.length} winnings into "${CATEGORY}" (${categoryId})`);
  });

  sqlite.close();
}

main();
