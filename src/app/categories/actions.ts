"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { moveCategory, renameCategory } from "@/services/category-edit";
import {
  actionErrorMessage,
  firstIssueMessage,
  type ActionResult,
} from "@/app/transactions/action-types";

// category-edit runs its own `.parse()`, so a ZodError can surface from the
// service — actionErrorMessage unwraps it instead of dumping the issue array
const CATEGORY_LABELS = {
  categoryId: "Category",
  name: "Name",
  newParentId: "New parent",
  parentId: "Parent",
} as const;

const renameCategoryActionSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1, "Name the category").max(60, "Keep it to 60 characters or fewer"),
});

/** Inline category rename (S3) — value-returning for optimistic UI + Undo. */
export async function renameCategoryAction(input: {
  categoryId: string;
  name: string;
}): Promise<ActionResult<{ id: string; name: string }>> {
  const parsed = renameCategoryActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name" };
  }
  try {
    const result = renameCategory(getDb(), parsed.data.categoryId, parsed.data.name);
    // category names render on the dashboard, spending, budgets, the ledger,
    // and the category page itself — refresh them all
    revalidatePath("/");
    revalidatePath("/spending");
    revalidatePath("/budgets");
    revalidatePath("/transactions");
    revalidatePath(`/categories/${result.id}`);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, CATEGORY_LABELS, "Could not rename category") };
  }
}

const moveCategoryActionSchema = z.object({
  categoryId: z.string().min(1),
  newParentId: z.string().min(1).nullable(),
});

/** Re-parent a category (S7 "movable") — value-returning for optimistic UI + Undo. */
export async function moveCategoryAction(input: {
  categoryId: string;
  newParentId: string | null;
}): Promise<ActionResult<{ id: string; parentId: string | null }>> {
  const parsed = moveCategoryActionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: firstIssueMessage(
        parsed.error.issues,
        { categoryId: "Category", newParentId: "New parent" },
        "Invalid destination",
      ),
    };
  }
  try {
    const result = moveCategory(getDb(), parsed.data.categoryId, parsed.data.newParentId);
    revalidatePath("/");
    revalidatePath("/spending");
    revalidatePath("/budgets");
    revalidatePath("/transactions");
    revalidatePath(`/categories/${result.id}`);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, CATEGORY_LABELS, "Could not move category") };
  }
}
