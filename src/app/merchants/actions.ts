"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  applyMerchantDefaultToUncategorized,
  setMerchantDefaultCategory,
} from "@/services/merchants";
import type { ActionResult, BulkMutationData } from "@/app/transactions/action-types";

const setDefaultSchema = z.object({
  merchantId: z.string().min(1),
  categoryId: z.string().min(1).nullable(),
});

/** Set (or clear) the merchant→category rule — future imports follow it (S6). */
export async function setMerchantDefaultCategoryAction(input: {
  merchantId: string;
  categoryId: string | null;
}): Promise<ActionResult<{ id: string; categoryId: string | null }>> {
  const parsed = setDefaultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid category" };
  try {
    const result = setMerchantDefaultCategory(getDb(), parsed.data.merchantId, parsed.data.categoryId);
    revalidatePath(`/merchants/${parsed.data.merchantId}`);
    revalidatePath("/transactions");
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not set the default" };
  }
}

/** Backfill this merchant's uncategorized rows with its default — lossless undo. */
export async function applyMerchantDefaultAction(input: {
  merchantId: string;
}): Promise<ActionResult<BulkMutationData>> {
  try {
    if (!input.merchantId) throw new Error("Unknown merchant");
    const result = applyMerchantDefaultToUncategorized(getDb(), input.merchantId);
    revalidatePath(`/merchants/${input.merchantId}`);
    revalidatePath("/transactions");
    revalidatePath("/spending");
    return { ok: true, data: { affected: result.affected, undo: result.undo } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not apply the default" };
  }
}
