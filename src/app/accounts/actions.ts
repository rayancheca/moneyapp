"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ACCOUNT_TYPES } from "@/db/schema/accounts";
import { parseAmountToCents } from "@/lib/money";
import {
  createAccount,
  createInstitution,
  editAccount,
  reorderAccounts,
  updateAccount,
} from "@/services/accounts";
import { addManualAnchor, deleteAnchor } from "@/services/anchors";
import type { ActionResult } from "@/app/transactions/action-types";

const createAccountFormSchema = z.object({
  institutionId: z.string().min(1, "Pick an institution"),
  name: z.string().trim().min(1, "Name the account"),
  type: z.enum(ACCOUNT_TYPES),
  last4: z.string().trim().optional(),
  subtype: z.enum(["brokerage", "crypto"]).optional(),
  initialBalance: z.string().trim().optional(),
});

export async function createAccountAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = createAccountFormSchema.parse({
    institutionId: raw.institutionId,
    name: raw.name,
    type: raw.type,
    last4: typeof raw.last4 === "string" && raw.last4 !== "" ? raw.last4 : undefined,
    subtype: typeof raw.subtype === "string" && raw.subtype !== "" ? raw.subtype : undefined,
    initialBalance:
      typeof raw.initialBalance === "string" && raw.initialBalance !== ""
        ? raw.initialBalance
        : undefined,
  });

  const db = getDb();
  const accountId = createAccount(db, {
    institutionId: parsed.institutionId,
    name: parsed.name,
    type: parsed.type,
    subtype: parsed.type === "investment" ? (parsed.subtype ?? "brokerage") : undefined,
    last4: parsed.last4 && /^\d{4}$/.test(parsed.last4) ? parsed.last4 : undefined,
  });

  if (parsed.initialBalance) {
    const { todayIso } = await import("@/lib/dates");
    addManualAnchor(db, {
      accountId,
      anchoredOn: todayIso(),
      enteredCents: parseAmountToCents(parsed.initialBalance),
    });
  }

  revalidatePath("/");
  revalidatePath("/accounts");
  redirect(`/accounts/${accountId}`);
}

const anchorFormSchema = z.object({
  accountId: z.string().min(1),
  anchoredOn: z.string().min(10),
  balance: z.string().trim().min(1, "Enter a balance"),
});

export async function addAnchorAction(formData: FormData): Promise<void> {
  const parsed = anchorFormSchema.parse(Object.fromEntries(formData.entries()));
  addManualAnchor(getDb(), {
    accountId: parsed.accountId,
    anchoredOn: parsed.anchoredOn,
    enteredCents: parseAmountToCents(parsed.balance),
  });
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.accountId}`);
}

export async function deleteAnchorAction(formData: FormData): Promise<void> {
  const anchorId = formData.get("anchorId");
  const accountId = formData.get("accountId");
  if (typeof anchorId !== "string" || typeof accountId !== "string") return;
  deleteAnchor(getDb(), anchorId);
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
}

export async function setAccountActiveAction(formData: FormData): Promise<void> {
  const accountId = formData.get("accountId");
  const isActive = formData.get("isActive") === "true";
  if (typeof accountId !== "string") return;
  updateAccount(getDb(), accountId, { isActive });
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
}

// ── Manage accounts (§7.2): value-returning actions the client drives ─────────

const editAccountActionSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1, "Name the account"),
  institutionId: z.string().min(1, "Pick an institution"),
  last4: z.string().trim().optional(),
});

/** Edit an account's name / institution / last4 (the edit sheet). */
export async function editAccountAction(input: {
  accountId: string;
  name: string;
  institutionId: string;
  last4?: string;
}): Promise<ActionResult<{ id: string }>> {
  const parsed = editAccountActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid account details" };
  }
  const last4 = parsed.data.last4 && parsed.data.last4 !== "" ? parsed.data.last4 : null;
  if (last4 !== null && !/^\d{4}$/.test(last4)) {
    return { ok: false, error: "Last 4 must be four digits (or blank)" };
  }
  try {
    editAccount(getDb(), parsed.data.accountId, {
      name: parsed.data.name,
      institutionId: parsed.data.institutionId,
      last4,
    });
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save account" };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.accountId}`);
  return { ok: true, data: { id: parsed.data.accountId } };
}

const renameAccountActionSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1, "Name the account").max(80, "Keep it to 80 characters or fewer"),
});

/**
 * Value-returning rename for the inline <InlineEditableText> on the account
 * detail page (the "nothing read-only" primitive). Name-only — institution and
 * last4 stay with the edit sheet. Reuses updateAccount's validated partial set.
 */
export async function renameAccountAction(input: {
  accountId: string;
  name: string;
}): Promise<ActionResult<{ id: string; name: string }>> {
  const parsed = renameAccountActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name" };
  }
  try {
    updateAccount(getDb(), parsed.data.accountId, { name: parsed.data.name });
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not rename account" };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.accountId}`);
  return { ok: true, data: { id: parsed.data.accountId, name: parsed.data.name } };
}

/** Find-or-create an institution inline, returning its id for the select. */
export async function createInstitutionAction(name: string): Promise<ActionResult<{ id: string }>> {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") return { ok: false, error: "Name the institution" };
  try {
    const id = createInstitution(getDb(), trimmed);
    revalidatePath("/accounts");
    return { ok: true, data: { id } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not add institution" };
  }
}

/** Persist a drag-reorder within an institution (writes displayOrder). */
export async function reorderAccountsAction(orderedIds: string[]): Promise<ActionResult<null>> {
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
    return { ok: false, error: "Invalid order" };
  }
  try {
    reorderAccounts(getDb(), orderedIds);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reorder accounts" };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  return { ok: true, data: null };
}
