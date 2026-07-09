"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ACCOUNT_TYPES } from "@/db/schema/accounts";
import { parseAmountToCents } from "@/lib/money";
import { createAccount, updateAccount } from "@/services/accounts";
import { addManualAnchor, deleteAnchor } from "@/services/anchors";

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
