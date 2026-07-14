import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { rules, ruleActionsSchema, ruleConditionsSchema, type RuleConditions } from "@/db/schema/rules";
import { appSettings } from "@/db/schema/settings";
import { transactions } from "@/db/schema/transactions";
import { diffDays } from "@/lib/dates";
import { strippedDescriptionKey } from "@/lib/description-key";

/**
 * The categorization pipeline (master-plan §3). Precedence:
 * explicit user set > rules > merchant map > Claude. Claude fallback lives
 * in claude-categorize.ts; everything here is deterministic and free.
 */

const CREDIT_MATCH_WINDOW_DAYS = 30;

export interface CategorizeStats {
  processed: number;
  byRule: number;
  byMerchantMap: number;
  byBankCategory: number;
  byCreditMatch: number;
  uncategorized: number;
}

interface TxnRow {
  id: string;
  accountId: string;
  postedOn: string;
  amountCents: number;
  normalizedDescription: string;
  merchantId: string | null;
  categoryId: string | null;
  categorizationSource: string | null;
  bankCategory?: string | null;
}

/**
 * Bank-supplied category buckets → taxonomy paths (Chase spending-report
 * and card-CSV slugs). Deliberately conservative: ambiguous buckets
 * (PROFESSIONAL_SERVICES, MISCELLANEOUS) stay unmapped and fall through
 * to Claude. Runs AFTER the merchant map, so a known merchant's precise
 * subcategory always beats the bank's coarse bucket.
 */
const BANK_CATEGORY_MAP: Record<string, string> = {
  AUTOMOTIVE: "Transport",
  BILLS_AND_UTILITIES: "Utilities",
  ENTERTAINMENT: "Entertainment",
  FEES_AND_ADJUSTMENTS: "Fees",
  FOOD_AND_DRINK: "Food > Dining",
  GAS: "Transport > Gas",
  GROCERIES: "Food > Groceries",
  HEALTH_AND_WELLNESS: "Health",
  HOME: "Housing",
  PERSONAL: "Personal Care",
  SHOPPING: "Shopping",
  TRAVEL: "Travel",
  EDUCATION: "Education",
  GIFTS_AND_DONATIONS: "Gifts & Donations",
};

/** Resolve "Parent > Sub" (or bare parent) taxonomy paths to category ids. */
function bankCategoryIds(db: AppDatabase): Map<string, string> {
  const rows = db.select().from(categories).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byPath = new Map<string, string>();
  for (const r of rows) {
    const path = r.parentId ? `${byId.get(r.parentId)?.name} > ${r.name}` : r.name;
    byPath.set(path, r.id);
  }
  const out = new Map<string, string>();
  for (const [bucket, path] of Object.entries(BANK_CATEGORY_MAP)) {
    const id = byPath.get(path);
    if (id) out.set(bucket, id);
  }
  return out;
}

/** Enabled rules in precedence (priority asc), with parsed conditions/actions. */
export function loadRules(db: AppDatabase) {
  return db
    .select()
    .from(rules)
    .where(eq(rules.isEnabled, true))
    .orderBy(asc(rules.priority))
    .all()
    .map((r) => ({
      ...r,
      cond: ruleConditionsSchema.parse(JSON.parse(r.conditions)),
      act: ruleActionsSchema.parse(JSON.parse(r.actions)),
    }));
}

export function ruleMatches(cond: RuleConditions, txn: Pick<TxnRow, "accountId" | "amountCents" | "normalizedDescription">): boolean {
  if (cond.descriptionContains && !txn.normalizedDescription.includes(cond.descriptionContains.toUpperCase())) return false;
  if (cond.descriptionRegex && !new RegExp(cond.descriptionRegex, "i").test(txn.normalizedDescription)) return false;
  // Name-key equality: the merchantless "apply to this exact name" identity.
  // An empty stripped key would match every other empty-key row, so a rule can
  // never carry one (ruleConditionsSchema requires min(1)); guard anyway.
  if (cond.descriptionKey && strippedDescriptionKey(txn.normalizedDescription) !== cond.descriptionKey) return false;
  if (cond.accountIds && !cond.accountIds.includes(txn.accountId)) return false;
  if (cond.direction === "in" && txn.amountCents <= 0) return false;
  if (cond.direction === "out" && txn.amountCents >= 0) return false;
  if (cond.amountMinCents !== undefined && Math.abs(txn.amountCents) < cond.amountMinCents) return false;
  if (cond.amountMaxCents !== undefined && Math.abs(txn.amountCents) > cond.amountMaxCents) return false;
  return true;
}

interface AliasRow {
  pattern: string;
  matchType: "exact" | "prefix" | "contains";
  priority: number;
  merchantId: string;
}

export function matchAlias(aliases: readonly AliasRow[], normalized: string): string | null {
  const ranked = [...aliases].sort((a, b) => {
    const typeRank = { exact: 0, prefix: 1, contains: 2 };
    return typeRank[a.matchType] - typeRank[b.matchType] || b.priority - a.priority;
  });
  for (const a of ranked) {
    if (a.matchType === "exact" && normalized === a.pattern) return a.merchantId;
    if (a.matchType === "prefix" && normalized.startsWith(a.pattern)) return a.merchantId;
    if (a.matchType === "contains" && normalized.includes(a.pattern)) return a.merchantId;
  }
  return null;
}

function settingNumber(db: AppDatabase, key: string, fallback: number): number {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row) return fallback;
  const parsed: unknown = JSON.parse(row.value);
  return typeof parsed === "number" ? parsed : fallback;
}

/** Runs the deterministic pipeline over every active, user-untouched, uncategorized txn. */
export function categorizeAll(db: AppDatabase): CategorizeStats {
  const stats: CategorizeStats = { processed: 0, byRule: 0, byMerchantMap: 0, byBankCategory: 0, byCreditMatch: 0, uncategorized: 0 };
  const activeRules = loadRules(db);
  const bankCatIds = bankCategoryIds(db);
  const aliases = db.select().from(merchantAliases).all();
  const merchantDefaults = new Map(
    db.select().from(merchants).all().map((m) => [m.id, m.defaultCategoryId]),
  );
  const reviewCreditThreshold = settingNumber(db, "reviewCreditThresholdCents", 20_000);
  const depositAccountIds = new Set(
    db.select({ id: accounts.id }).from(accounts).all()
      .filter((a) => false) // populated below with type info
      .map((a) => a.id),
  );
  for (const a of db.select().from(accounts).all()) {
    if (a.type === "checking" || a.type === "savings") depositAccountIds.add(a.id);
  }

  const pending = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      bankCategory: transactions.bankCategory,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.categoryId),
        // NULL != 'user' is NULL in SQL, not true — must be explicit
        or(isNull(transactions.categorizationSource), ne(transactions.categorizationSource, "user")),
      ),
    )
    .all() as TxnRow[];

  db.transaction((tx) => {
    for (const txn of pending) {
      stats.processed += 1;

      const rule = activeRules.find((r) => ruleMatches(r.cond, txn));
      if (rule) {
        tx.update(transactions)
          .set({
            categoryId: rule.act.categoryId ?? txn.categoryId,
            merchantId: rule.act.merchantId ?? txn.merchantId,
            categorizationSource: "rule",
            categorizationConfidence: 1,
            needsReview: false,
            ...(rule.act.exclude ? { status: "excluded" as const } : {}),
          })
          .where(eq(transactions.id, txn.id))
          .run();
        tx.update(rules).set({ timesApplied: rule.timesApplied + 1 }).where(eq(rules.id, rule.id)).run();
        stats.byRule += 1;
        continue;
      }

      const merchantId = txn.merchantId ?? matchAlias(aliases, txn.normalizedDescription);
      const defaultCategory = merchantId ? merchantDefaults.get(merchantId) : null;
      if (merchantId && defaultCategory) {
        tx.update(transactions)
          .set({
            merchantId,
            categoryId: defaultCategory,
            categorizationSource: "merchant_map",
            categorizationConfidence: 1,
            needsReview: false,
          })
          .where(eq(transactions.id, txn.id))
          .run();
        stats.byMerchantMap += 1;
        continue;
      }
      if (merchantId) {
        tx.update(transactions).set({ merchantId }).where(eq(transactions.id, txn.id)).run();
      }

      // bank-supplied bucket (Chase spending report / card CSV) — coarser
      // than the merchant map but far better than uncategorized
      const bankCategoryId = txn.bankCategory ? bankCatIds.get(txn.bankCategory) : undefined;
      if (bankCategoryId) {
        tx.update(transactions)
          .set({
            categoryId: bankCategoryId,
            categorizationSource: "bank_category",
            categorizationConfidence: 0.75,
            needsReview: false,
          })
          .where(eq(transactions.id, txn.id))
          .run();
        stats.byBankCategory += 1;
        continue;
      }

      if (txn.amountCents > 0) {
        const inherited = findCreditMatch(tx as unknown as AppDatabase, txn, merchantId);
        if (inherited) {
          tx.update(transactions)
            .set({
              categoryId: inherited,
              categorizationSource: "credit_match",
              categorizationConfidence: 0.9,
              needsReview: false,
            })
            .where(eq(transactions.id, txn.id))
            .run();
          stats.byCreditMatch += 1;
          continue;
        }
      }

      // still unknown — big inbound deposits are force-flagged for review
      // (master-plan §2); other uncategorized rows surface via coverage
      const bigCredit =
        txn.amountCents >= reviewCreditThreshold && depositAccountIds.has(txn.accountId);
      if (bigCredit) {
        tx.update(transactions).set({ needsReview: true }).where(eq(transactions.id, txn.id)).run();
      }
      stats.uncategorized += 1;
    }
  });

  return stats;
}

/** Credit matching (pipeline step 6): inherit the original purchase's category. */
function findCreditMatch(db: AppDatabase, credit: TxnRow, merchantId: string | null): string | null {
  const candidates = db
    .select({
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      merchantId: transactions.merchantId,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, credit.accountId),
        eq(transactions.status, "active"),
      ),
    )
    .all();

  for (const c of candidates) {
    if (c.amountCents >= 0 || !c.categoryId) continue;
    const age = diffDays(c.postedOn, credit.postedOn);
    if (age < 0 || age > CREDIT_MATCH_WINDOW_DAYS) continue;
    if (Math.abs(credit.amountCents) > Math.abs(c.amountCents)) continue;
    const sameMerchant = merchantId !== null && c.merchantId === merchantId;
    const similarDesc =
      c.normalizedDescription !== "" &&
      (credit.normalizedDescription.includes(c.normalizedDescription) ||
        c.normalizedDescription.includes(credit.normalizedDescription));
    if (sameMerchant || similarDesc) return c.categoryId;
  }
  return null;
}

const TRANSFER_HINT_RE =
  /PAYMENT THANK YOU|AUTOPAY|ONLINE PYMT|DIRECTPAY|ONLINE TRANSFER|TRANSFER TO|TRANSFER FROM|BANK TRANSFER|ROBINHOOD|CRD EPAY|CARDMEMBER SERV/i;

export interface TransferStats {
  paired: number;
  flaggedAmbiguous: number;
}

function categoryIdByPath(db: AppDatabase, path: string): string {
  const [parentName, subName] = path.split(" > ");
  const parent = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`Missing category ${parentName}`);
  if (!subName) return parent.id;
  const sub = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  if (!sub) throw new Error(`Missing category ${path}`);
  return sub.id;
}

/**
 * Transfer pairing: opposite equal-cent amounts across two accounts within
 * ±4 days. Auto-pairs ONLY with a descriptor hint on either leg — coincidental
 * equal amounts go to review instead (Phase 3 acceptance criterion).
 */
export function detectTransfers(db: AppDatabase): TransferStats {
  const stats: TransferStats = { paired: 0, flaggedAmbiguous: 0 };
  const accountRows = db.select().from(accounts).all();
  const accountTypes = new Map(accountRows.map((a) => [a.id, a.type]));

  // S6: a user-declared card↔funding-account link counts as a hint — payments
  // between the linked pair auto-pair even without a descriptor match
  const linkedPairs = new Set<string>();
  for (const a of accountRows) {
    if (a.paymentSourceAccountId) {
      linkedPairs.add(`${a.id}\x1f${a.paymentSourceAccountId}`);
      linkedPairs.add(`${a.paymentSourceAccountId}\x1f${a.id}`);
    }
  }
  const isLinkedPair = (x: string, y: string): boolean => linkedPairs.has(`${x}\x1f${y}`);

  const candidates = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.status, "active"), isNull(transactions.transferGroupId)))
    .orderBy(asc(transactions.postedOn))
    .all();

  const cardPaymentCat = categoryIdByPath(db, "Transfers > Credit Card Payment");
  const internalCat = categoryIdByPath(db, "Transfers > Internal Transfer");
  const investmentCat = categoryIdByPath(db, "Transfers > Investment Contribution");

  const used = new Set<string>();
  db.transaction((tx) => {
    for (const a of candidates) {
      if (used.has(a.id) || a.amountCents >= 0) continue;
      const matches = candidates.filter(
        (b) =>
          !used.has(b.id) &&
          b.id !== a.id &&
          b.accountId !== a.accountId &&
          b.amountCents === -a.amountCents &&
          Math.abs(diffDays(a.postedOn, b.postedOn)) <= 4,
      );
      if (matches.length === 0) continue;

      const hinted = matches.filter(
        (b) =>
          TRANSFER_HINT_RE.test(a.rawDescription) ||
          TRANSFER_HINT_RE.test(b.rawDescription) ||
          isLinkedPair(a.accountId, b.accountId),
      );
      if (hinted.length !== 1) {
        if (matches.length > 0) {
          // coincidental or ambiguous equal amounts — humans decide; flag
          // every leg of the ambiguity, not just the outflow
          tx.update(transactions)
            .set({ needsReview: true })
            .where(inArray(transactions.id, [a.id, ...matches.map((m) => m.id)]))
            .run();
          stats.flaggedAmbiguous += 1;
        }
        continue;
      }

      const b = hinted[0]!;
      const groupId = a.id; // deterministic group key: the outflow leg's id
      const types = [accountTypes.get(a.accountId), accountTypes.get(b.accountId)];
      const category = types.includes("credit")
        ? cardPaymentCat
        : types.includes("investment")
          ? investmentCat
          : internalCat;

      for (const leg of [a, b]) {
        tx.update(transactions)
          .set({
            transferGroupId: groupId,
            categoryId: category,
            categorizationSource: "transfer_detect",
            categorizationConfidence: 0.95,
            needsReview: false,
          })
          .where(eq(transactions.id, leg.id))
          .run();
      }
      used.add(a.id);
      used.add(b.id);
      stats.paired += 1;
    }
  });
  return stats;
}

export interface CorrectionInput {
  transactionId: string;
  categoryId: string;
  /** update the merchant's default mapping (subject to the direction guard) */
  applyToMerchant?: boolean;
  /** user explicitly confirmed a sign-opposing mapping change */
  confirmDirectionOverride?: boolean;
  /** recategorize this merchant's non-user history */
  retroactive?: boolean;
}

export interface CorrectionResult {
  merchantUpdated: boolean;
  directionGuardTriggered: boolean;
  retroactivelyUpdated: number;
}

/** User corrections: permanent on the txn; merchant map behind the direction guard. */
export function applyCorrection(db: AppDatabase, input: CorrectionInput): CorrectionResult {
  const txn = db.select().from(transactions).where(eq(transactions.id, input.transactionId)).get();
  if (!txn) throw new Error("Unknown transaction");

  const result: CorrectionResult = {
    merchantUpdated: false,
    directionGuardTriggered: false,
    retroactivelyUpdated: 0,
  };

  db.transaction((tx) => {
    tx.update(transactions)
      .set({
        categoryId: input.categoryId,
        categorizationSource: "user",
        categorizationConfidence: 1,
        needsReview: false,
      })
      .where(eq(transactions.id, input.transactionId))
      .run();

    if (!input.applyToMerchant || !txn.merchantId) return;

    const siblings = tx
      .select({ amountCents: transactions.amountCents })
      .from(transactions)
      .where(and(eq(transactions.merchantId, txn.merchantId), eq(transactions.status, "active")))
      .all();
    const negatives = siblings.filter((s) => s.amountCents < 0).length;
    const dominantNegative = negatives >= siblings.length / 2;
    const opposesDominant = dominantNegative ? txn.amountCents > 0 : txn.amountCents < 0;

    if (opposesDominant && !input.confirmDirectionOverride) {
      result.directionGuardTriggered = true; // txn-only; mapping untouched
      return;
    }

    tx.update(merchants)
      .set({ defaultCategoryId: input.categoryId, mappingSource: "user" })
      .where(eq(merchants.id, txn.merchantId))
      .run();
    result.merchantUpdated = true;

    if (input.retroactive) {
      const updated = tx
        .update(transactions)
        .set({ categoryId: input.categoryId, categorizationSource: "merchant_map" })
        .where(
          and(
            eq(transactions.merchantId, txn.merchantId),
            eq(transactions.status, "active"),
            or(isNull(transactions.categorizationSource), ne(transactions.categorizationSource, "user")),
            ne(transactions.id, txn.id),
          ),
        )
        .run();
      result.retroactivelyUpdated = updated.changes;
    }
  });

  return result;
}

export interface CoverageStats {
  total: number;
  categorized: number;
  coveragePct: number;
  needsReview: number;
}

export function coverageStats(db: AppDatabase): CoverageStats {
  const rows = db
    .select({ categoryId: transactions.categoryId, needsReview: transactions.needsReview })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all();
  const total = rows.length;
  const categorized = rows.filter((r) => r.categoryId !== null).length;
  return {
    total,
    categorized,
    coveragePct: total === 0 ? 100 : Math.round((categorized / total) * 1000) / 10,
    needsReview: rows.filter((r) => r.needsReview).length,
  };
}
