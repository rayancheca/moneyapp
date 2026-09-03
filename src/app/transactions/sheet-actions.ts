"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { merchantSummary, similarGroupIds, similarTransactions } from "@/services/merchants";
import {
  transferCandidates,
  transferCounterparts,
  type TransferCandidate,
} from "@/services/transfer-links";
import {
  categorizeContext,
  type CategorySuggestion,
  type MatchingRule,
  type TxnHistory,
} from "@/services/txn-detail";
import { provenanceFor, type Provenance } from "@/services/provenance";
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
  /**
   * Total active rows in this row's name group INCLUDING itself — the "N" the
   * "Recategorize all N" button acts on. 0/1 means there is nothing to bulk
   * (investment rows, empty name key, or a one-off) and the button is hidden.
   */
  similarCount: number;
  /** the learning loop (§3.2): a one-tap category suggestion, or null */
  suggestion: CategorySuggestion | null;
  /** merchant / same-name spend history, or null for investment rows */
  history: TxnHistory | null;
  /** enabled rules that already fire on this exact row */
  matchingRules: MatchingRule[];
  /**
   * "Prove it" for this row — which file carried it, which period covers it,
   * and what the day's balance basis says.
   *
   * ⚠️ It rides on the SHEET load, not on the ledger query, and that placement
   * is the whole reason it is affordable: `provenanceFor` runs four queries,
   * and the ledger renders up to a page of rows at a time. Serialising it into
   * every row would repeat the per-row-work regression pass 31 already found.
   */
  provenance: Provenance | null;
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

    // server-recomputed group size for "Recategorize all N" (merchant or
    // stripped-key; [] for investment rows / empty keys)
    const similarCount = similarGroupIds(db, id).length;

    // the categorize learning loop: suggestion + history + matching rules
    const { suggestion, history, matchingRules } = categorizeContext(db, id);

    const provenance = provenanceFor(db, { kind: "transaction", id });

    return { ok: true, data: { merchant, siblings, similarCount, suggestion, history, matchingRules, provenance } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load panel" };
  }
}

// ── S5 "linkable" panels — loaded lazily on disclosure, never on sheet open ──

export interface TransferLinkPanelData {
  /** present when the row is already in a transfer group */
  counterparts: { groupId: string; legs: TransferCandidate[] } | null;
  /** pairing candidates when it is not */
  candidates: TransferCandidate[];
}

export async function loadTransferLinkPanel(
  transactionId: string,
): Promise<ActionResult<TransferLinkPanelData>> {
  try {
    const id = z.string().min(1).parse(transactionId);
    const db = getDb();
    const counterparts = transferCounterparts(db, id);
    return {
      ok: true,
      data: {
        counterparts,
        candidates: counterparts === null ? transferCandidates(db, id) : [],
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load transfer panel" };
  }
}

export interface SeriesLinkCandidate {
  id: string;
  name: string;
  /** cadence + typical amount, e.g. "monthly · ~$11.99" */
  detail: string;
}

export interface SplitPanelData {
  /** the parent amount the parts must sum to (net-worth-signed cents) */
  amountCents: number;
  /** false when the row can't be split (transfer-linked or not active) */
  canSplit: boolean;
  /** why splitting is unavailable, when canSplit is false */
  blockedReason: string | null;
  /** existing split parts, ordered */
  splits: { id: string; categoryId: string; amountCents: number; note: string | null }[];
}

export async function loadSplitPanel(
  transactionId: string,
): Promise<ActionResult<SplitPanelData>> {
  try {
    const id = z.string().min(1).parse(transactionId);
    const db = getDb();
    const { transactions } = await import("@/db/schema/transactions");
    const { eq } = await import("drizzle-orm");
    const { listSplits } = await import("@/services/transaction-splits");
    const row = db
      .select({
        amountCents: transactions.amountCents,
        transferGroupId: transactions.transferGroupId,
        status: transactions.status,
      })
      .from(transactions)
      .where(eq(transactions.id, id))
      .get();
    if (!row) throw new Error("Unknown transaction");

    const blockedReason =
      row.status !== "active"
        ? "Only active transactions can be split."
        : row.transferGroupId !== null
          ? "Transfer-linked — unlink the transfer to split this."
          : row.amountCents === 0
            ? "A $0.00 transaction can't be split."
            : null;

    return {
      ok: true,
      data: {
        amountCents: row.amountCents,
        canSplit: blockedReason === null,
        blockedReason,
        splits: listSplits(db, id).map((s) => ({
          id: s.id,
          categoryId: s.categoryId,
          amountCents: s.amountCents,
          note: s.note,
        })),
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load split panel" };
  }
}

export interface SeriesLinkPanelData {
  /** the series this row is attached to, when any */
  linked: { id: string; name: string } | null;
  candidates: SeriesLinkCandidate[];
}

const SERIES_CANDIDATE_LIMIT = 12;

export async function loadSeriesLinkPanel(
  transactionId: string,
): Promise<ActionResult<SeriesLinkPanelData>> {
  try {
    const id = z.string().min(1).parse(transactionId);
    const db = getDb();
    const { transactions } = await import("@/db/schema/transactions");
    const { recurringSeries } = await import("@/db/schema/recurring");
    const { eq } = await import("drizzle-orm");
    const row = db
      .select({ recurringSeriesId: transactions.recurringSeriesId, merchantId: transactions.merchantId })
      .from(transactions)
      .where(eq(transactions.id, id))
      .get();
    if (!row) throw new Error("Unknown transaction");

    if (row.recurringSeriesId) {
      const series = db
        .select({ id: recurringSeries.id, name: recurringSeries.name })
        .from(recurringSeries)
        .where(eq(recurringSeries.id, row.recurringSeriesId))
        .get();
      return { ok: true, data: { linked: series ?? null, candidates: [] } };
    }

    const { listSeries } = await import("@/services/recurring");
    const { formatCents } = await import("@/lib/money");
    const merchantName = row.merchantId ? merchantSummary(db, row.merchantId).name : null;
    const candidates = listSeries(db)
      .filter((s) => s.status === "detected" || s.status === "confirmed")
      .sort((a, b) => {
        // same-merchant series first — the likeliest attach target
        const aMatch = merchantName !== null && a.merchantName === merchantName ? 0 : 1;
        const bMatch = merchantName !== null && b.merchantName === merchantName ? 0 : 1;
        return aMatch - bMatch || a.name.localeCompare(b.name);
      })
      .slice(0, SERIES_CANDIDATE_LIMIT)
      .map((s) => ({
        id: s.id,
        name: s.name,
        // the effective amount, never the stored seed of a hand-registered series
        detail: `${s.cadence}${s.nextExpectedAmountCents !== null ? ` · ~${formatCents(Math.abs(s.nextExpectedAmountCents))}` : ""}`,
      }));
    return { ok: true, data: { linked: null, candidates } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load series panel" };
  }
}
