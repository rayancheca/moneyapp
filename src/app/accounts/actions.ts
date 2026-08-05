"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ACCOUNT_TYPES, ACCOUNT_SUBTYPES } from "@/db/schema/accounts";
import {
  createAccount,
  createInstitution,
  editAccount,
  getAccount,
  reorderAccounts,
  updateAccount,
} from "@/services/accounts";
import { addManualAnchor, deleteAnchor } from "@/services/anchors";
import { cashWalletInstitutionId } from "@/services/manual-transactions";
import { todayIso } from "@/lib/dates";
import {
  actionErrorMessage,
  firstIssueMessage,
  parseAmountField,
  type ActionResult,
} from "@/app/transactions/action-types";

/**
 * Every form action on this surface has a `*ResultAction` twin that validates
 * with safeParse and RETURNS an {@link ActionResult}; the `Promise<void>` export
 * the `<form action>` binding still needs is a thin adapter over it that carries
 * a failure to `?error=` (the /budgets pattern) instead of throwing. Keeping the
 * void signature byte-identical is deliberate — React types `action` as
 * `(formData) => void | Promise<void>`, so returning a result from these would
 * not compile at the call site.
 */
const ACCOUNT_LABELS = {
  institutionId: "Institution",
  name: "Name",
  type: "Account type",
  last4: "Last 4",
  subtype: "Subtype",
  initialBalance: "Initial balance",
} as const;

const ANCHOR_LABELS = {
  accountId: "Account",
  anchoredOn: "Date",
  balance: "Balance",
} as const;

/**
 * Union of the two maps above, for the catch blocks: the services these actions
 * call (createAccount, addManualAnchor, editAccount…) run their OWN `.parse()`,
 * so a ZodError can surface from inside them — and a ZodError's own `.message`
 * is a JSON dump of the issue array, not a sentence.
 */
const ACCOUNT_FIELD_LABELS = {
  ...ACCOUNT_LABELS,
  ...ANCHOR_LABELS,
  anchorId: "Balance entry",
  enteredCents: "Balance",
  paymentSourceAccountId: "Payment source",
} as const;

const createAccountFormSchema = z.object({
  institutionId: z.string("Pick an institution").min(1, "Pick an institution"),
  name: z.string("Name the account").trim().min(1, "Name the account"),
  type: z.enum(ACCOUNT_TYPES),
  last4: z.string().trim().optional(),
  subtype: z.enum(["brokerage", "crypto"]).optional(),
  initialBalance: z.string().trim().optional(),
});

/** Validating core of the create-account form. */
export async function createAccountResultAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = createAccountFormSchema.safeParse({
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
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, ACCOUNT_LABELS) };
  }

  // Parse the opening balance BEFORE the insert: it used to be read after the
  // account existed, so a typo'd amount threw and left an orphan account behind.
  let openingCents: number | null = null;
  if (parsed.data.initialBalance) {
    const amount = parseAmountField(ACCOUNT_LABELS.initialBalance, parsed.data.initialBalance);
    if (!amount.ok) return amount;
    openingCents = amount.data;
  }

  const db = getDb();

  // This form anchors the opening balance on TODAY, which is right for a bank
  // account (the number you read off the app is today's) and wrong for a cash
  // wallet (the number you counted is an OPENING, and its history replays
  // forward from there). A wallet minted here would freeze its displayed
  // balance at the anchor for every entry dated today or earlier — the owner
  // would add spending and watch the number not move. Send them to the wallet
  // form, which asks for an opening DATE, instead of silently mis-anchoring.
  const cashId = cashWalletInstitutionId(db);
  if (cashId !== null && parsed.data.institutionId === cashId) {
    return {
      ok: false,
      error:
        'Use "New cash wallet" for cash — it opens on a date, and its balance replays from your entries',
    };
  }

  let accountId: string;
  try {
    // One transaction: the account and its opening anchor commit together or
    // not at all. They used to be two loose writes, so an anchor that threw
    // left an account behind that the owner was told had not been created.
    // Safe to nest (better-sqlite3 downgrades to a SAVEPOINT), and this cannot
    // reach withPreMutationSnapshot — that VACUUM INTO throws inside an open
    // transaction, but the id here is brand new so addManualAnchor's
    // `overwrites` branch is unreachable. Same reasoning as createCashWallet.
    accountId = db.transaction(() => {
      const id = createAccount(db, {
        institutionId: parsed.data.institutionId,
        name: parsed.data.name,
        type: parsed.data.type,
        subtype:
          parsed.data.type === "investment" ? (parsed.data.subtype ?? "brokerage") : undefined,
        last4: parsed.data.last4 && /^\d{4}$/.test(parsed.data.last4) ? parsed.data.last4 : undefined,
      });
      if (openingCents !== null) {
        addManualAnchor(db, { accountId: id, anchoredOn: todayIso(), enteredCents: openingCents });
      }
      return id;
    });
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not add the account") };
  }

  revalidatePath("/");
  revalidatePath("/accounts");
  return { ok: true, data: { id: accountId } };
}

export async function createAccountAction(formData: FormData): Promise<void> {
  const result = await createAccountResultAction(formData);
  // redirect() throws NEXT_REDIRECT by design — it must stay outside any catch
  redirect(
    result.ok ? `/accounts/${result.data.id}` : `/accounts?error=${encodeURIComponent(result.error)}`,
  );
}

// The single-argument form gives the SAME message when the field is missing
// entirely — a hidden input that never made it into the FormData would
// otherwise report zod's "Invalid input: expected string, received undefined".
const anchorFormSchema = z.object({
  accountId: z.string("Pick an account").min(1, "Pick an account"),
  anchoredOn: z.string("Pick a date").min(10, "Pick a date"),
  balance: z.string("Enter a balance").trim().min(1, "Enter a balance"),
});

/**
 * Validating core of "Record a balance". This is the action the owner crashed
 * twice: `balance` went straight into parseAmountToCents, so "not a number"
 * escaped as an unhandled server error and blanked the page.
 */
export async function addAnchorResultAction(
  formData: FormData,
): Promise<ActionResult<{ accountId: string; enteredCents: number }>> {
  const parsed = anchorFormSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, ANCHOR_LABELS) };
  }
  const amount = parseAmountField(ANCHOR_LABELS.balance, parsed.data.balance);
  if (!amount.ok) return amount;
  try {
    addManualAnchor(getDb(), {
      accountId: parsed.data.accountId,
      anchoredOn: parsed.data.anchoredOn,
      enteredCents: amount.data,
    });
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not save the balance") };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.accountId}`);
  return { ok: true, data: { accountId: parsed.data.accountId, enteredCents: amount.data } };
}

export async function addAnchorAction(formData: FormData): Promise<void> {
  const result = await addAnchorResultAction(formData);
  if (result.ok) return;
  const accountId = formData.get("accountId");
  const base = typeof accountId === "string" && accountId !== "" ? `/accounts/${accountId}` : "/accounts";
  redirect(`${base}?error=${encodeURIComponent(result.error)}`);
}

const deleteAnchorSchema = z.object({
  anchorId: z.string("Pick a balance entry").min(1, "Pick a balance entry"),
  accountId: z.string("Pick an account").min(1, "Pick an account"),
});

export async function deleteAnchorResultAction(
  formData: FormData,
): Promise<ActionResult<{ accountId: string }>> {
  const parsed = deleteAnchorSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      error: firstIssueMessage(parsed.error.issues, {
        ...ANCHOR_LABELS,
        anchorId: "Balance entry",
      }),
    };
  }
  try {
    deleteAnchor(getDb(), parsed.data.anchorId);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not delete the balance") };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.accountId}`);
  return { ok: true, data: { accountId: parsed.data.accountId } };
}

export async function deleteAnchorAction(formData: FormData): Promise<void> {
  const result = await deleteAnchorResultAction(formData);
  if (result.ok) return;
  redirect(`/accounts?error=${encodeURIComponent(result.error)}`);
}

const setActiveSchema = z.object({
  accountId: z.string("Pick an account").min(1, "Pick an account"),
  isActive: z.enum(["true", "false"]),
});

export async function setAccountActiveResultAction(
  formData: FormData,
): Promise<ActionResult<{ accountId: string; isActive: boolean }>> {
  const parsed = setActiveSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      error: firstIssueMessage(parsed.error.issues, { accountId: "Account", isActive: "Status" }),
    };
  }
  const isActive = parsed.data.isActive === "true";
  try {
    updateAccount(getDb(), parsed.data.accountId, { isActive });
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not update the account") };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.accountId}`);
  return { ok: true, data: { accountId: parsed.data.accountId, isActive } };
}

export async function setAccountActiveAction(formData: FormData): Promise<void> {
  const result = await setAccountActiveResultAction(formData);
  if (result.ok) return;
  redirect(`/accounts?error=${encodeURIComponent(result.error)}`);
}

// ── Manage accounts (§7.2): value-returning actions the client drives ─────────

const editAccountActionSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1, "Name the account").max(80, "Keep it to 80 characters or fewer"),
  institutionId: z.string().min(1, "Pick an institution"),
  last4: z.string().trim().optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  subtype: z.enum(ACCOUNT_SUBTYPES).nullable().optional(),
  paymentSourceAccountId: z.string().min(1).nullable().optional(),
  /** required true when type/subtype change — the "re-derives history" gate */
  confirmRederive: z.boolean().optional(),
});

/** Edit an account's name / institution / last4 / type / subtype (the edit sheet). */
export async function editAccountAction(input: {
  accountId: string;
  name: string;
  institutionId: string;
  last4?: string;
  type?: (typeof ACCOUNT_TYPES)[number];
  subtype?: (typeof ACCOUNT_SUBTYPES)[number] | null;
  paymentSourceAccountId?: string | null;
  confirmRederive?: boolean;
}): Promise<ActionResult<{ id: string; rederived: boolean }>> {
  const parsed = editAccountActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid account details" };
  }
  const last4 = parsed.data.last4 && parsed.data.last4 !== "" ? parsed.data.last4 : null;
  if (last4 !== null && !/^\d{4}$/.test(last4)) {
    return { ok: false, error: "Last 4 must be four digits (or blank)" };
  }
  const db = getDb();
  if (parsed.data.type !== undefined || parsed.data.subtype !== undefined) {
    const current = getAccount(db, parsed.data.accountId);
    if (!current) return { ok: false, error: "Unknown account" };
    const changesSemantics =
      (parsed.data.type !== undefined && parsed.data.type !== current.type) ||
      (parsed.data.subtype !== undefined && parsed.data.subtype !== current.subtype);
    if (changesSemantics && parsed.data.confirmRederive !== true) {
      return { ok: false, error: "Changing the type re-derives this account's balance history — confirm first" };
    }
  }
  let rederived = false;
  try {
    const result = editAccount(db, parsed.data.accountId, {
      name: parsed.data.name,
      institutionId: parsed.data.institutionId,
      last4,
      ...(parsed.data.type !== undefined && { type: parsed.data.type }),
      ...(parsed.data.subtype !== undefined && { subtype: parsed.data.subtype }),
      ...(parsed.data.paymentSourceAccountId !== undefined && {
        paymentSourceAccountId: parsed.data.paymentSourceAccountId,
      }),
    });
    rederived = result.rederived;
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not save account") };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${parsed.data.accountId}`);
  return { ok: true, data: { id: parsed.data.accountId, rederived } };
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
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not rename account") };
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
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not add institution") };
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
    return { ok: false, error: actionErrorMessage(error, ACCOUNT_FIELD_LABELS, "Could not reorder accounts") };
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  return { ok: true, data: null };
}
