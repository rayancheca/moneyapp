import { assertValidCents, sumCents } from "@/lib/money";

/**
 * Pure validation + allocation math for transaction splitting (the
 * category-allocation overlay defined in db/schema/transaction-splits.ts). Kept
 * free of React and the DB so the invariant — parts sum EXACTLY to the parent,
 * at least two of them, each non-zero, same sign as the parent, each
 * categorized — is unit-testable in isolation. The service layer enforces the
 * same invariant at write time; the UI reuses remainingCents for its live
 * "remaining to allocate" readout.
 */

/** A single line in the split editor (category may be unset mid-edit). */
export interface SplitDraftLine {
  categoryId: string | null;
  amountCents: number;
}

/** A persisted split row (subset used by allocation math). */
export interface SplitRow {
  id: string;
  categoryId: string;
  amountCents: number;
}

/** One category allocation of a transaction's amount — a split part, or the
 * whole transaction (splitId null) when it is unsplit. */
export interface Allocation {
  categoryId: string | null;
  amountCents: number;
  splitId: string | null;
}

export type SplitDraftError =
  | "zero-parent"
  | "too-few-lines"
  | "zero-amount"
  | "sign-mismatch"
  | "uncategorized-line"
  | "sum-mismatch";

export type SplitDraftResult = { ok: true } | { ok: false; error: SplitDraftError; message: string };

/** A split must decompose a transaction into at least this many parts. */
export const MIN_SPLIT_LINES = 2;

const MESSAGES: Record<SplitDraftError, string> = {
  "zero-parent": "A $0.00 transaction cannot be split.",
  "too-few-lines": `A split needs at least ${MIN_SPLIT_LINES} parts.`,
  "zero-amount": "Each split part must be a non-zero amount.",
  "sign-mismatch": "Each split part must have the same sign as the transaction.",
  "uncategorized-line": "Choose a category for every split part.",
  "sum-mismatch": "Split parts must add up to the transaction amount.",
};

function fail(error: SplitDraftError): SplitDraftResult {
  return { ok: false, error, message: MESSAGES[error] };
}

/** Parent amount minus the sum of the current lines — 0 means fully allocated,
 * non-zero is what is still left to assign (drives the editor's live readout). */
export function remainingCents(
  parentAmountCents: number,
  lines: readonly { amountCents: number }[],
): number {
  return parentAmountCents - sumCents(lines.map((l) => l.amountCents));
}

/** Validates a draft split against its parent transaction amount. */
export function validateSplitDraft(
  parentAmountCents: number,
  lines: readonly SplitDraftLine[],
): SplitDraftResult {
  assertValidCents(parentAmountCents);
  if (parentAmountCents === 0) return fail("zero-parent");
  if (lines.length < MIN_SPLIT_LINES) return fail("too-few-lines");

  const parentSign = Math.sign(parentAmountCents);
  for (const l of lines) {
    assertValidCents(l.amountCents);
    if (l.amountCents === 0) return fail("zero-amount");
    if (Math.sign(l.amountCents) !== parentSign) return fail("sign-mismatch");
    if (!l.categoryId) return fail("uncategorized-line");
  }

  if (remainingCents(parentAmountCents, lines) !== 0) return fail("sum-mismatch");
  return { ok: true };
}

/**
 * Explodes a transaction into its category allocations: one Allocation per split
 * part when the transaction has splits, otherwise a single whole-transaction
 * Allocation carrying the parent's own category. The parent's categoryId is
 * IGNORED once splits exist — it is only a display 'primary'.
 */
export function allocationsFor(
  parentCategoryId: string | null,
  parentAmountCents: number,
  splits: readonly SplitRow[],
): Allocation[] {
  if (splits.length === 0) {
    return [{ categoryId: parentCategoryId, amountCents: parentAmountCents, splitId: null }];
  }
  return splits.map((s) => ({
    categoryId: s.categoryId,
    amountCents: s.amountCents,
    splitId: s.id,
  }));
}
