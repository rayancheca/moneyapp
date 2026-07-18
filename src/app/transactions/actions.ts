"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { CATEGORIZATION_SOURCES, transactions } from "@/db/schema/transactions";
import {
  bulkApply,
  bulkApplyByFilter,
  applyUndoPatch,
  markAllReviewedBefore,
  setTransactionFlags,
  txnFlagsSchema,
  txnPatchSchema,
  undoPatchSchema,
  type TxnFlags,
  type TxnPatch,
  type UndoPatch,
} from "@/services/bulk-edit";
import { applyCorrection, categorizeAll, detectTransfers } from "@/services/categorize";
import { classifyPendingMerchants, requestClaudeStop } from "@/services/claude-categorize";
import {
  addManualTransaction,
  editManualTransaction,
  manualTxnEditSchema,
  manualTxnInputSchema,
  type ManualTxnEdit,
  type ManualTxnInput,
} from "@/services/manual-transactions";
import { renameMerchant, similarGroupIds } from "@/services/merchants";
import { linkTransferPair, unlinkTransferGroup } from "@/services/transfer-links";
import {
  clearSplits,
  restoreSplits,
  setSplits,
  type SplitSnapshot,
} from "@/services/transaction-splits";
import {
  clusterRefSchema,
  confirmCluster,
  recategorizeCluster,
  type ClusterRef,
} from "@/services/review-inbox";
import {
  conditionsForCorrection,
  countRuleMatches,
  deleteRule,
  retroApplyRule,
  ruleFromCorrection,
} from "@/services/rule-corrections";
import { humanizeDescriptionKey, strippedDescriptionKey } from "@/lib/description-key";
import { parseFilters, type SearchParams, type TxnNotice } from "@/components/transactions/query";
import type {
  ActionResult,
  BulkMutationData,
  CorrectCategoryData,
  CreatedRuleData,
  RecategorizeGroupData,
  RulePromptPreview,
} from "./action-types";

/**
 * Thin server actions over the Phase 3 services — no categorization logic
 * lives here. Every action Zod-validates its FormData and returns the user
 * to the exact filtered view they acted from (`returnTo` query string).
 */

// only same-page query strings built by filtersToQuery (plus every character
// encodeURIComponent can emit) — never a path, so no open-redirect surface
const SAFE_RETURN_QUERY_RE = /^\?[A-Za-z0-9=&_%.\-!'()*~+]*$/;

function safeReturnQuery(raw: FormDataEntryValue | null): string {
  return typeof raw === "string" && SAFE_RETURN_QUERY_RE.test(raw) ? raw : "";
}

function transactionsPath(returnQuery: string, notice?: TxnNotice): string {
  if (!notice) return `/transactions${returnQuery}`;
  const separator = returnQuery === "" ? "?" : "&";
  return `/transactions${returnQuery}${separator}notice=${notice}`;
}

const correctionFormSchema = z.object({
  transactionId: z.string().min(1, "Missing transaction"),
  categoryId: z.string().min(1, "Pick a category"),
  applyToMerchant: z.boolean(),
  retroactive: z.boolean(),
  returnTo: z.string(),
});

export async function correctCategoryAction(formData: FormData): Promise<void> {
  const parsed = correctionFormSchema.parse({
    transactionId: formData.get("transactionId"),
    categoryId: formData.get("categoryId"),
    applyToMerchant: formData.get("applyToMerchant") === "on",
    retroactive: formData.get("retroactive") === "on",
    returnTo: safeReturnQuery(formData.get("returnTo")),
  });

  const result = applyCorrection(getDb(), {
    transactionId: parsed.transactionId,
    categoryId: parsed.categoryId,
    applyToMerchant: parsed.applyToMerchant,
    retroactive: parsed.retroactive,
  });

  revalidatePath("/transactions");
  revalidatePath("/");
  if (result.directionGuardTriggered) {
    // sign-opposing correction: the txn changed, the mapping did NOT —
    // surface a notice instead of silently flipping the merchant default
    redirect(transactionsPath(parsed.returnTo, "direction-guard"));
  }
  redirect(transactionsPath(parsed.returnTo));
}

const returnOnlyFormSchema = z.object({ returnTo: z.string() });

export async function runCategorizationAction(formData: FormData): Promise<void> {
  const parsed = returnOnlyFormSchema.parse({
    returnTo: safeReturnQuery(formData.get("returnTo")),
  });

  const db = getDb();
  categorizeAll(db);
  detectTransfers(db);

  revalidatePath("/transactions");
  revalidatePath("/");
  redirect(transactionsPath(parsed.returnTo));
}

export async function stopClassifyAction(formData: FormData): Promise<void> {
  const parsed = returnOnlyFormSchema.parse({
    returnTo: safeReturnQuery(formData.get("returnTo")),
  });
  requestClaudeStop(getDb());
  revalidatePath("/transactions");
  redirect(transactionsPath(parsed.returnTo));
}

export async function classifyMerchantsAction(formData: FormData): Promise<void> {
  const parsed = returnOnlyFormSchema.parse({
    returnTo: safeReturnQuery(formData.get("returnTo")),
  });

  const result = await classifyPendingMerchants(getDb());

  revalidatePath("/transactions");
  revalidatePath("/");
  if (!result.ran && result.queued > 0) {
    // no ANTHROPIC_API_KEY — the service no-ops and the queue is preserved
    redirect(transactionsPath(parsed.returnTo, "no-api-key"));
  }
  redirect(transactionsPath(parsed.returnTo));
}

/* -------------------------------------------------------------------------
 * Stage-1 value-returning actions (ux-overhaul-plan §3.0): every mutation
 * returns {ok, data|error} for toasts/undo/live counts, revalidates
 * /transactions and / (nav badge), and NEVER redirects. The redirect-style
 * actions above stay until the page rewrite consumes these.
 * ---------------------------------------------------------------------- */

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "Unexpected error" };
}

function revalidateTransactions(): void {
  revalidatePath("/transactions");
  revalidatePath("/");
}

function categoryLabelFor(db: AppDatabase, categoryId: string): string {
  const all = db.select().from(categories).all();
  const cat = all.find((c) => c.id === categoryId);
  if (!cat) return "Uncategorized";
  const parent = cat.parentId ? all.find((c) => c.id === cat.parentId) : undefined;
  return parent ? `${parent.name} > ${cat.name}` : cat.name;
}

/**
 * Rule-prompt preview: builds the SAME conditions + predicate the rule will use
 * so the toast's count is exactly the retro-apply blast radius. Keys on the
 * linked merchant when present, else the row's stripped name key — so the
 * "apply to every transaction with this name" offer reaches the ~47% of rows
 * that carry no merchant (brokerage strings, unlinked charges). Returns null
 * only when there is no usable identity (merchantless row whose name strips to
 * nothing — e.g. a pure reference number).
 */
function rulePromptPreview(
  db: AppDatabase,
  transactionId: string,
  categoryId: string,
): RulePromptPreview | null {
  const txn = db
    .select({
      merchantId: transactions.merchantId,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!txn) return null;

  if (txn.merchantId) {
    const merchant = db.select().from(merchants).where(eq(merchants.id, txn.merchantId)).get();
    if (!merchant) return null;
    const conditions = conditionsForCorrection(db, { merchantId: txn.merchantId });
    return {
      target: { kind: "merchant", merchantId: txn.merchantId },
      subjectLabel: merchant.canonicalName,
      categoryLabel: categoryLabelFor(db, categoryId),
      matchCount: countRuleMatches(db, conditions, { excludeUserSet: true }),
    };
  }

  const key = strippedDescriptionKey(txn.normalizedDescription);
  if (key === "") return null;
  const conditions = conditionsForCorrection(db, { descriptionKey: key });
  return {
    target: { kind: "name", descriptionKey: key },
    subjectLabel: humanizeDescriptionKey(key),
    categoryLabel: categoryLabelFor(db, categoryId),
    matchCount: countRuleMatches(db, conditions, { excludeUserSet: true }),
  };
}

const correctCategorySchema = z.object({
  transactionId: z.string().min(1),
  categoryId: z.string().min(1),
});

export async function correctCategory(input: {
  transactionId: string;
  categoryId: string;
}): Promise<ActionResult<CorrectCategoryData>> {
  try {
    const parsed = correctCategorySchema.parse(input);
    const db = getDb();
    const { affected, undo } = bulkApply(db, [parsed.transactionId], {
      categoryId: parsed.categoryId,
    });
    if (affected === 0) throw new Error("Unknown transaction");
    const rulePrompt = rulePromptPreview(db, parsed.transactionId, parsed.categoryId);
    revalidateTransactions();
    return { ok: true, data: { rulePrompt, undo } };
  } catch (error: unknown) {
    return failure(error);
  }
}

/** The rule-able identity of a row: its merchant, else its stripped name key. */
function resolveCorrectionTarget(
  db: AppDatabase,
  transactionId: string,
): { merchantId: string } | { descriptionKey: string } | null {
  const txn = db
    .select({
      merchantId: transactions.merchantId,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!txn) return null;
  if (txn.merchantId) return { merchantId: txn.merchantId };
  const key = strippedDescriptionKey(txn.normalizedDescription);
  return key === "" ? null : { descriptionKey: key };
}

const recategorizeGroupSchema = z.object({
  transactionId: z.string().min(1),
  categoryId: z.string().min(1),
});

/**
 * "Recategorize all N" from the sheet panel: recategorize every row in the
 * server-recomputed name group (past — locked as a user decision) AND create
 * the forward rule (future) in one gesture. The group is recomputed here from
 * the transaction's identity, never taken from the client, so the blast radius
 * is always honest.
 */
export async function recategorizeGroupAction(input: {
  transactionId: string;
  categoryId: string;
}): Promise<ActionResult<RecategorizeGroupData>> {
  try {
    const parsed = recategorizeGroupSchema.parse(input);
    const db = getDb();
    const ids = similarGroupIds(db, parsed.transactionId);
    if (ids.length === 0) throw new Error("No matching transactions to recategorize");
    const { affected, undo } = bulkApply(db, ids, { categoryId: parsed.categoryId });
    // future imports of this same name should land here too
    const target = resolveCorrectionTarget(db, parsed.transactionId);
    const ruleId = target
      ? ruleFromCorrection(db, { ...target, categoryId: parsed.categoryId }).id
      : null;
    revalidateTransactions();
    return { ok: true, data: { affected, undo, ruleId } };
  } catch (error: unknown) {
    return failure(error);
  }
}

const bulkApplySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  patch: txnPatchSchema,
});

export async function bulkApplyAction(input: {
  ids: string[];
  patch: TxnPatch;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = bulkApplySchema.parse(input);
    const result = bulkApply(getDb(), parsed.ids, parsed.patch);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

// the filter set travels as raw searchParams — parseFilters is the same
// defensive boundary the page itself uses, so URL and action can never drift
const searchParamsSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string()), z.undefined()]),
);

const bulkApplyByFilterSchema = z.object({
  params: searchParamsSchema,
  patch: txnPatchSchema,
});

export async function bulkApplyByFilterAction(input: {
  params: SearchParams;
  patch: TxnPatch;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = bulkApplyByFilterSchema.parse(input);
    const filters = parseFilters(parsed.params);
    const result = bulkApplyByFilter(getDb(), filters, filters.view, parsed.patch);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

const setFlagsSchema = z.object({
  transactionId: z.string().min(1),
  flags: txnFlagsSchema,
});

export async function setFlagsAction(input: {
  transactionId: string;
  flags: TxnFlags;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = setFlagsSchema.parse(input);
    const result = setTransactionFlags(getDb(), parsed.transactionId, parsed.flags);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

export async function markAllReviewedBeforeAction(
  date: string,
): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = z.string().min(1).parse(date);
    const result = markAllReviewedBefore(getDb(), parsed);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

/* -------------------------------------------------------------------------
 * Review inbox (§3.3): cluster confirm/recategorize. The ref is an opaque
 * handle — the service recomputes the live id set from it, so the blast
 * radius stays honest even if the queue shifted between load and click.
 * ---------------------------------------------------------------------- */

export async function confirmClusterAction(ref: ClusterRef): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = clusterRefSchema.parse(ref);
    const result = confirmCluster(getDb(), parsed);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

const recategorizeClusterSchema = z.object({
  ref: clusterRefSchema,
  categoryId: z.string().min(1),
});

export async function recategorizeClusterAction(input: {
  ref: ClusterRef;
  categoryId: string;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = recategorizeClusterSchema.parse(input);
    const result = recategorizeCluster(getDb(), parsed.ref, parsed.categoryId);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

const createRuleSchema = z
  .object({
    merchantId: z.string().min(1).optional(),
    descriptionContains: z.string().min(1).optional(),
    descriptionKey: z.string().min(1).optional(),
    categoryId: z.string().min(1),
  })
  .refine(
    (v) =>
      v.merchantId !== undefined ||
      v.descriptionContains !== undefined ||
      v.descriptionKey !== undefined,
    { message: "A merchant, a name key, or a description fragment is required" },
  );

export async function createRuleAction(input: {
  merchantId?: string;
  descriptionContains?: string;
  descriptionKey?: string;
  categoryId: string;
}): Promise<ActionResult<CreatedRuleData>> {
  try {
    const parsed = createRuleSchema.parse(input);
    const db = getDb();
    const rule = ruleFromCorrection(db, parsed);
    const matchCount = countRuleMatches(db, rule.conditions, { excludeUserSet: true });
    revalidateTransactions();
    return {
      ok: true,
      data: { ruleId: rule.id, name: rule.name, priority: rule.priority, matchCount },
    };
  } catch (error: unknown) {
    return failure(error);
  }
}

export async function retroApplyRuleAction(
  ruleId: string,
): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = z.string().min(1).parse(ruleId);
    const result = retroApplyRule(getDb(), parsed);
    revalidateTransactions();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error);
  }
}

const undoOptionsSchema = z
  .object({ deleteRuleId: z.string().min(1).optional() })
  .strict()
  .optional();

export async function undoAction(
  undo: UndoPatch,
  options?: { deleteRuleId?: string },
): Promise<ActionResult<{ restored: number; ruleDeleted: boolean }>> {
  try {
    const parsedUndo = undoPatchSchema.parse(undo);
    const parsedOptions = undoOptionsSchema.parse(options);
    const db = getDb();
    const restored = applyUndoPatch(db, parsedUndo);
    // undoing an accepted rule prompt reverts the rule itself too (§3.0)
    const ruleDeleted = parsedOptions?.deleteRuleId
      ? deleteRule(db, parsedOptions.deleteRuleId)
      : false;
    revalidateTransactions();
    return { ok: true, data: { restored, ruleDeleted } };
  } catch (error: unknown) {
    return failure(error);
  }
}

const renameMerchantSchema = z.object({
  merchantId: z.string().min(1),
  newName: z.string().min(1).max(80),
});

export async function renameMerchantAction(input: {
  merchantId: string;
  newName: string;
}): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const parsed = renameMerchantSchema.parse(input);
    const result = renameMerchant(getDb(), parsed.merchantId, parsed.newName);
    revalidateTransactions();
    return { ok: true, data: { id: result.id, name: result.name } };
  } catch (error: unknown) {
    return failure(error);
  }
}

export async function addManualTransactionAction(
  input: ManualTxnInput,
): Promise<ActionResult<{ transactionId: string }>> {
  try {
    const parsed = manualTxnInputSchema.parse(input);
    const transactionId = addManualTransaction(getDb(), parsed);
    revalidateTransactions();
    revalidatePath("/accounts");
    return { ok: true, data: { transactionId } };
  } catch (error: unknown) {
    return failure(error);
  }
}

const linkTransferSchema = z.object({ aId: z.string().min(1), bId: z.string().min(1) });

/** Pair two transactions as one transfer (S5) — lossless undo via the shared patch. */
export async function linkTransferAction(input: {
  aId: string;
  bId: string;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = linkTransferSchema.parse(input);
    const result = linkTransferPair(getDb(), parsed.aId, parsed.bId);
    revalidateTransactions();
    return { ok: true, data: { affected: result.affected, undo: result.undo } };
  } catch (error: unknown) {
    return failure(error);
  }
}

/** Dissolve a transfer group (S5) — legs keep their category, only the link clears. */
export async function unlinkTransferAction(input: {
  groupId: string;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    if (!input.groupId) throw new Error("Unknown transfer group");
    const result = unlinkTransferGroup(getDb(), input.groupId);
    revalidateTransactions();
    return { ok: true, data: { affected: result.affected, undo: result.undo } };
  } catch (error: unknown) {
    return failure(error);
  }
}

/** Edit a MANUAL row's date / amount / description inline (S4) — rebuilds balances. */
export async function editManualTransactionAction(input: {
  transactionId: string;
  patch: ManualTxnEdit;
}): Promise<ActionResult<{ transactionId: string }>> {
  try {
    const patch = manualTxnEditSchema.parse(input.patch);
    if (!input.transactionId) throw new Error("Unknown transaction");
    editManualTransaction(getDb(), input.transactionId, patch);
    revalidateTransactions();
    revalidatePath("/accounts");
    revalidatePath("/");
    return { ok: true, data: { transactionId: input.transactionId } };
  } catch (error: unknown) {
    return failure(error);
  }
}

/* Transaction splitting (RocketMoney-style) ------------------------------- */

/** Splits change category analytics on /spending, /budgets and /categories too. */
function revalidateAfterSplit(): void {
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/spending");
  revalidatePath("/budgets");
}

const splitLineInputSchema = z.object({
  categoryId: z.string().min(1),
  amountCents: z.number().int(),
});

const setSplitsInputSchema = z.object({
  transactionId: z.string().min(1),
  lines: z.array(splitLineInputSchema).min(2),
});

const splitSnapshotSchema = z.object({
  transactionId: z.string().min(1),
  parent: z.object({
    needsReview: z.boolean(),
    categoryId: z.string().nullable(),
    categorizationSource: z.enum(CATEGORIZATION_SOURCES).nullable(),
    categorizationConfidence: z.number().nullable(),
  }),
  lines: z.array(
    z.object({
      categoryId: z.string().min(1),
      amountCents: z.number().int(),
      note: z.string().nullable(),
      sortOrder: z.number().int(),
    }),
  ),
});

/** Replace a transaction's category-allocation splits (the invariant is enforced
 *  in the service). Returns the prior state so the caller can offer Undo. */
export async function setSplitsAction(input: {
  transactionId: string;
  lines: { categoryId: string; amountCents: number }[];
}): Promise<ActionResult<{ snapshot: SplitSnapshot }>> {
  try {
    const parsed = setSplitsInputSchema.parse(input);
    const snapshot = setSplits(getDb(), parsed.transactionId, parsed.lines);
    revalidateAfterSplit();
    return { ok: true, data: { snapshot } };
  } catch (error: unknown) {
    return failure(error);
  }
}

/** Remove all splits from a transaction (un-split). Returns the prior state for Undo. */
export async function clearSplitsAction(input: {
  transactionId: string;
}): Promise<ActionResult<{ snapshot: SplitSnapshot }>> {
  try {
    const id = z.string().min(1).parse(input.transactionId);
    const snapshot = clearSplits(getDb(), id);
    revalidateAfterSplit();
    return { ok: true, data: { snapshot } };
  } catch (error: unknown) {
    return failure(error);
  }
}

/** Restore a transaction's splits to a prior snapshot — the Undo for set/clear. */
export async function restoreSplitsAction(
  snapshot: SplitSnapshot,
): Promise<ActionResult<Record<string, never>>> {
  try {
    const parsed = splitSnapshotSchema.parse(snapshot);
    restoreSplits(getDb(), parsed);
    revalidateAfterSplit();
    return { ok: true, data: {} };
  } catch (error: unknown) {
    return failure(error);
  }
}
