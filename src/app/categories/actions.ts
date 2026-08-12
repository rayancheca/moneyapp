"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  archiveCategory,
  createCategory,
  CREATABLE_CATEGORY_KINDS,
  moveCategory,
  renameCategory,
  reorderCategories,
  unarchiveCategory,
} from "@/services/category-edit";
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

/**
 * Every surface that renders a category name or picker. Kept in one place so a
 * create/archive refreshes exactly what a rename already does — plus /recurring
 * and /accounts, whose pickers list categories too.
 */
function revalidateCategorySurfaces(categoryId?: string): void {
  revalidatePath("/");
  revalidatePath("/spending");
  revalidatePath("/budgets");
  revalidatePath("/transactions");
  revalidatePath("/recurring");
  revalidatePath("/categories");
  if (categoryId) revalidatePath(`/categories/${categoryId}`);
}

const createCategoryActionSchema = z
  .object({
    name: z.string().trim().min(1, "Name the category").max(60, "Keep it to 60 characters or fewer"),
    parentId: z.string().min(1).nullable().optional(),
    kind: z.enum(CREATABLE_CATEGORY_KINDS).optional(),
  })
  .refine((v) => (v.parentId ?? null) !== null || v.kind !== undefined, {
    message: "Pick what kind of category this is",
    path: ["kind"],
  });

/** Create a category — top-level (needs a kind) or a subcategory (inherits its parent's). */
export async function createCategoryAction(input: {
  name: string;
  parentId?: string | null;
  kind?: (typeof CREATABLE_CATEGORY_KINDS)[number];
}): Promise<ActionResult<{ id: string; name: string; parentId: string | null }>> {
  const parsed = createCategoryActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, CATEGORY_LABELS, "Invalid category") };
  }
  try {
    const result = createCategory(getDb(), {
      name: parsed.data.name,
      parentId: parsed.data.parentId ?? null,
      kind: parsed.data.kind,
    });
    revalidateCategorySurfaces(result.id);
    return { ok: true, data: { id: result.id, name: result.name, parentId: result.parentId } };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, CATEGORY_LABELS, "Could not create category") };
  }
}

const reorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(2, "Nothing to reorder"),
});

/**
 * Persist a manual sibling order. Revalidates the SAME surface set as every other
 * category write — `sort_order` is read by the budget form, the transaction
 * category picker and the command index, so a reorder that only refreshed
 * /categories would leave three other screens showing the old sequence.
 */
export async function reorderCategoriesAction(input: {
  orderedIds: string[];
}): Promise<ActionResult<{ count: number }>> {
  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, CATEGORY_LABELS) };
  }
  try {
    reorderCategories(getDb(), parsed.data.orderedIds);
    revalidateCategorySurfaces();
    return { ok: true, data: { count: parsed.data.orderedIds.length } };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, CATEGORY_LABELS, "Could not reorder categories") };
  }
}

const categoryIdSchema = z.object({ categoryId: z.string().min(1) });

/** Archive (never delete — history keeps resolving through the id). */
export async function archiveCategoryAction(input: {
  categoryId: string;
}): Promise<ActionResult<{ id: string; isArchived: boolean }>> {
  const parsed = categoryIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a category" };
  try {
    const result = archiveCategory(getDb(), parsed.data.categoryId);
    revalidateCategorySurfaces(result.id);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, CATEGORY_LABELS, "Could not archive category") };
  }
}

export async function unarchiveCategoryAction(input: {
  categoryId: string;
}): Promise<ActionResult<{ id: string; isArchived: boolean }>> {
  const parsed = categoryIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a category" };
  try {
    const result = unarchiveCategory(getDb(), parsed.data.categoryId);
    revalidateCategorySurfaces(result.id);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, CATEGORY_LABELS, "Could not restore category") };
  }
}
