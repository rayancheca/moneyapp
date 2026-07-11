"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { merchantSummary, similarTransactions } from "@/services/merchants";
import type { ActionResult } from "./action-types";

/**
 * Read-only companion to the value-returning mutations (actions.ts): the
 * transaction Sheet fetches its same-merchant panel lazily, once, when it
 * opens — one debounced round-trip per settle (ux-overhaul-plan §3.2), never
 * serialized into every ledger row.
 */

export interface SheetPanelRow {
  id: string;
  postedOn: string;
  description: string;
  amountCents: number;
  categoryLabel: string | null;
}

export interface SheetPanel {
  /** present when the txn has a merchant — the headline "At {merchant}" panel */
  merchant: { id: string; name: string; txnCount: number; totalCentsThisYear: number } | null;
  /** siblings (same merchant, else stripped-key match); [] on investment rows */
  siblings: SheetPanelRow[];
}

export async function loadSheetPanel(
  transactionId: string,
): Promise<ActionResult<SheetPanel>> {
  try {
    const id = z.string().min(1).parse(transactionId);
    const db = getDb();
    // similarTransactions resolves the merchant/stripped-key siblings and
    // returns [] for investment-account rows (trades aren't merchants)
    const siblingsRaw = similarTransactions(db, id, 6);
    const siblings: SheetPanelRow[] = siblingsRaw.map((r) => ({
      id: r.id,
      postedOn: r.postedOn,
      description: r.normalizedDescription || r.rawDescription,
      amountCents: r.amountCents,
      categoryLabel: null,
    }));

    // merchant summary only when this row carries a merchant id
    const { transactions } = await import("@/db/schema/transactions");
    const { eq } = await import("drizzle-orm");
    const row = db
      .select({ merchantId: transactions.merchantId })
      .from(transactions)
      .where(eq(transactions.id, id))
      .get();

    const merchant =
      row?.merchantId != null
        ? (() => {
            const s = merchantSummary(db, row.merchantId!);
            return { id: s.id, name: s.name, txnCount: s.txnCount, totalCentsThisYear: s.totalCentsThisYear };
          })()
        : null;

    return { ok: true, data: { merchant, siblings } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load panel" };
  }
}
