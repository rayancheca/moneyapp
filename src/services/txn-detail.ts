import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { monthKey, todayIso } from "@/lib/dates";
import { loadRules, ruleMatches } from "./categorize";
import { loadCategoryIndex, monthKeysBack } from "./analytics";
import { similarGroupIds } from "./merchants";
import { renderRuleSentence, sentenceContext } from "./rules-manager";

/**
 * The "categorize this transaction" context (ux-overhaul-plan §3.2 — the learning
 * loop): a smart category suggestion the user can accept in one tap, the merchant
 * or same-name group's spend history (so the decision has context), and the
 * auto-categorization rules that already fire on this row. Every piece is derived
 * from the same identity the sheet's "Recategorize all" acts on, so nothing here
 * can disagree with what a correction would actually change.
 */

const HISTORY_MONTHS = 6;

export type SuggestionReason = "rule" | "merchant" | "history";

export interface CategorySuggestion {
  categoryId: string;
  categoryLabel: string;
  reason: SuggestionReason;
  /** the enabled rule that would categorize this row (reason === "rule") */
  ruleId?: string;
  /** how many past rows back a "history" suggestion */
  support?: number;
}

export interface TxnHistoryMonth {
  monthKey: string;
  /** money-out that month, positive cents (for the sparkline) */
  cents: number;
}

export interface TxnHistoryAccount {
  accountName: string;
  count: number;
  /** money-out total on this account, positive cents */
  cents: number;
}

export interface TxnHistory {
  /** rows in the merchant / same-name group (including this one) */
  count: number;
  /** mean money-out per outflow row, positive cents */
  avgCents: number;
  /** all-time money-out total for the group, positive cents */
  totalCents: number;
  /** last HISTORY_MONTHS months of money-out, oldest first */
  monthly: TxnHistoryMonth[];
  /** where the group's spend lands, most-frequent first */
  byAccount: TxnHistoryAccount[];
}

export interface MatchingRule {
  id: string;
  name: string;
  sentence: string;
}

export interface CategorizeContext {
  /** best one-tap suggestion, or null when nothing beats the current category */
  suggestion: CategorySuggestion | null;
  /** merchant / same-name history, or null for investment rows (no group) */
  history: TxnHistory | null;
  /** enabled rules that already fire on this exact row */
  matchingRules: MatchingRule[];
}

interface DetailTxn {
  id: string;
  accountId: string;
  amountCents: number;
  normalizedDescription: string;
  merchantId: string | null;
  categoryId: string | null;
}

function loadDetailTxn(db: AppDatabase, transactionId: string): DetailTxn | null {
  return (
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        normalizedDescription: transactions.normalizedDescription,
        merchantId: transactions.merchantId,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get() ?? null
  );
}

/** "Parent > Child" for a subcategory, bare name for a top-level. */
function categoryLabeler(db: AppDatabase): (id: string) => string {
  const { byId } = loadCategoryIndex(db);
  return (id: string) => {
    const node = byId.get(id);
    if (!node) return "a category";
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    return parent ? `${parent.name} > ${node.name}` : node.name;
  };
}

/**
 * The best category to propose, or null when nothing useful beats the current
 * value. Precedence mirrors the categorization pipeline the user is training:
 * an enabled rule > the merchant's default mapping > the plurality category of
 * the same-name group's history. A suggestion equal to the current category is
 * suppressed (nothing to accept).
 */
export function suggestCategory(db: AppDatabase, transactionId: string): CategorySuggestion | null {
  const txn = loadDetailTxn(db, transactionId);
  if (!txn) return null;
  const label = categoryLabeler(db);

  const propose = (categoryId: string, reason: SuggestionReason, extra?: Partial<CategorySuggestion>) =>
    categoryId === txn.categoryId
      ? null
      : { categoryId, categoryLabel: label(categoryId), reason, ...extra };

  // 1. an enabled rule that assigns a category and matches this row
  for (const rule of loadRules(db)) {
    if (rule.act.categoryId && ruleMatches(rule.cond, txn)) {
      const s = propose(rule.act.categoryId, "rule", { ruleId: rule.id });
      if (s) return s;
      return null; // the rule already put it where it belongs — nothing to accept
    }
  }

  // 2. the merchant's default mapping — HIGHER precedence than history, so a
  // merchant that carries a default settles the suggestion here and never falls
  // through (propose() returns null when the default already equals the current
  // category — nothing to accept, and history must not override the merchant map)
  if (txn.merchantId) {
    const merchant = db
      .select({ defaultCategoryId: merchants.defaultCategoryId })
      .from(merchants)
      .where(eq(merchants.id, txn.merchantId))
      .get();
    if (merchant?.defaultCategoryId) {
      return propose(merchant.defaultCategoryId, "merchant");
    }
  }

  // 3. plurality category of the same-name group's OTHER rows
  const groupIds = similarGroupIds(db, transactionId).filter((id) => id !== transactionId);
  if (groupIds.length > 0) {
    const rows = db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(and(inArray(transactions.id, groupIds), eq(transactions.status, "active")))
      .all();
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.categoryId) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
    }
    // most frequent; ties broken on the category LABEL (content) — category ids
    // are per-seed random uuidv7, so an id comparison would flake across reseeds
    let best: string | null = null;
    let bestCount = 0;
    for (const [categoryId, n] of counts) {
      if (n > bestCount || (n === bestCount && best !== null && label(categoryId) < label(best))) {
        best = categoryId;
        bestCount = n;
      }
    }
    if (best) {
      const s = propose(best, "history", { support: bestCount });
      if (s) return s;
    }
  }

  return null;
}

/**
 * Spend history for a transaction's merchant / same-name group: total, average,
 * a monthly money-out series for the sparkline, and a by-account split. Null for
 * investment-account rows (trades aren't merchants — similarGroupIds returns []).
 */
export function txnHistory(
  db: AppDatabase,
  transactionId: string,
  today: string = todayIso(),
): TxnHistory | null {
  const groupIds = similarGroupIds(db, transactionId);
  if (groupIds.length === 0) return null;

  const rows = db
    .select({
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(inArray(transactions.id, groupIds))
    .all();

  const months = monthKeysBack(today, HISTORY_MONTHS);
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const monthlyCents = new Array<number>(months.length).fill(0);
  const byAccount = new Map<string, { count: number; cents: number }>();

  let totalCents = 0;
  let outCount = 0;
  for (const r of rows) {
    const out = r.amountCents < 0 ? -r.amountCents : 0;
    if (out > 0) {
      totalCents += out;
      outCount += 1;
    }
    const mi = monthIndex.get(monthKey(r.postedOn));
    if (mi !== undefined) monthlyCents[mi]! += out;
    const acc = byAccount.get(r.accountName) ?? { count: 0, cents: 0 };
    acc.count += 1;
    acc.cents += out;
    byAccount.set(r.accountName, acc);
  }

  return {
    count: rows.length,
    avgCents: outCount > 0 ? Math.round(totalCents / outCount) : 0,
    totalCents,
    monthly: months.map((m, i) => ({ monthKey: m, cents: monthlyCents[i]! })),
    byAccount: [...byAccount.entries()]
      .map(([accountName, v]) => ({ accountName, count: v.count, cents: v.cents }))
      .sort((a, b) => b.count - a.count || b.cents - a.cents || a.accountName.localeCompare(b.accountName)),
  };
}

/** Enabled rules whose conditions already match this exact row, as sentences. */
export function matchingRules(db: AppDatabase, transactionId: string): MatchingRule[] {
  const txn = loadDetailTxn(db, transactionId);
  if (!txn) return [];
  const ctx = sentenceContext(db);
  return loadRules(db)
    .filter((rule) => ruleMatches(rule.cond, txn))
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      sentence: renderRuleSentence(rule.cond, rule.act, ctx),
    }));
}

/** One call for the sheet's categorize panel — suggestion, history, rules. */
export function categorizeContext(
  db: AppDatabase,
  transactionId: string,
  today: string = todayIso(),
): CategorizeContext {
  return {
    suggestion: suggestCategory(db, transactionId),
    history: txnHistory(db, transactionId, today),
    matchingRules: matchingRules(db, transactionId),
  };
}
