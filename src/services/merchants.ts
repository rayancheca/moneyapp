import { and, desc, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { assertPrintableName } from "@/lib/printable-name";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { loadCategoryIndex } from "./analytics";
import type { BulkResult } from "./bulk-edit";
import { strippedDescriptionKey } from "@/lib/description-key";
import { todayIso } from "@/lib/dates";
import {
  merchantProfile,
  type MerchantProfile,
  type MerchantVisit,
} from "@/lib/merchant-profile";


/**
 * Merchant surfaces for the transaction sheet (ux-overhaul-plan §3.2):
 * the same-merchant panel, the stripped-key fallback for the 47% of rows
 * without a merchant, and rename with alias preservation.
 */

const RECENT_LIMIT = 5;

/**
 * "This row's categorization is not the user's." Every automatic writer must
 * carry it: NULL != 'user' is NULL in SQL, not true, so an unsourced row drops
 * out of a bare `ne(...)` match. Lives here rather than in claude-categorize.ts
 * so importing it never pulls the Anthropic SDK into a page's module graph.
 */
export function notUserOwned(): SQL | undefined {
  return or(
    isNull(transactions.categorizationSource),
    ne(transactions.categorizationSource, "user"),
  );
}

export interface MerchantTxnRow {
  id: string;
  postedOn: string;
  rawDescription: string;
  normalizedDescription: string;
  amountCents: number;
  categoryId: string | null;
}

export interface MerchantSummary {
  id: string;
  name: string;
  txnCount: number;
  /** signed net of this calendar year's active rows — UI formats magnitude */
  totalCentsThisYear: number;
  recent: MerchantTxnRow[];
  /** the merchant→category rule (S6) — future imports categorize to this */
  defaultCategoryId: string | null;
  /** active rows still uncategorized — the backfill button's blast radius */
  uncategorizedCount: number;
}

const TXN_ROW_COLUMNS = {
  id: transactions.id,
  postedOn: transactions.postedOn,
  rawDescription: transactions.rawDescription,
  normalizedDescription: transactions.normalizedDescription,
  amountCents: transactions.amountCents,
  categoryId: transactions.categoryId,
} as const;

export function merchantSummary(
  db: AppDatabase,
  merchantId: string,
  today: string = todayIso(),
): MerchantSummary {
  const merchant = db.select().from(merchants).where(eq(merchants.id, merchantId)).get();
  if (!merchant) throw new Error("Unknown merchant");

  const rows = db
    .select(TXN_ROW_COLUMNS)
    .from(transactions)
    .where(and(eq(transactions.merchantId, merchantId), eq(transactions.status, "active")))
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .all();

  const year = today.slice(0, 4);
  // the system "Uncategorized" category counts as uncategorized — CategoryIndex.uncategorizedIds
  const idx = loadCategoryIndex(db);
  const totalCentsThisYear = rows
    .filter((r) => r.postedOn.slice(0, 4) === year)
    .reduce((sum, r) => sum + r.amountCents, 0);

  return {
    id: merchant.id,
    name: merchant.canonicalName,
    txnCount: rows.length,
    totalCentsThisYear,
    recent: rows.slice(0, RECENT_LIMIT),
    defaultCategoryId: merchant.defaultCategoryId,
    uncategorizedCount: rows.filter((r) => idx.isUncategorized(r.categoryId)).length,
  };
}

/**
 * The merchant→category rule (S6): every future import of this merchant
 * auto-categorizes to the default (categorize.ts merchant-map precedence).
 * Passing null clears the rule. Existing rows are untouched — use
 * applyMerchantDefaultToUncategorized for the explicit backfill.
 */
export function setMerchantDefaultCategory(
  db: AppDatabase,
  merchantId: string,
  categoryId: string | null,
): { id: string; categoryId: string | null } {
  const merchant = db.select().from(merchants).where(eq(merchants.id, merchantId)).get();
  if (!merchant) throw new Error("Unknown merchant");
  if (categoryId !== null) {
    const category = db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).get();
    if (!category) throw new Error("Unknown category");
  }
  db.update(merchants)
    .set({ defaultCategoryId: categoryId, mappingSource: categoryId === null ? null : "user" })
    .where(eq(merchants.id, merchantId))
    .run();
  return { id: merchantId, categoryId };
}

/**
 * Backfill the merchant's UNCATEGORIZED active rows with its default category
 * — never overwrites an existing categorization. Lossless undo.
 *
 * category_id IS NULL already keeps user-categorized rows out; notUserOwned()
 * is the belt to that suspenders — a row the user deliberately left
 * uncategorized (source='user', category NULL) is a decision, not a gap.
 */
export function applyMerchantDefaultToUncategorized(db: AppDatabase, merchantId: string): BulkResult {
  const merchant = db.select().from(merchants).where(eq(merchants.id, merchantId)).get();
  if (!merchant) throw new Error("Unknown merchant");
  if (merchant.defaultCategoryId === null) throw new Error("Set a default category first");
  const rows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.merchantId, merchantId),
        eq(transactions.status, "active"),
        isNull(transactions.categoryId),
        notUserOwned(),
      ),
    )
    .all();
  const undo = {
    rows: rows.map((r) => ({
      id: r.id,
      prev: {
        categoryId: r.categoryId,
        categorizationSource: r.categorizationSource,
        categorizationConfidence: r.categorizationConfidence,
        needsReview: r.needsReview,
      },
    })),
  };
  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(transactions)
        .set({
          categoryId: merchant.defaultCategoryId,
          categorizationSource: "merchant_map",
          categorizationConfidence: 1,
          needsReview: false,
        })
        .where(eq(transactions.id, row.id))
        .run();
    }
  });
  return { affected: rows.length, undo };
}

/**
 * Sibling rows for the sheet's same-merchant panel. Merchantless rows fall
 * back to stripped-key matching (against other merchantless rows only —
 * merchant-linked rows already have a better identity). Investment-account
 * transactions return [] — trades aren't merchants (§3.2.5).
 */
export function similarTransactions(
  db: AppDatabase,
  transactionId: string,
  limit: number,
): MerchantTxnRow[] {
  if (limit <= 0) return [];
  const txn = db
    .select({
      id: transactions.id,
      merchantId: transactions.merchantId,
      normalizedDescription: transactions.normalizedDescription,
      accountType: accounts.type,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.id, transactionId))
    .get();
  if (!txn) throw new Error("Unknown transaction");
  if (txn.accountType === "investment") return [];

  if (txn.merchantId) {
    return db
      .select(TXN_ROW_COLUMNS)
      .from(transactions)
      .where(
        and(
          eq(transactions.merchantId, txn.merchantId),
          eq(transactions.status, "active"),
          ne(transactions.id, txn.id),
        ),
      )
      .orderBy(desc(transactions.postedOn), desc(transactions.id))
      .limit(limit)
      .all();
  }

  const key = strippedDescriptionKey(txn.normalizedDescription);
  if (key === "") return [];
  return db
    .select(TXN_ROW_COLUMNS)
    .from(transactions)
    .where(
      and(
        isNull(transactions.merchantId),
        eq(transactions.status, "active"),
        ne(transactions.id, txn.id),
      ),
    )
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .all()
    .filter((c) => strippedDescriptionKey(c.normalizedDescription) === key)
    .slice(0, limit);
}

/**
 * Every active transaction id in the same "name" group as `transactionId`,
 * INCLUDING the row itself — the server-recomputed blast radius for the sheet's
 * "Recategorize all N" action (never trust client-held ids, ux-overhaul-plan
 * §3.0). Groups by linked merchant when present, else by stripped description
 * key (the merchantless identity). Investment-account rows and rows whose name
 * strips to nothing return [] — there is no honest group to recategorize.
 */
export function similarGroupIds(db: AppDatabase, transactionId: string): string[] {
  const txn = db
    .select({
      id: transactions.id,
      merchantId: transactions.merchantId,
      normalizedDescription: transactions.normalizedDescription,
      accountType: accounts.type,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.id, transactionId))
    .get();
  if (!txn) throw new Error("Unknown transaction");
  if (txn.accountType === "investment") return [];

  if (txn.merchantId) {
    return db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.merchantId, txn.merchantId), eq(transactions.status, "active")))
      .all()
      .map((r) => r.id);
  }

  const key = strippedDescriptionKey(txn.normalizedDescription);
  if (key === "") return [];
  return db
    .select({ id: transactions.id, normalizedDescription: transactions.normalizedDescription })
    .from(transactions)
    .where(and(isNull(transactions.merchantId), eq(transactions.status, "active")))
    .all()
    .filter((r) => strippedDescriptionKey(r.normalizedDescription) === key)
    .map((r) => r.id);
}

export interface RenameMerchantResult {
  id: string;
  name: string;
  /** false when the old-name alias already existed (unique pattern+type) */
  aliasCreated: boolean;
}

/**
 * Rename preserves categorization: the OLD canonical name becomes a
 * 'contains' alias so future imports whose descriptions carry it still
 * resolve to this merchant (alias matching runs on uppercase normalized
 * text — see matchAlias in categorize.ts).
 */
export function renameMerchant(
  db: AppDatabase,
  merchantId: string,
  newName: string,
): RenameMerchantResult {
  const name = newName.trim();
  /*
   * ⛔ The write boundary for a name a PERSON chose. The insight surfaces put a
   * merchant's name straight into a sentence, and `insight-facts` refuses
   * `< > { } \` by throwing — so a name accepted here is a page that will not
   * render later. Rejected at the boundary, the way `category-edit` rejects its
   * own two characters: one guard makes the property true everywhere instead of
   * at each place that happens to print a name. See `lib/printable-name`.
   */
  assertPrintableName("Merchant name", name);

  const merchant = db.select().from(merchants).where(eq(merchants.id, merchantId)).get();
  if (!merchant) throw new Error("Unknown merchant");
  if (name === merchant.canonicalName) {
    return { id: merchant.id, name, aliasCreated: false };
  }

  const clash = db
    .select({ id: merchants.id })
    .from(merchants)
    .where(and(eq(merchants.canonicalName, name), ne(merchants.id, merchantId)))
    .get();
  if (clash) throw new Error(`A merchant named "${name}" already exists`);

  let aliasCreated = false;
  db.transaction((tx) => {
    const inserted = tx
      .insert(merchantAliases)
      .values({
        merchantId: merchant.id,
        pattern: merchant.canonicalName.toUpperCase(),
        matchType: "contains",
        priority: 0,
      })
      .onConflictDoNothing()
      .run();
    aliasCreated = inserted.changes > 0;
    tx.update(merchants).set({ canonicalName: name }).where(eq(merchants.id, merchant.id)).run();
  });

  return { id: merchant.id, name, aliasCreated };
}

/**
 * Everything `/merchants/[id]` needs beyond the row list: what the merchant
 * costs a month, the typical visit, the category mix, and the year-over-year.
 *
 * The arithmetic — and every refusal in it — lives in `lib/merchant-profile` at
 * 100%. This function is the query and the join, nothing more.
 *
 * Only EXPENSE-kind rows feed the profile. A refund at a merchant nets against
 * its purchases (the rule `spendingBucket` already applies everywhere else), and
 * a transfer or an investment row at a merchant is not spending at all — letting
 * either in would make "you spend $X a month here" a different question from the
 * one /spending answers about the same merchant.
 */
export interface MerchantIntelligence {
  profile: MerchantProfile;
  /** the recurring series this merchant bills through, when it has one */
  cadence: { seriesId: string; name: string; cadence: string; status: string } | null;
}

export function merchantIntelligence(
  db: AppDatabase,
  merchantId: string,
  today: string = todayIso(),
): MerchantIntelligence {
  /*
   * The top-level category decides both the KIND and the label, and
   * `loadCategoryIndex` is the one place that rollup is implemented — the same
   * index `spendingBucket` reads. Resolving it here in TS rather than with a
   * self-join keeps one answer to "what kind is this row?" and avoids an
   * aliased-table join that drizzle cannot infer a row type for.
   */
  const idx = loadCategoryIndex(db);
  const rows = db
    .select({
      day: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(and(eq(transactions.merchantId, merchantId), eq(transactions.status, "active")))
    .all();

  const visits: MerchantVisit[] = rows
    // money OUT only. A refund is a credit at the same merchant; counting it as
    // a visit would report a day that cost nothing as a day that cost something.
    .filter((r) => r.amountCents < 0 && r.categoryId !== null)
    .map((r) => ({ row: r, top: idx.topLevelOf(r.categoryId!) }))
    .filter(({ top }) => top.kind === "expense")
    .map(({ row, top }) => ({
      day: row.day,
      amountCents: -row.amountCents,
      categoryName: top.name,
    }));

  /*
   * The RETURNS: the same filter with the sign flipped. Not visits — a day that
   * cost nothing is not a day that cost something, and the Purchases tile and
   * the typical visit still count only what was handed over. They net the
   * Total, the rate, the years and the rank, which say what the merchant COST.
   */
  const refunds: MerchantVisit[] = rows
    .filter((r) => r.amountCents > 0 && r.categoryId !== null)
    .map((r) => ({ row: r, top: idx.topLevelOf(r.categoryId!) }))
    .filter(({ top }) => top.kind === "expense")
    .map(({ row, top }) => ({
      day: row.day,
      amountCents: row.amountCents,
      categoryName: top.name,
    }));

  const series = db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      cadence: recurringSeries.cadence,
      userCadence: recurringSeries.userCadence,
      status: recurringSeries.status,
    })
    .from(recurringSeries)
    .where(
      and(
        eq(recurringSeries.merchantId, merchantId),
        inArray(recurringSeries.status, ["detected", "confirmed"]),
      ),
    )
    .get();

  return {
    // `rows.length` is what the page's heading counts; `visits` is what this
    // card measures, and the profile names the difference rather than leaving a
    // reader to reconcile "140 transactions" with "2 purchases".
    profile: merchantProfile(visits, refunds, today, rows.length),
    cadence: series
      ? {
          seriesId: series.id,
          name: series.name,
          cadence: series.userCadence ?? series.cadence,
          status: series.status,
        }
      : null,
  };
}
