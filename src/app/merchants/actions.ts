"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  applyMerchantDefaultToUncategorized,
  setMerchantDefaultCategory,
} from "@/services/merchants";
import {
  actionErrorMessage,
  firstIssueMessage,
  type ActionResult,
  type BulkMutationData,
} from "@/app/transactions/action-types";

// the merchants service runs its own `.parse()`, so a ZodError can surface from
// inside it — actionErrorMessage unwraps it instead of dumping the issue array
const MERCHANT_LABELS = { merchantId: "Merchant", categoryId: "Category" } as const;

const setDefaultSchema = z.object({
  merchantId: z.string("Pick a merchant").min(1, "Pick a merchant"),
  categoryId: z.string().min(1, "Pick a category").nullable(),
});

/** Set (or clear) the merchant→category rule — future imports follow it (S6). */
export async function setMerchantDefaultCategoryAction(input: {
  merchantId: string;
  categoryId: string | null;
}): Promise<ActionResult<{ id: string; categoryId: string | null }>> {
  const parsed = setDefaultSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, MERCHANT_LABELS) };
  }
  try {
    const result = setMerchantDefaultCategory(getDb(), parsed.data.merchantId, parsed.data.categoryId);
    revalidatePath(`/merchants/${parsed.data.merchantId}`);
    revalidatePath("/transactions");
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, MERCHANT_LABELS, "Could not set the default") };
  }
}

const applyDefaultSchema = z.object({
  merchantId: z.string("Pick a merchant").min(1, "Pick a merchant"),
});

/** Backfill this merchant's uncategorized rows with its default — lossless undo. */
export async function applyMerchantDefaultAction(input: {
  merchantId: string;
}): Promise<ActionResult<BulkMutationData>> {
  const parsed = applyDefaultSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, MERCHANT_LABELS) };
  }
  try {
    const result = applyMerchantDefaultToUncategorized(getDb(), input.merchantId);
    revalidatePath(`/merchants/${input.merchantId}`);
    revalidatePath("/transactions");
    revalidatePath("/spending");
    return { ok: true, data: { affected: result.affected, undo: result.undo } };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, MERCHANT_LABELS, "Could not apply the default") };
  }
}
