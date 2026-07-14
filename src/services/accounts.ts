import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts, ACCOUNT_TYPES, ACCOUNT_SUBTYPES, isLiability } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { institutions } from "@/db/schema/institutions";
import { latestBalances, rebuildAccount, type AccountBalance } from "./derivation";

export const accountInputSchema = z.object({
  institutionId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.enum(ACCOUNT_SUBTYPES).nullish(),
  last4: z
    .string()
    .trim()
    .regex(/^\d{4}$/)
    .nullish(),
});
export type AccountInput = z.infer<typeof accountInputSchema>;

export interface AccountView {
  id: string;
  institutionId: string;
  institutionName: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  subtype: (typeof ACCOUNT_SUBTYPES)[number] | null;
  last4: string | null;
  isActive: boolean;
  isLiability: boolean;
  balance: AccountBalance | null;
}

export function listInstitutions(db: AppDatabase) {
  return db.select().from(institutions).orderBy(asc(institutions.name)).all();
}

export function listAccounts(db: AppDatabase): AccountView[] {
  const rows = db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      last4: accounts.last4,
      isActive: accounts.isActive,
      displayOrder: accounts.displayOrder,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .orderBy(asc(institutions.name), asc(accounts.displayOrder), asc(accounts.name))
    .all();

  const balances = latestBalances(db);
  return rows.map((r) => ({
    id: r.id,
    institutionId: r.institutionId,
    institutionName: r.institutionName,
    name: r.name,
    type: r.type,
    subtype: r.subtype,
    last4: r.last4,
    isActive: r.isActive,
    isLiability: isLiability(r.type),
    balance: balances.get(r.id) ?? null,
  }));
}

export function getAccount(db: AppDatabase, id: string) {
  return db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

export function createAccount(db: AppDatabase, input: AccountInput): string {
  const parsed = accountInputSchema.parse(input);
  if (parsed.subtype && parsed.type !== "investment") {
    throw new Error("Subtype applies only to investment accounts");
  }
  const row = db
    .insert(accounts)
    .values({
      institutionId: parsed.institutionId,
      name: parsed.name,
      type: parsed.type,
      subtype: parsed.subtype ?? null,
      last4: parsed.last4 ?? null,
    })
    .returning({ id: accounts.id })
    .get();
  return row.id;
}

export function updateAccount(db: AppDatabase, id: string, input: Partial<AccountInput> & { isActive?: boolean }) {
  const parsed = accountInputSchema.partial().extend({ isActive: z.boolean().optional() }).parse(input);
  const existing = getAccount(db, id);
  if (!existing) throw new Error(`Unknown account ${id}`);
  db.update(accounts)
    .set({
      ...(parsed.institutionId !== undefined && { institutionId: parsed.institutionId }),
      ...(parsed.name !== undefined && { name: parsed.name }),
      ...(parsed.type !== undefined && { type: parsed.type }),
      ...(parsed.subtype !== undefined && { subtype: parsed.subtype }),
      ...(parsed.last4 !== undefined && { last4: parsed.last4 }),
      ...(parsed.isActive !== undefined && { isActive: parsed.isActive }),
    })
    .where(eq(accounts.id, id))
    .run();
}

/**
 * Edit-account sheet (§7.2, extended by S3): rename, re-home to another
 * institution, fix the last4 — plus type/subtype, which flip the account's
 * liability/derivation semantics and therefore re-derive its balance history.
 * The action layer requires an explicit confirmation before a type/subtype
 * change reaches here — it is never a casual edit.
 */
export const accountEditSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    institutionId: z.string().min(1),
    last4: z
      .string()
      .trim()
      .regex(/^\d{4}$/)
      .nullable(),
    type: z.enum(ACCOUNT_TYPES).optional(),
    subtype: z.enum(ACCOUNT_SUBTYPES).nullable().optional(),
    /** S6: the credit card's funding account — checking/savings, never self */
    paymentSourceAccountId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type AccountEditInput = z.infer<typeof accountEditSchema>;

export interface AccountEditResult {
  /** true when a type/subtype change re-derived the balance history */
  rederived: boolean;
}

export function editAccount(db: AppDatabase, id: string, input: AccountEditInput): AccountEditResult {
  const parsed = accountEditSchema.parse(input);
  const existing = getAccount(db, id);
  if (!existing) throw new Error(`Unknown account ${id}`);

  // subtype is meaningful only on investment accounts — enforce against the
  // EFFECTIVE type (a hand-crafted call must not sneak `checking`+`crypto` in),
  // and normalize it away when the account leaves the investment type
  const effectiveType = parsed.type ?? existing.type;
  if (parsed.subtype != null && effectiveType !== "investment") {
    throw new Error("Subtype applies only to investment accounts");
  }
  const nextSubtype =
    effectiveType === "investment" ? (parsed.subtype !== undefined ? parsed.subtype : existing.subtype) : null;

  const typeChanged = effectiveType !== existing.type;
  const subtypeChanged = nextSubtype !== existing.subtype;

  // payment-source link (S6): only a credit card has a funding account, the
  // target must be a cash account, and an account can never fund itself
  if (parsed.paymentSourceAccountId != null) {
    if (effectiveType !== "credit") throw new Error("Only a credit card has a payment source");
    if (parsed.paymentSourceAccountId === id) throw new Error("An account cannot fund itself");
    const source = getAccount(db, parsed.paymentSourceAccountId);
    if (!source) throw new Error("Unknown payment-source account");
    if (source.type !== "checking" && source.type !== "savings") {
      throw new Error("The payment source must be a checking or savings account");
    }
  }
  // leaving the credit type clears the link — a checking account has no source
  const nextPaymentSource =
    effectiveType !== "credit"
      ? null
      : parsed.paymentSourceAccountId !== undefined
        ? parsed.paymentSourceAccountId
        : existing.paymentSourceAccountId;

  // an investment account whose curve comes from holdings × prices would LOSE
  // that history on a type flip (the anchor path has nothing to replay) —
  // refuse instead of silently discarding a derived balance curve
  if (typeChanged && existing.type === "investment") {
    const hasHoldings = db
      .select({ id: holdingEvents.id })
      .from(holdingEvents)
      .where(eq(holdingEvents.accountId, id))
      .get();
    if (hasHoldings) {
      throw new Error(
        "This account's balance history is derived from its holdings — changing its type would discard that history",
      );
    }
  }

  // one transaction: the semantic flip and the re-derivation commit together —
  // a rebuild failure must never leave the new type with the old curve
  return db.transaction(() => {
    db.update(accounts)
      .set({
        name: parsed.name,
        institutionId: parsed.institutionId,
        last4: parsed.last4,
        ...(parsed.type !== undefined && { type: parsed.type }),
        subtype: nextSubtype,
        paymentSourceAccountId: nextPaymentSource,
      })
      .where(eq(accounts.id, id))
      .run();
    if (typeChanged || subtypeChanged) {
      // the balance curve derives differently per type (investment =
      // holding-events × prices; cash = anchors + txn replay) — re-derive now so
      // the stored daily balances never disagree with the new semantics
      rebuildAccount(db, id);
      return { rederived: true };
    }
    return { rederived: false };
  });
}

const institutionNameSchema = z.string().trim().min(1).max(80);

/** Find-or-create an institution by name — the accounts page's inline "add". */
export function createInstitution(db: AppDatabase, name: string): string {
  const parsed = institutionNameSchema.parse(name);
  const existing = db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.name, parsed))
    .get();
  if (existing) return existing.id;
  return db.insert(institutions).values({ name: parsed }).returning({ id: institutions.id }).get().id;
}

/**
 * Persists a drag-reorder (§7.2): the given account ids get displayOrder 0..n in
 * the order supplied. Ordering is scoped within an institution by the account
 * list's sort (institution, then displayOrder), so the caller passes one
 * institution's ids in their new order. Unknown ids are ignored — a stale drag
 * can never renumber an account the caller didn't mean to touch.
 */
export function reorderAccounts(db: AppDatabase, orderedIds: readonly string[]): void {
  const known = new Set(db.select({ id: accounts.id }).from(accounts).all().map((a) => a.id));
  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      if (!known.has(id)) return;
      tx.update(accounts).set({ displayOrder: index }).where(eq(accounts.id, id)).run();
    });
  });
}
