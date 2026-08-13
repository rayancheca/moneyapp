import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories, type CategoryKind } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { normalizeOrder } from "@/lib/reorder";
import { REPLAY_STATUSES } from "./derivation";

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

/**
 * Two characters a category name may not contain. Both are defects in something
 * the app already ships, not style preferences, and both were reproduced before
 * being banned:
 *
 * - **`,`** — the section notes state a COUNT and then list names joined with
 *   ", ". A category named `Food, Drink` renders "2 categories hold no
 *   transactions: Food, Drink, Pets" — says two, lists three. The same
 *   count-then-comma-join shape is in `budgetSectionNotes` and
 *   `categorySectionNotes` alike, so the ambiguity is not local to one note.
 * - **`>`** — the display path is `Parent > Child`, so a ROOT literally named
 *   `Fees > Interest Charges` prints identically to the real child of that path.
 *   The schema's sibling-uniqueness index cannot prevent the collision, because
 *   a root and someone else's child are not siblings.
 *
 * Rejecting at the boundary rather than escaping at each render is deliberate:
 * `createCategory` and `renameCategory` are the ONLY two paths that put a name
 * in the table (the seeded taxonomy is the third, and is swept by a test), so
 * one guard here makes the property true everywhere instead of at each of the
 * places that happen to print a name today.
 */
export const FORBIDDEN_NAME_CHARS = [",", ">"] as const;

function assertNameIsPrintable(name: string): void {
  for (const char of FORBIDDEN_NAME_CHARS) {
    if (name.includes(char)) {
      throw new Error(`Category names cannot contain "${char}" — it is how paths and lists are punctuated`);
    }
  }
}

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

/**
 * Kinds a user may create. `transfer` and `system` are deliberately absent:
 * the transfer detector and credit-match machinery resolve those BY NAME, so a
 * user-made one would either collide with a name detection depends on or sit
 * inert while looking real. Same reasoning that blocks renaming them.
 */
export const CREATABLE_CATEGORY_KINDS = ["expense", "income", "rewards", "investment"] as const;
export type CreatableCategoryKind = (typeof CREATABLE_CATEGORY_KINDS)[number];

export interface CreateCategoryInput {
  name: string;
  /** null = a new top-level category; otherwise the ROOT it lives under */
  parentId?: string | null;
  /** required for a root; ignored for a child, which always inherits its parent's kind */
  kind?: CreatableCategoryKind;
}

export interface CreateCategoryResult {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
}

/**
 * Create a category (the "nothing read-only" program — until now the 73 seeded
 * categories were the only ones that could ever exist: nothing outside
 * `db/seed.ts` inserted a row, so a user with a new kind of spending had
 * nowhere to put it).
 *
 * A child ALWAYS inherits its parent's kind rather than accepting one — kind
 * drives the money math (transfer/investment/rewards never count as spending),
 * and a child whose kind disagreed with its parent's would make a subtree
 * rollup mean two different things at two depths. Depth stays one level, matching
 * moveCategory's guard and the two-level assumption in listBudgetableCategories.
 */
export function createCategory(db: AppDatabase, input: CreateCategoryInput): CreateCategoryResult {
  const name = input.name.trim();
  if (name === "") throw new Error("Category name cannot be empty");
  assertNameIsPrintable(name);
  const parentId = input.parentId ?? null;

  let kind: CategoryKind;
  if (parentId === null) {
    if (!input.kind) throw new Error("Pick what kind of category this is");
    if (!CREATABLE_CATEGORY_KINDS.includes(input.kind)) {
      throw new Error(`Categories of kind "${input.kind}" cannot be created`);
    }
    kind = input.kind;
  } else {
    const parent = db.select().from(categories).where(eq(categories.id, parentId)).get();
    if (!parent) throw new Error("Unknown parent category");
    if (parent.parentId !== null) {
      throw new Error("Categories nest one level deep — pick a top-level parent");
    }
    if (parent.kind === "transfer" || parent.kind === "system") {
      throw new Error("Transfer and system categories cannot take new subcategories — detection depends on them");
    }
    if (parent.isArchived) throw new Error("That parent is archived — unarchive it first");
    kind = parent.kind;
  }

  const siblingClash = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId), eq(categories.name, name)))
    .get();
  if (siblingClash) throw new Error(`A category named "${name}" already exists here`);

  // append to the end of its sibling list rather than colliding on 0, so the
  // seeded ordering the rest of the app renders by is preserved
  const lastSibling = db
    .select({ sortOrder: categories.sortOrder })
    .from(categories)
    .where(parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId))
    .orderBy(desc(categories.sortOrder))
    .get();

  const row = db
    .insert(categories)
    .values({ name, parentId, kind, sortOrder: (lastSibling?.sortOrder ?? 0) + 1 })
    .returning({ id: categories.id })
    .get();
  return { id: row.id, name, parentId, kind };
}

export interface ArchiveCategoryResult {
  id: string;
  isArchived: boolean;
}

/**
 * Archive rather than delete. A category id is referenced by transactions,
 * budgets, rules and merchant defaults, so a hard delete would either violate
 * those foreign keys or orphan real history — and this app's rule is that
 * history is never rewritten to make a screen tidier. Archiving hides the
 * category from every picker (listBudgetableCategories already filters it)
 * while every past transaction keeps pointing at it.
 */
export function archiveCategory(db: AppDatabase, categoryId: string): ArchiveCategoryResult {
  const row = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!row) throw new Error("Unknown category");
  if (row.kind === "transfer" || row.kind === "system") {
    throw new Error("Transfer and system categories stay active — detection depends on them");
  }
  const hintPath = row.parentId
    ? `${db.select({ name: categories.name }).from(categories).where(eq(categories.id, row.parentId)).get()?.name} > ${row.name}`
    : row.name;
  if ((row.parentId === null && IMPORT_HINT_ROOTS.has(row.name)) || IMPORT_HINT_PATHS.has(hintPath)) {
    throw new Error("Imports auto-categorize into this category — it stays active");
  }
  const liveChild = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.parentId, categoryId), eq(categories.isArchived, false)))
    .get();
  if (liveChild) throw new Error("Archive or move its subcategories first");

  db.update(categories).set({ isArchived: true }).where(eq(categories.id, categoryId)).run();
  return { id: categoryId, isArchived: true };
}

/** Restore an archived category. A child cannot come back under an archived parent. */
export function unarchiveCategory(db: AppDatabase, categoryId: string): ArchiveCategoryResult {
  const row = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!row) throw new Error("Unknown category");
  if (row.parentId !== null) {
    const parent = db.select().from(categories).where(eq(categories.id, row.parentId)).get();
    if (parent?.isArchived) throw new Error(`Unarchive "${parent.name}" first`);
  }
  db.update(categories).set({ isArchived: false }).where(eq(categories.id, categoryId)).run();
  return { id: categoryId, isArchived: false };
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
  return destinationsFrom(db.select().from(categories).all(), categoryId);
}

/**
 * Valid destinations for EVERY category, from a single table read.
 *
 * `moveDestinations` scans the whole `categories` table per call, which is fine
 * for the one-category detail page it was written for and quadratic for the
 * manager, which renders ~77 rows. Calling it per row measurably slowed the whole
 * e2e suite (≈2 minutes across the ~8 renders of /categories), so the manager
 * uses this instead.
 */
export function allMoveDestinations(db: AppDatabase): Record<string, MoveDestination[]> {
  const all = db.select().from(categories).all();
  const out: Record<string, MoveDestination[]> = {};
  for (const c of all) out[c.id] = destinationsFrom(all, c.id);
  return out;
}

type CategoryRowShape = { id: string; name: string; parentId: string | null; kind: CategoryKind; isArchived: boolean };

function destinationsFrom(all: readonly CategoryRowShape[], categoryId: string): MoveDestination[] {
  const row = all.find((c) => c.id === categoryId);
  if (!row) return [];
  if (row.kind === "transfer" || row.kind === "system") return [];
  const hintPath = row.parentId
    ? `${all.find((c) => c.id === row.parentId)?.name} > ${row.name}`
    : row.name;
  if ((row.parentId === null && IMPORT_HINT_ROOTS.has(row.name)) || IMPORT_HINT_PATHS.has(hintPath)) return [];
  if (row.parentId === null) {
    // one level deep — a root with children stays a root
    if (all.some((c) => c.parentId === categoryId)) return [];
  }

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
  assertNameIsPrintable(name);

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

/**
 * The order the manager groups roots in: what you spend first, then what comes
 * in, then the plumbing. Exported because `reorderCategories` has to renumber
 * roots in exactly the sequence the screen shows them, and a second copy of this
 * list would silently drift from the one the UI renders.
 */
export const KIND_ORDER: readonly CategoryKind[] = [
  "expense",
  "income",
  "rewards",
  "investment",
  "transfer",
  "system",
];

const SORT_STEP = 10;

/**
 * Persist a manual sibling order, writing `categories.sort_order` — the column
 * five existing readers ALREADY sort by (`listCategoryTree`,
 * `listBudgetableCategories`, the transaction category picker, the command index
 * and the design preview). Writing anything else would have meant a second
 * ordering mechanism that four of those five could not see.
 *
 * `orderedIds` is the sibling group as the SCREEN currently shows it, already
 * moved. It is passed through `normalizeOrder` against the real sibling set, so
 * a stale client list can neither drop a category nor duplicate one — a hidden
 * archived sibling the caller never sent simply sinks to the end of its group.
 *
 * Roots are renumbered GLOBALLY across the whole KIND_ORDER sequence, not within
 * the moved kind. Renumbering one partition would hand `expense` and `income`
 * both a 0, and every reader that sorts by `sort_order` alone (without grouping
 * by kind, which is all of them) would then interleave spending and income roots
 * by name.
 */
export function reorderCategories(db: AppDatabase, orderedIds: readonly string[]): void {
  if (orderedIds.length === 0) return;
  const all = db.select().from(categories).all();
  const byId = new Map(all.map((c) => [c.id, c]));

  const first = byId.get(orderedIds[0]!);
  if (!first) throw new Error(`Unknown category ${orderedIds[0]}`);
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (!row) throw new Error(`Unknown category ${id}`);
    if (row.parentId !== first.parentId) {
      throw new Error("Only siblings can be reordered together");
    }
    if (first.parentId === null && row.kind !== first.kind) {
      throw new Error("Only roots of the same kind can be reordered together");
    }
  }

  const bySort = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

  if (first.parentId !== null) {
    const canonical = all.filter((c) => c.parentId === first.parentId).sort(bySort).map((c) => c.id);
    writeOrder(db, normalizeOrder([...orderedIds], canonical));
    return;
  }

  // roots: splice the moved kind's new order into the full display sequence
  const moved = new Set(orderedIds);
  const sequence: string[] = [];
  for (const kind of KIND_ORDER) {
    const inKind = all.filter((c) => c.parentId === null && c.kind === kind).sort(bySort);
    if (kind === first.kind) {
      sequence.push(...normalizeOrder([...orderedIds], inKind.map((c) => c.id)));
    } else {
      sequence.push(...inKind.filter((c) => !moved.has(c.id)).map((c) => c.id));
    }
  }
  // any kind not named in KIND_ORDER would otherwise be dropped from the renumber
  const seen = new Set(sequence);
  for (const c of all.filter((c) => c.parentId === null && !seen.has(c.id)).sort(bySort)) {
    sequence.push(c.id);
  }
  writeOrder(db, sequence);
}

function writeOrder(db: AppDatabase, ids: readonly string[]): void {
  ids.forEach((id, i) => {
    db.update(categories)
      .set({ sortOrder: i * SORT_STEP })
      .where(eq(categories.id, id))
      .run();
  });
}

export interface CategoryTreeNode {
  id: string;
  name: string;
  kind: CategoryKind;
  isArchived: boolean;
  /** transactions pointing at THIS category (not its subtree) */
  txnCount: number;
  /** false for transfer/system and the import-hint names — the UI hides their controls */
  isEditable: boolean;
  children: CategoryTreeNode[];
}

/** Is this category one the rename/move/archive guards refuse to touch? */
function isProtected(name: string, parentName: string | null, kind: CategoryKind): boolean {
  if (kind === "transfer" || kind === "system") return true;
  if (parentName === null) return IMPORT_HINT_ROOTS.has(name);
  return IMPORT_HINT_PATHS.has(`${parentName} > ${name}`);
}

/**
 * Categories a LIVE recurring series points at through `user_category_id`.
 *
 * Such a category is SCHEDULED, not idle: it can hold zero transactions and
 * still be the home of a confirmed commitment. `Car > Car Insurance` is exactly
 * this — a −$361.49 monthly bill first due 2026-09-11, entered by the owner,
 * with nothing posted against it yet. Anything reasoning about "empty"
 * categories has to subtract these or it calls a live commitment dead.
 *
 * `dismissed` and `ended` series are excluded, as is one merged away: a series
 * the owner rejected or that has finished no longer keeps its category alive.
 * The safe direction here is to over-include — a category wrongly held back is
 * a quieter note, while one wrongly released is bad advice about real money.
 */
export function scheduledCategoryIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ categoryId: recurringSeries.userCategoryId })
    .from(recurringSeries)
    .where(
      and(
        isNotNull(recurringSeries.userCategoryId),
        isNull(recurringSeries.mergedIntoId),
        inArray(recurringSeries.status, ["detected", "confirmed"]),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.categoryId).filter((v): v is string => v !== null));
}

/**
 * How many rows TOUCH each category — the count behind "holds no transactions".
 *
 * Deliberately NOT `listCategoryTree`'s `txnCount`, which counts only active
 * parent rows and therefore misses two ways money reaches a category:
 *
 * - **`excluded` rows still moved money.** `REPLAY_STATUSES` is the single
 *   definition of replayed (`derivation.ts:45`), and it includes `excluded`; a
 *   category whose only rows are excluded is not one nothing ever touched.
 * - **Split parts are attributed by `transaction_splits.category_id`.** A split
 *   stamps its PARENT with only the dominant part
 *   (`transaction-splits.ts:242-250`), so a category that holds only the minor
 *   leg of a split is invisible to a parent-row count — while `/spending` and
 *   `/budgets` both show spend for it (`budgets.ts:815-829`). Two screens
 *   contradicting each other about one category is precisely the defect the
 *   note exists to avoid causing.
 *
 * Both are latent on today's ledger (0 split rows; every excluded row sits in a
 * category with active rows too) and neither is hypothetical: the split editor
 * and the bulk Exclude action both ship.
 */
export function categoryTouchCounts(db: AppDatabase): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string | null) => {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const r of db
    .select({ categoryId: transactions.categoryId })
    .from(transactions)
    .where(inArray(transactions.status, [...REPLAY_STATUSES]))
    .all()) {
    bump(r.categoryId);
  }
  for (const r of db
    .select({ categoryId: transactionSplits.categoryId })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(inArray(transactions.status, [...REPLAY_STATUSES]))
    .all()) {
    bump(r.categoryId);
  }
  return counts;
}

/**
 * The whole taxonomy as roots-with-children, for the category manager. Includes
 * archived rows (the manager is the only place they can be restored from) and a
 * per-category transaction count, so archiving something with real history is a
 * visibly informed choice rather than a blind one.
 */
export function listCategoryTree(db: AppDatabase): CategoryTreeNode[] {
  const rows = db.select().from(categories).all();
  const counts = new Map<string, number>();
  for (const r of db
    .select({ categoryId: transactions.categoryId })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all()) {
    if (r.categoryId) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
  }

  const bySort = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

  const node = (r: (typeof rows)[number], parentName: string | null): CategoryTreeNode => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    isArchived: r.isArchived,
    txnCount: counts.get(r.id) ?? 0,
    isEditable: !isProtected(r.name, parentName, r.kind),
    children: [],
  });

  return rows
    .filter((r) => r.parentId === null)
    .sort(bySort)
    .map((root) => ({
      ...node(root, null),
      children: rows
        .filter((r) => r.parentId === root.id)
        .sort(bySort)
        .map((child) => node(child, root.name)),
    }));
}
