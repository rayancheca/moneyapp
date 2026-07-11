"use server";

import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { spendingTransactions, transactionsHref } from "@/services/analytics";
import { isValidIsoDate } from "@/lib/dates";
import type { ActionResult } from "@/app/transactions/action-types";

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
    // description, then id
    const ordered = [...authoritative].sort(
      (a, b) =>
        b.postedOn.localeCompare(a.postedOn) ||
        a.amountCents - b.amountCents ||
        b.rawDescription.localeCompare(a.rawDescription) ||
        b.id.localeCompare(a.id),
    );
    const page = ordered.slice(0, LIMIT);

    const rows = hydrateRows(db, page);
    return { ok: true, data: { rows, total, href: transactionsHref(filter) } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load" };
  }
}

/** Hydrate display fields (normalized name, account, category identity) for a
 *  capped id page, preserving the caller's order. */
function hydrateRows(
  db: ReturnType<typeof getDb>,
  page: readonly { id: string }[],
): SpendingTxnRow[] {
  if (page.length === 0) return [];
  const ids = page.map((r) => r.id);
  const detail = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
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
    const cat = r.categoryId ? catById.get(r.categoryId) : undefined;
    const parent = cat?.parentId ? catById.get(cat.parentId) : undefined;
    return [
      {
        id: r.id,
        postedOn: r.postedOn,
        description: r.normalizedDescription || r.rawDescription,
        accountName: r.accountName,
        amountCents: r.amountCents,
        categoryId: r.categoryId,
        categoryName: cat?.name ?? null,
        hue: cat?.color ?? parent?.color ?? null,
        icon: cat?.icon ?? parent?.icon ?? null,
      } satisfies SpendingTxnRow,
    ];
  });
}
