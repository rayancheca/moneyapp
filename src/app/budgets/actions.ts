"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { firstIssueMessage, type ActionResult } from "@/app/transactions/action-types";
import { getDb } from "@/db/client";
import { BUDGET_PERIODS } from "@/db/schema/budgets";
import { MoneyParseError, parseAmountToCents } from "@/lib/money";
import { createBudget, deactivateBudget, setBudgetRollover, updateBudget } from "@/services/budgets";
import { predictBudgets, type PredictedBudget } from "@/services/category-forecast";

// the single-argument form reports the SAME message when the field is missing
// entirely, instead of zod's "expected string, received null"
const createBudgetFormSchema = z.object({
  categoryId: z.string("Pick a category").min(1, "Pick a category"),
  period: z.enum(BUDGET_PERIODS),
  amount: z.string("Enter a budget amount").trim().min(1, "Enter a budget amount"),
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

const BUDGET_LABELS = {
  categoryId: "Category",
  period: "Period",
  amount: "Amount",
} as const;

/**
 * Validating core of the create-budget form. The `Promise<void>` export below
 * keeps its signature byte-identical — React types `<form action>` as
 * `(formData) => void | Promise<void>`, so a result cannot be returned from it
 * without breaking the call site — and forwards a failure to `?error=`, which
 * /budgets already renders.
 */
export async function createBudgetResultAction(
  formData: FormData,
): Promise<ActionResult<{ categoryId: string; amountCents: number }>> {
  const parsed = createBudgetFormSchema.safeParse({
    categoryId: formData.get("categoryId"),
    period: formData.get("period"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, BUDGET_LABELS) };
  }
  let amountCents: number;
  try {
    amountCents = parseAmountToCents(parsed.data.amount);
  } catch (error: unknown) {
    return { ok: false, error: friendlyMessage(error) };
  }
  if (amountCents <= 0) return { ok: false, error: "Budget amount must be positive" };
  try {
    createBudget(getDb(), {
      categoryId: parsed.data.categoryId,
      period: parsed.data.period,
      amountCents,
    });
  } catch (error: unknown) {
    return { ok: false, error: friendlyMessage(error) };
  }
  revalidatePath("/budgets");
  return { ok: true, data: { categoryId: parsed.data.categoryId, amountCents } };
}

export async function createBudgetAction(formData: FormData): Promise<void> {
  const result = await createBudgetResultAction(formData);
  // a failed attempt still revalidates so the page it lands on is fresh
  if (!result.ok) revalidatePath("/budgets");
  // redirect() throws NEXT_REDIRECT by design — it must stay outside any catch
  redirect(result.ok ? "/budgets" : `/budgets?error=${encodeURIComponent(result.error)}`);
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
    return { ok: false, error: friendlyMessage(error) };
  }
  revalidatePath("/budgets");
  return { ok: true, data: { id: parsed.data.budgetId, amountCents } };
}

const setRolloverSchema = z.object({
  budgetId: z.string().min(1),
  enabled: z.boolean(),
});

/**
 * Turn a budget's rollover on or off. Amount, start and cap are deliberately not
 * settable here — the toggle is the whole gesture, and `setBudgetRollover`
 * refuses a start date earlier than the budget itself.
 */
export async function setBudgetRolloverAction(input: {
  budgetId: string;
  enabled: boolean;
}): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  const parsed = setRolloverSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    setBudgetRollover(getDb(), parsed.data.budgetId, { enabled: parsed.data.enabled });
  } catch (error: unknown) {
    return { ok: false, error: friendlyMessage(error) };
  }
  revalidatePath("/budgets");
  revalidatePath("/categories");
  return { ok: true, data: { id: parsed.data.budgetId, enabled: parsed.data.enabled } };
}

const deactivateSchema = z.object({
  budgetId: z.string("Pick a budget").min(1, "Pick a budget"),
});

export async function deactivateBudgetResultAction(
  formData: FormData,
): Promise<ActionResult<{ budgetId: string }>> {
  const parsed = deactivateSchema.safeParse({ budgetId: formData.get("budgetId") });
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, { budgetId: "Budget" }) };
  }
  try {
    deactivateBudget(getDb(), parsed.data.budgetId);
  } catch (error: unknown) {
    return { ok: false, error: friendlyMessage(error) };
  }
  revalidatePath("/budgets");
  return { ok: true, data: { budgetId: parsed.data.budgetId } };
}

export async function deactivateBudgetAction(formData: FormData): Promise<void> {
  const result = await deactivateBudgetResultAction(formData);
  if (!result.ok) revalidatePath("/budgets");
  redirect(result.ok ? "/budgets" : `/budgets?error=${encodeURIComponent(result.error)}`);
}

/** Load next-month budget PREDICTIONS (recurring bills + trend/seasonal estimate). */
export async function predictBudgetsAction(): Promise<ActionResult<PredictedBudget[]>> {
  try {
    return { ok: true, data: predictBudgets(getDb()) };
  } catch (error: unknown) {
    return { ok: false, error: friendlyMessage(error) };
  }
}

const createPredictedSchema = z
  .array(z.object({ categoryId: z.string().min(1), amountCents: z.number().int().positive() }))
  .min(1, "Pick at least one prediction");

/**
 * Create the picked predictions as MONTHLY budgets — each through the same
 * createBudget path the form uses (expense-only + one-active-per-period
 * enforced). Per-item failures are reported, never silently dropped.
 */
export async function createPredictedBudgetsAction(
  input: { categoryId: string; amountCents: number }[],
): Promise<ActionResult<{ created: number; errors: string[] }>> {
  const parsed = createPredictedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: friendlyMessage(parsed.error) };
  const db = getDb();
  let created = 0;
  const errors: string[] = [];
  for (const s of parsed.data) {
    try {
      createBudget(db, { categoryId: s.categoryId, period: "monthly", amountCents: s.amountCents });
      created += 1;
    } catch (error: unknown) {
      errors.push(friendlyMessage(error));
    }
  }
  if (created > 0) {
    revalidatePath("/budgets");
    revalidatePath("/");
  }
  return { ok: true, data: { created, errors } };
}
