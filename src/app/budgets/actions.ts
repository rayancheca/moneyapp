"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/app/transactions/action-types";
import { getDb } from "@/db/client";
import { BUDGET_PERIODS } from "@/db/schema/budgets";
import { MoneyParseError, parseAmountToCents } from "@/lib/money";
import { createBudget, deactivateBudget, updateBudget } from "@/services/budgets";

const createBudgetFormSchema = z.object({
  categoryId: z.string().min(1, "Pick a category"),
  period: z.enum(BUDGET_PERIODS),
  amount: z.string().trim().min(1, "Enter a budget amount"),
});

function friendlyMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid input";
  }
  if (error instanceof MoneyParseError) {
    return `That amount didn't parse — try something like 250 or 1,250.00`;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

export async function createBudgetAction(formData: FormData): Promise<void> {
  let message: string | null = null;
  try {
    const parsed = createBudgetFormSchema.parse({
      categoryId: formData.get("categoryId"),
      period: formData.get("period"),
      amount: formData.get("amount"),
    });
    const amountCents = parseAmountToCents(parsed.amount);
    if (amountCents <= 0) throw new Error("Budget amount must be positive");
    createBudget(getDb(), {
      categoryId: parsed.categoryId,
      period: parsed.period,
      amountCents,
    });
  } catch (error: unknown) {
    message = friendlyMessage(error);
  }
  revalidatePath("/budgets");
  redirect(message ? `/budgets?error=${encodeURIComponent(message)}` : "/budgets");
}

const updateAmountSchema = z.object({
  budgetId: z.string().min(1),
  amount: z.string().trim().min(1, "Enter a budget amount"),
});

/**
 * Inline amount edit (ux-overhaul §8) — kills deactivate-and-recreate. Returns
 * a result instead of redirecting so the row can update in place with a toast.
 */
export async function updateBudgetAmountAction(input: {
  budgetId: string;
  amount: string;
}): Promise<ActionResult<{ id: string; amountCents: number }>> {
  const parsed = updateAmountSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  let amountCents: number;
  try {
    amountCents = parseAmountToCents(parsed.data.amount);
  } catch (error: unknown) {
    if (error instanceof MoneyParseError) {
      return { ok: false, error: "That amount didn't parse — try 250 or 1,250.00" };
    }
    return { ok: false, error: "Could not read that amount" };
  }
  if (amountCents <= 0) return { ok: false, error: "Budget amount must be positive" };
  try {
    updateBudget(getDb(), parsed.data.budgetId, { amountCents });
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not update budget" };
  }
  revalidatePath("/budgets");
  return { ok: true, data: { id: parsed.data.budgetId, amountCents } };
}

const deactivateSchema = z.object({ budgetId: z.string().min(1) });

export async function deactivateBudgetAction(formData: FormData): Promise<void> {
  let message: string | null = null;
  try {
    const parsed = deactivateSchema.parse({ budgetId: formData.get("budgetId") });
    deactivateBudget(getDb(), parsed.budgetId);
  } catch (error: unknown) {
    message = friendlyMessage(error);
  }
  revalidatePath("/budgets");
  redirect(message ? `/budgets?error=${encodeURIComponent(message)}` : "/budgets");
}
