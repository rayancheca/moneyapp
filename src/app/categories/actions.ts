"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { renameCategory } from "@/services/category-edit";
import type { ActionResult } from "@/app/transactions/action-types";

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
    return { ok: false, error: error instanceof Error ? error.message : "Could not rename category" };
  }
}
