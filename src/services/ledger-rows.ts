import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import type { LedgerRow } from "@/components/transactions/TransactionsLedger";

/**
 * Shared LedgerRow assembly (ux-overhaul-plan §7.1/§7.3). The triage ledger, the
 * dashboard "recent transactions" teaser, and an account's recent rows must all
 * be the SAME interactive rows — same category chip (with parent hue/icon
 * inheritance), same low-confidence flag, same sheet. This is the one place that
 * turns a joined transaction row into a `LedgerRow`, so every surface stays byte-
 * identical and a fix to the grammar lands everywhere at once.
 */

/** A confidence below this reads as "low confidence" — matches /transactions. */
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

export type CategoryRow = typeof categories.$inferSelect;

interface RawLedgerRow {
  id: string;
  postedOn: string;
  rawDescription: string;
  normalizedDescription: string;
  accountName: string;
  amountCents: number;
  categoryId: string | null;
  merchantId: string | null;
  transferGroupId: string | null;
  recurringSeriesId: string | null;
  categorizationConfidence: number | null;
  needsReview: boolean;
  status: LedgerRow["status"];
  notes: string | null;
  importFileId: string | null;
}

/** Maps one joined transaction row to a LedgerRow, inheriting parent hue/icon. */
export function toLedgerRow(row: RawLedgerRow, catById: ReadonlyMap<string, CategoryRow>): LedgerRow {
  const cat = row.categoryId ? catById.get(row.categoryId) : undefined;
  // children inherit the parent hue/icon where their own is unset (§2.3)
  const parent = cat?.parentId ? catById.get(cat.parentId) : undefined;
  return {
    id: row.id,
    postedOn: row.postedOn,
    rawDescription: row.rawDescription,
    normalizedDescription: row.normalizedDescription,
    accountName: row.accountName,
    amountCents: row.amountCents,
    categoryId: row.categoryId,
    categoryName: cat ? cat.name : null,
    hue: cat?.color ?? parent?.color ?? null,
    icon: cat?.icon ?? parent?.icon ?? null,
    merchantId: row.merchantId,
    isTransfer: row.transferGroupId !== null,
    isRecurring: row.recurringSeriesId !== null,
    needsReview: row.needsReview,
    status: row.status,
    notes: row.notes,
    isManual: row.importFileId === null,
    lowConfidence:
      row.categorizationConfidence !== null &&
      row.categorizationConfidence < LOW_CONFIDENCE_THRESHOLD,
    suggestedCategoryIds: [],
  };
}

/** Column selection shared by every recent-rows query (parallels /transactions). */
const LEDGER_SELECT = {
  id: transactions.id,
  postedOn: transactions.postedOn,
  rawDescription: transactions.rawDescription,
  normalizedDescription: transactions.normalizedDescription,
  amountCents: transactions.amountCents,
  categoryId: transactions.categoryId,
  merchantId: transactions.merchantId,
  transferGroupId: transactions.transferGroupId,
  recurringSeriesId: transactions.recurringSeriesId,
  categorizationConfidence: transactions.categorizationConfidence,
  needsReview: transactions.needsReview,
  status: transactions.status,
  notes: transactions.notes,
  importFileId: transactions.importFileId,
  accountName: accounts.name,
} as const;

// Content-column tiebreaks identical to /transactions, so a re-seed/re-import
// can't shuffle otherwise-tied same-day rows between runs (baseline stability).
const LEDGER_ORDER = [
  desc(transactions.postedOn),
  desc(transactions.amountCents),
  desc(transactions.rawDescription),
  asc(accounts.name),
  asc(transactions.occurrenceIndex),
  desc(transactions.id),
] as const;

export interface RecentLedgerOptions {
  /** scope to one account (account detail); omit for the whole ledger (dashboard) */
  accountId?: string;
  limit: number;
  /** when true, only rows still awaiting review (the dashboard To-Review teaser) */
  needsReviewOnly?: boolean;
  /** inclusive lower bound on postedOn (dashboard period-activity panel) */
  from?: string;
  /** inclusive upper bound on postedOn */
  to?: string;
}

/** The N newest active LedgerRows, optionally scoped to an account / review queue / date window. */
export function recentLedgerRows(db: AppDatabase, options: RecentLedgerOptions): LedgerRow[] {
  const conditions = [eq(transactions.status, "active")];
  if (options.accountId) conditions.push(eq(transactions.accountId, options.accountId));
  if (options.needsReviewOnly) conditions.push(eq(transactions.needsReview, true));
  if (options.from) conditions.push(gte(transactions.postedOn, options.from));
  if (options.to) conditions.push(lte(transactions.postedOn, options.to));

  const rows = db
    .select(LEDGER_SELECT)
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(...LEDGER_ORDER)
    .limit(options.limit)
    .all();

  const catById = new Map(db.select().from(categories).all().map((c) => [c.id, c]));
  return rows.map((r) => toLedgerRow(r, catById));
}
