import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

/*
 * ⛔ ONE PRINTER, EVERY SURFACE. "Parent > Child" was printed by sixteen inline copies across twelve modules (the
 * review of §6A 54, 2026-10-08, counted `categoryPathOf` as the seventh). Each surface below is driven through the
 * function its page or action calls, on a seeded temporary database, and the strings it renders are spelled out
 * literally — written and run green against the copies BEFORE they were routed through `formatCategoryPath`, and
 * unchanged after, so the shared printer is held to byte-identical output on every caller.
 *
 * Six of the copies print a KEY rather than a label (the five import-hint guards in `category-edit`, the bank-bucket
 * map in `categorize`): those are held by what the key decides — "Income > Interest" stays locked while its sibling
 * "Income > Salary" does not, a GROCERIES row files under Food > Groceries.
 *
 * Measured on his ledger copy 2026-10-12, before and after: the 80 note rows, 80 picker labels, 80 palette entries,
 * 80 rule-sentence labels, 12 budget paths, the locked rows and move menus, and the suggestion on each of 12,847 rows
 * (1,379 of them name a category) dumped byte-identical.
 */

// NO network: the Claude categorizer's SDK is a stub, so its prompt is read off the call, never sent.
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMessage };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/*
 * The ledger's correction action reads `getDb()`, which reads MONEYAPP_DB_PATH lazily and caches the handle on
 * globalThis — so the path is pointed at a temporary file and any inherited handle dropped before it is imported.
 */
const actionDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-category-path-action-"));
process.env.MONEYAPP_DB_PATH = path.join(actionDir, "t.db");
process.env.MONEYAPP_BACKUPS_DIR = path.join(actionDir, "backups");
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { createDatabase, getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { categories } = await import("@/db/schema/categories");
const { institutions } = await import("@/db/schema/institutions");
const { merchants } = await import("@/db/schema/merchants");
const { recurringSeries } = await import("@/db/schema/recurring");
const { transactions } = await import("@/db/schema/transactions");
const { dedupeHash } = await import("@/lib/hash");
const { normalizeDescription } = await import("@/lib/normalize");
const { categoryNoteRows } = await import("@/lib/section-notes");
const { buildCategoryPickerOptions } = await import("@/components/transactions/category-options");
const { createAccount } = await import("@/services/accounts");
const { budgetStatuses, createBudget } = await import("@/services/budgets");
const { categorizeAll } = await import("@/services/categorize");
const { allMoveDestinations, archiveCategory, listCategoryTree, moveCategory, renameCategory } = await import(
  "@/services/category-edit"
);
const { classifyPendingMerchants } = await import("@/services/claude-categorize");
const { commandEntityGroups } = await import("@/services/command-index");
const { mergeFilings } = await import("@/services/recurring-links");
const { reviewInbox } = await import("@/services/review-inbox");
const { sentenceContext } = await import("@/services/rules-manager");
const { suggestCategory } = await import("@/services/txn-detail");
const { correctCategory } = await import("@/app/transactions/actions");

type Db = ReturnType<typeof createDatabase>["db"];

const TODAY = "2026-10-12";
/** The seeded Food subtree as every list surface orders and prints it. */
const FOOD_PATHS = ["Food", "Food > Groceries", "Food > Dining", "Food > Coffee", "Food > Delivery"];

const opened: { close: () => void; dir: string }[] = [];

/** A seeded temporary database with one checking account, closed and removed after the test. */
function fresh(): { db: Db; accountId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-category-path-"));
  const bundle = createDatabase(path.join(dir, "t.db"));
  opened.push({ close: () => bundle.sqlite.close(), dir });
  seedDatabase(bundle.db);
  return { db: bundle.db, accountId: checkingIn(bundle.db) };
}

function checkingIn(db: Db): string {
  const chase = db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return createAccount(db, { institutionId: chase.id, name: "Checking", type: "checking" });
}

afterEach(() => {
  for (const { close, dir } of opened.splice(0)) {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A seeded category by its root name and, for a child, its own name. */
function catId(db: Db, root: string, child?: string): string {
  const parent = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, root), isNull(categories.parentId)))
    .get()!;
  if (child === undefined) return parent.id;
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.name, child), eq(categories.parentId, parent.id)))
    .get()!.id;
}

let seq = 0;
function insertTxn(
  db: Db,
  accountId: string,
  opts: {
    raw: string;
    amountCents?: number;
    categoryId?: string | null;
    merchantId?: string | null;
    bankCategory?: string | null;
    needsReview?: boolean;
    recurringSeriesId?: string | null;
  },
): string {
  seq += 1;
  const amountCents = opts.amountCents ?? -1_500;
  return db
    .insert(transactions)
    .values({
      accountId,
      postedOn: "2026-10-01",
      amountCents,
      rawDescription: opts.raw,
      normalizedDescription: normalizeDescription(opts.raw),
      categoryId: opts.categoryId ?? null,
      merchantId: opts.merchantId ?? null,
      bankCategory: opts.bankCategory ?? null,
      needsReview: opts.needsReview ?? false,
      recurringSeriesId: opts.recurringSeriesId ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn: "2026-10-01",
        amountCents,
        rawDescription: `${opts.raw}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function insertMerchant(db: Db, name: string, defaultCategoryId: string | null = null): string {
  return db.insert(merchants).values({ canonicalName: name, defaultCategoryId }).returning({ id: merchants.id }).get()
    .id;
}

describe("every surface prints a category path the same way: 'Parent > Child', a top-level bare", () => {
  test("/categories' note rows (`categoryNoteRows`)", () => {
    const { db } = fresh();
    const paths = categoryNoteRows(listCategoryTree(db), new Set(), () => 0).map((r) => r.path);
    expect(paths.filter((p) => p === "Food" || p.startsWith("Food > "))).toEqual(FOOD_PATHS);
    expect(paths).toContain("Shopping");
  });

  test("the category picker's option labels (`buildCategoryPickerOptions`)", () => {
    const { db } = fresh();
    const labels = buildCategoryPickerOptions(db.select().from(categories).all()).map((o) => o.label);
    expect(labels.filter((l) => l === "Food" || l.startsWith("Food > "))).toEqual(FOOD_PATHS);
    expect(labels).toContain("Shopping");
  });

  test("a budget's category path on /budgets (`budgetStatuses`)", () => {
    const { db } = fresh();
    createBudget(db, { categoryId: catId(db, "Food", "Dining"), period: "monthly", amountCents: 30_000 });
    createBudget(db, { categoryId: catId(db, "Shopping"), period: "monthly", amountCents: 20_000 });
    const paths = budgetStatuses(db, TODAY).map((s) => s.categoryPath);
    expect(paths.sort()).toEqual(["Food > Dining", "Shopping"]);
  });

  test("the bank-bucket map files by path: FOOD_AND_DRINK → Food > Dining, HEALTH_AND_WELLNESS → Health", () => {
    const { db, accountId } = fresh();
    const dining = insertTxn(db, accountId, { raw: "PATHPROBE ZQX ONE", bankCategory: "FOOD_AND_DRINK" });
    const groceries = insertTxn(db, accountId, { raw: "PATHPROBE ZQX TWO", bankCategory: "GROCERIES" });
    const health = insertTxn(db, accountId, { raw: "PATHPROBE ZQX THREE", bankCategory: "HEALTH_AND_WELLNESS" });
    categorizeAll(db);
    const filed = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!.categoryId;
    expect(filed(dining)).toBe(catId(db, "Food", "Dining"));
    expect(filed(groceries)).toBe(catId(db, "Food", "Groceries"));
    expect(filed(health)).toBe(catId(db, "Health"));
  });

  test("the import-hint guards lock 'Income > Interest' by its path, not its sibling 'Income > Salary'", () => {
    const { db } = fresh();
    const interest = catId(db, "Income", "Interest");
    const salary = catId(db, "Income", "Salary");
    expect(() => renameCategory(db, interest, "Interest Earned")).toThrow("Imports auto-categorize by this name");
    expect(() => moveCategory(db, interest, null)).toThrow("Imports auto-categorize through this category");
    expect(() => archiveCategory(db, interest)).toThrow("Imports auto-categorize into this category");
    const destinations = allMoveDestinations(db);
    expect(destinations[interest]).toEqual([]);
    expect(destinations[salary]!.length).toBeGreaterThan(0);
    const income = listCategoryTree(db).find((r) => r.name === "Income")!;
    const editable = new Map(income.children.map((c) => [c.name, c.isEditable]));
    expect([editable.get("Interest"), editable.get("Salary")]).toEqual([false, true]);
    expect(renameCategory(db, salary, "Wages")).toEqual({ id: salary, name: "Wages" });
  });

  test("the taxonomy the Claude categorizer offers (`classifyPendingMerchants`' category enum)", async () => {
    const { db, accountId } = fresh();
    insertTxn(db, accountId, { raw: "PATHPROBE ZQX VENDOR" });
    createMessage.mockReset();
    createMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: { merchants: [] } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-credential";
    try {
      await classifyPendingMerchants(db);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    type Enum = { properties: { category: { enum: string[] } } };
    const request = createMessage.mock.calls[0]![0] as {
      tools: { input_schema: { properties: { merchants: { items: Enum } } } }[];
    };
    const offered = request.tools[0]!.input_schema.properties.merchants.items.properties.category.enum;
    expect(offered.filter((p) => p === "Food" || p.startsWith("Food > "))).toEqual([...FOOD_PATHS].sort());
    expect(offered).toContain("Shopping");
    expect(offered).not.toContain("Uncategorized");
  });

  test("a rule's sentence on /rules (`sentenceContext().categoryLabel`)", () => {
    const { db } = fresh();
    const ctx = sentenceContext(db);
    expect(ctx.categoryLabel(catId(db, "Food", "Dining"))).toBe("Food > Dining");
    expect(ctx.categoryLabel(catId(db, "Shopping"))).toBe("Shopping");
    expect(ctx.categoryLabel("no-such-category")).toBe("a category");
  });

  test("the review inbox's cluster and row labels (`reviewInbox`)", () => {
    const { db, accountId } = fresh();
    insertTxn(db, accountId, { raw: "PATHPROBE DINER", categoryId: catId(db, "Food", "Dining"), needsReview: true });
    insertTxn(db, accountId, { raw: "PATHPROBE STORE", categoryId: catId(db, "Shopping"), needsReview: true });
    const clusters = reviewInbox(db, TODAY).clusters;
    const read = (label: string) => {
      const c = clusters.find((x) => x.label === label)!;
      return [c.dominantCategoryLabel, c.sample[0]!.categoryLabel];
    };
    expect(read("PATHPROBE DINER")).toEqual(["Food > Dining", "Food > Dining"]);
    expect(read("PATHPROBE STORE")).toEqual(["Shopping", "Shopping"]);
  });

  test("the transaction sheet's suggestion (`suggestCategory`)", () => {
    const { db, accountId } = fresh();
    const bistro = insertMerchant(db, "Pathprobe Bistro", catId(db, "Food", "Dining"));
    const outlet = insertMerchant(db, "Pathprobe Outlet", catId(db, "Shopping"));
    const a = insertTxn(db, accountId, { raw: "PATHPROBE BISTRO", merchantId: bistro });
    const b = insertTxn(db, accountId, { raw: "PATHPROBE OUTLET", merchantId: outlet });
    expect(suggestCategory(db, a)?.categoryLabel).toBe("Food > Dining");
    expect(suggestCategory(db, b)?.categoryLabel).toBe("Shopping");
  });

  test("the command palette's category entries (`commandEntityGroups`)", () => {
    const { db } = fresh();
    const items = commandEntityGroups(db).find((g) => g.label === "Categories")!.items;
    const label = (id: string) => items.find((i) => i.id === `category-${id}`)!.label;
    expect(label(catId(db, "Food", "Dining"))).toBe("Food > Dining");
    expect(label(catId(db, "Shopping"))).toBe("Shopping");
  });

  test("the merge confirmation's 'will be filed under …' (`mergeFilings`)", () => {
    const { db, accountId } = fresh();
    const series = (name: string, userCategoryId: string | null) =>
      db
        .insert(recurringSeries)
        .values({ name, kind: "bill", cadence: "monthly", status: "confirmed", userCategoryId })
        .returning({ id: recurringSeries.id })
        .get().id;
    const dining = series("Pathprobe dining", catId(db, "Food", "Dining"));
    const shopping = series("Pathprobe shopping", catId(db, "Shopping"));
    const source = series("Pathprobe source", null);
    insertTxn(db, accountId, { raw: "PATHPROBE MERGE", recurringSeriesId: source });
    expect(mergeFilings(db, dining, [source]).get(source)?.categoryPath).toBe("Food > Dining");
    expect(mergeFilings(db, shopping, [source]).get(source)?.categoryPath).toBe("Shopping");
  });
});

describe("the ledger's 'apply to every …' offer after a correction (`correctCategory`)", () => {
  let accountId: string;

  beforeAll(() => {
    const { db } = getDbBundle();
    seedDatabase(db);
    accountId = checkingIn(db);
  });

  afterAll(() => {
    getDbBundle().sqlite.close();
    delete dbCache.__moneyappDb;
    fs.rmSync(actionDir, { recursive: true, force: true });
    delete process.env.MONEYAPP_DB_PATH;
    delete process.env.MONEYAPP_BACKUPS_DIR;
  });

  test("names the category it would file under as 'Food > Dining', a top-level bare", async () => {
    const { db } = getDbBundle();
    const cafe = insertMerchant(db, "Pathprobe Cafe");
    const a = insertTxn(db, accountId, { raw: "PATHPROBE CAFE", merchantId: cafe });
    const b = insertTxn(db, accountId, { raw: "PATHPROBE CAFE", merchantId: cafe });
    const label = async (transactionId: string, categoryId: string) => {
      const result = await correctCategory({ transactionId, categoryId });
      if (!result.ok) throw new Error(result.error);
      return result.data.rulePrompt?.categoryLabel;
    };
    expect(await label(a, catId(db, "Food", "Dining"))).toBe("Food > Dining");
    expect(await label(b, catId(db, "Shopping"))).toBe("Shopping");
  });
});
