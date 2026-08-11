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
 * ⛔ THIS SCRIPT MOVES THE STAKES ONLY.
 *
 * The winnings are deliberately left where they are, because moving them is not
 * a categorisation change — it is an INCOME change. It would drop the owner's
 * income total by $1,053.82, and `docs/income-ground-truth.md` is a hand-
 * maintained figure that passes 15 and 28 both had to un-contaminate. There is a
 * real argument that gambling winnings were never earned income and their
 * presence there IS the contamination — but that is his call to make with the
 * number in front of him, not one to slip into a categorisation pass.
 *
 * Until he decides, `Gambling` shows GROSS staked. Once the winnings move here
 * too, the same category nets them automatically (analytics nets positives
 * against negatives within a category), which is the "gross + net" he asked for.
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

  // only the STAKES: money-out rows currently filed under Games
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
  const existing = db.select().from(categories).where(eq(categories.name, CATEGORY)).get();

  console.log(`db=${DB_PATH}`);
  console.log(`${CATEGORY} category: ${existing ? "exists" : "will be created (top level, expense)"}`);
  console.log(`stakes to move: ${rows.length} rows, ${money(staked)} out of "Games"`);
  console.log("winnings: NOT moved — that is an income decision (see this script's header)");

  if (rows.length === 0) {
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
    db.update(transactions)
      .set({ categoryId, categorizationSource: "user", categorizationConfidence: 1 })
      .where(
        inArray(
          transactions.id,
          rows.map((r) => r.id),
        ),
      )
      .run();
    console.log(`moved ${rows.length} rows into "${CATEGORY}" (${categoryId})`);
  });

  sqlite.close();
}

main();
