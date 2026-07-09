"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { applyCorrection, categorizeAll, detectTransfers } from "@/services/categorize";
import { classifyPendingMerchants } from "@/services/claude-categorize";
import type { TxnNotice } from "@/components/transactions/query";

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
