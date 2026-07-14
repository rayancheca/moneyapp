import { and, eq, isNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";

/**
 * Category writes (the "nothing read-only" program, S3). Renaming is a pure
 * display-label change — every reference (transactions, budgets, rules,
 * merchant defaults) points at the category id, so history is untouched.
 *
 * Two guarded exceptions:
 * - transfer/system-kind categories keep their names: the transfer detector
 *   and credit-match machinery resolve them BY NAME ("Transfers > Credit Card
 *   Payment"), so a rename would silently break transfer categorization.
 * - names stay unique among siblings (the schema's partial unique indexes) —
 *   caught here with a readable message instead of a raw constraint error.
 *
 * Import parsers hint category paths BY NAME (e.g. "Income > Interest" from
 * the SoFi/Robinhood profiles) — renaming one of those would silently break
 * auto-categorization on every future import, so the exact hinted names are
 * blocked too (interim: the durable fix is id/key-based hints — see
 * docs/future-ideas.md). Everything else renames freely.
 */

/** Names the import profiles resolve by (parent, and "parent > sub"). */
const IMPORT_HINT_ROOTS = new Set(["Income", "Cash & ATM", "Fees", "Investments"]);
const IMPORT_HINT_PATHS = new Set([
  "Income > Interest",
  "Income > Dividends",
  "Income > Other Income",
  "Cash & ATM > ATM Withdrawals",
  "Fees > Bank Fees",
  "Investments > Buys",
  "Investments > Sells",
]);

export interface RenameCategoryResult {
  id: string;
  name: string;
}

export function renameCategory(db: AppDatabase, categoryId: string, newName: string): RenameCategoryResult {
  const name = newName.trim();
  if (name === "") throw new Error("Category name cannot be empty");

  const row = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!row) throw new Error("Unknown category");
  if (row.kind === "transfer" || row.kind === "system") {
    throw new Error("Transfer and system categories keep their names — transfer detection matches on them");
  }
  const hintPath = row.parentId
    ? `${db.select({ name: categories.name }).from(categories).where(eq(categories.id, row.parentId)).get()?.name} > ${row.name}`
    : row.name;
  if ((row.parentId === null && IMPORT_HINT_ROOTS.has(row.name)) || IMPORT_HINT_PATHS.has(hintPath)) {
    throw new Error("Imports auto-categorize by this name — it stays fixed until import hints match by id");
  }
  if (name === row.name) return { id: row.id, name };

  const siblingClash = db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        row.parentId === null ? isNull(categories.parentId) : eq(categories.parentId, row.parentId),
        eq(categories.name, name),
        ne(categories.id, row.id),
      ),
    )
    .get();
  if (siblingClash) throw new Error(`A category named "${name}" already exists here`);

  db.update(categories).set({ name }).where(eq(categories.id, row.id)).run();
  return { id: row.id, name };
}
