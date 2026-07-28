"use server";

import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { spendingTransactions, transactionsHref, type AnalyticsTxn } from "@/services/analytics";
import { dailySpendHeatmap, type SpendHeatmap } from "@/services/spending";
import { isValidIsoDate } from "@/lib/dates";
import { actionErrorMessage, type ActionResult } from "@/app/transactions/action-types";

/**
 * Lazy loader for the Spending page's inline categorizer (ux-overhaul-plan §5.4):
 * the exact transactions behind any breakdown bucket — a category subtree or the
 * explicit Uncategorized bucket — so you can fix categories without leaving the
 * report. The authoritative set comes from `spendingTransactions` (the SAME
 * predicate the numbers are computed from), so the inline list and the displayed
 * count can never drift; only a capped page is hydrated for display, with a link
 * to the full filtered ledger for the remainder.
 */

const LIMIT = 100;

export interface SpendingTxnRow {
  id: string;
  /** unique per drill-down row — a split transaction contributes one row per part */
  rowKey: string;
  /** set when this row is one part of a split transaction (edited via the sheet, not inline) */
  splitId: string | null;
  postedOn: string;
  description: string;
  accountName: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
  hue: string | null;
  icon: string | null;
}

export interface SpendingCategoryTxns {
  rows: SpendingTxnRow[];
  /** the whole bucket size — rows is capped, so `rows.length <= total` */
  total: number;
  /** link to the full filtered ledger for everything beyond the cap */
  href: string;
}

const inputSchema = z.object({
  // null = the explicit Uncategorized bucket (negative, category-less rows)
  categoryId: z.string().min(1).nullable(),
  from: z.string().refine(isValidIsoDate, "Invalid from date"),
  to: z.string().refine(isValidIsoDate, "Invalid to date"),
});

export async function loadSpendingCategoryTxns(input: {
  categoryId: string | null;
  from: string;
  to: string;
}): Promise<ActionResult<SpendingCategoryTxns>> {
  try {
    const parsed = inputSchema.parse(input);
    const db = getDb();
    const filter = { categoryId: parsed.categoryId, from: parsed.from, to: parsed.to };

    // authoritative set + count (identical predicate to the displayed numbers)
    const authoritative = spendingTransactions(db, filter);
    const total = authoritative.length;

    // deterministic newest-first order (mirrors the ledger's content tiebreak so
    // reseeded e2e runs are stable): date desc, largest outflow first, then
    // description, then id, then split part (split rows share a parent id)
    const ordered = [...authoritative].sort(
      (a, b) =>
        b.postedOn.localeCompare(a.postedOn) ||
        a.amountCents - b.amountCents ||
        b.rawDescription.localeCompare(a.rawDescription) ||
        b.id.localeCompare(a.id) ||
        (a.splitId ?? "").localeCompare(b.splitId ?? ""),
    );
    const page = ordered.slice(0, LIMIT);

    const rows = hydrateRows(db, page);
    return { ok: true, data: { rows, total, href: transactionsHref(filter) } };
  } catch (error: unknown) {
    // a ZodError's own message is a JSON dump of the issue array — unwrap it to
    // the single "Invalid from date" the schema declared
    return {
      ok: false,
      error: actionErrorMessage(
        error,
        { categoryId: "Category", from: "From", to: "To" },
        "Failed to load",
      ),
    };
  }
}

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Heatmap data for a month — the SpendHeatmap component's ‹ › paging loader. */
export async function loadSpendHeatmap(monthKey: string): Promise<ActionResult<SpendHeatmap>> {
  try {
    if (!MONTH_KEY_RE.test(monthKey)) return { ok: false, error: "Invalid month" };
    return { ok: true, data: dailySpendHeatmap(getDb(), monthKey) };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Failed to load") };
  }
}

/**
 * Hydrate display fields (normalized name, account) for a capped page, preserving
 * the caller's order. Split-aware: each page entry is an allocation — the AMOUNT
 * and CATEGORY come from the entry (a split part carries its own), while only the
 * account name + normalized description are looked up by the parent transaction
 * id. So a split transaction renders one row per part, each at its part amount and
 * category, and the list reconciles with the aggregate it drilled into.
 */
function hydrateRows(db: ReturnType<typeof getDb>, page: readonly AnalyticsTxn[]): SpendingTxnRow[] {
  if (page.length === 0) return [];
  const ids = [...new Set(page.map((r) => r.id))];
  const detail = db
    .select({
      id: transactions.id,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(inArray(transactions.id, ids))
    .all();

  const catById = new Map(db.select().from(categories).all().map((c) => [c.id, c]));
  const byId = new Map(detail.map((r) => [r.id, r] as const));

  return page.flatMap((p) => {
    const r = byId.get(p.id);
    if (!r) return [];
    const cat = p.categoryId ? catById.get(p.categoryId) : undefined;
    const parent = cat?.parentId ? catById.get(cat.parentId) : undefined;
    return [
      {
        id: p.id,
        rowKey: p.splitId ?? p.id,
        splitId: p.splitId,
        postedOn: p.postedOn,
        description: r.normalizedDescription || r.rawDescription,
        accountName: r.accountName,
        amountCents: p.amountCents,
        categoryId: p.categoryId,
        categoryName: cat?.name ?? null,
        hue: cat?.color ?? parent?.color ?? null,
        icon: cat?.icon ?? parent?.icon ?? null,
      } satisfies SpendingTxnRow,
    ];
  });
}
