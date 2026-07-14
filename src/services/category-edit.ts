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

export interface MoveCategoryResult {
  id: string;
  parentId: string | null;
}

/**
 * Re-parent a category (S7 "movable"): a subcategory moves to another root or
 * becomes a root itself. History is untouched — every reference is by id; the
 * spending/subtree views simply aggregate under the new parent. Guards:
 * one-level depth (a root with children can't become a child), same-kind
 * destination (kind drives the money math), sibling-name uniqueness, and the
 * same transfer/system + import-hint protections as renaming (a hint path
 * like "Income > Interest" resolves through its PARENT).
 */
export function moveCategory(db: AppDatabase, categoryId: string, newParentId: string | null): MoveCategoryResult {
  const row = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!row) throw new Error("Unknown category");
  if (row.kind === "transfer" || row.kind === "system") {
    throw new Error("Transfer and system categories stay put — detection depends on them");
  }
  const hintPath = row.parentId
    ? `${db.select({ name: categories.name }).from(categories).where(eq(categories.id, row.parentId)).get()?.name} > ${row.name}`
    : row.name;
  if ((row.parentId === null && IMPORT_HINT_ROOTS.has(row.name)) || IMPORT_HINT_PATHS.has(hintPath)) {
    throw new Error("Imports auto-categorize through this category — it stays fixed until import hints match by id");
  }
  if (newParentId === row.parentId) return { id: row.id, parentId: row.parentId };
  if (newParentId === categoryId) throw new Error("A category cannot live under itself");

  if (newParentId !== null) {
    const child = db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, categoryId)).get();
    if (child) throw new Error("This category has subcategories — categories nest one level deep");
    const parent = db.select().from(categories).where(eq(categories.id, newParentId)).get();
    if (!parent) throw new Error("Unknown destination category");
    if (parent.parentId !== null) throw new Error("Categories nest one level deep — pick a top-level destination");
    // same-kind also excludes transfer/system destinations: row.kind was already
    // narrowed away from them above, so a mismatched parent can't smuggle one in
    if (parent.kind !== row.kind) throw new Error("Move within the same kind — the kind drives the money math");
  }

  const siblingClash = db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        newParentId === null ? isNull(categories.parentId) : eq(categories.parentId, newParentId),
        eq(categories.name, row.name),
        ne(categories.id, row.id),
      ),
    )
    .get();
  if (siblingClash) throw new Error(`A category named "${row.name}" already exists there`);

  db.update(categories).set({ parentId: newParentId }).where(eq(categories.id, row.id)).run();
  return { id: row.id, parentId: newParentId };
}

export interface MoveDestination {
  /** null = top level */
  id: string | null;
  label: string;
}

/**
 * The VALID move destinations for a category — same-kind roots (minus self,
 * current parent, and any that already hold a same-named child) plus "Top
 * level" for a subcategory. Empty for anything moveCategory would refuse, so
 * the UI simply hides the menu instead of offering doomed choices.
 */
export function moveDestinations(db: AppDatabase, categoryId: string): MoveDestination[] {
  const row = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!row) return [];
  if (row.kind === "transfer" || row.kind === "system") return [];
  const hintPath = row.parentId
    ? `${db.select({ name: categories.name }).from(categories).where(eq(categories.id, row.parentId)).get()?.name} > ${row.name}`
    : row.name;
  if ((row.parentId === null && IMPORT_HINT_ROOTS.has(row.name)) || IMPORT_HINT_PATHS.has(hintPath)) return [];
  if (row.parentId === null) {
    const child = db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, categoryId)).get();
    if (child) return []; // one level deep — a root with children stays a root
  }

  const all = db.select().from(categories).all();
  const clashesUnder = (parentId: string | null): boolean =>
    all.some((c) => c.parentId === parentId && c.name === row.name && c.id !== row.id);

  const rootTargets = all
    .filter(
      (c) =>
        c.parentId === null &&
        c.kind === row.kind &&
        c.id !== row.id &&
        c.id !== row.parentId &&
        !c.isArchived &&
        !clashesUnder(c.id),
    )
    .map((c) => ({ id: c.id, label: c.name }));

  const topLevel: MoveDestination[] =
    row.parentId !== null && !clashesUnder(null) ? [{ id: null, label: "Top level" }] : [];
  return [...topLevel, ...rootTargets];
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
