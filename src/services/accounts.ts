import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts, ACCOUNT_TYPES, ACCOUNT_SUBTYPES, isLiability } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { isInvestmentSide } from "@/lib/account-side";
import { isPrintableName } from "@/lib/printable-name";
import { ACCOUNT_ORDER } from "./account-order";
import { latestBalances, rebuildAccount, type AccountBalance } from "./derivation";

export const accountInputSchema = z.object({
  institutionId: z.string().min(1),
  /*
   * ⛔ The charset matters as much as the length. `/accounts/[id]` writes the
   * account's name into a fact's subject, and `insight-facts` refuses
   * `< > { } \` by THROWING — so a name accepted here is a page that renders
   * its error boundary instead of a balance. See `lib/printable-name`.
   */
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine(isPrintableName, { message: "Account names cannot contain < > { } or a backslash" }),
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

/**
 * Accounts that count as the "investment side" of a transfer (lib/account-side):
 * every investment-type account plus the settlement-cash sibling that P0.1
 * models at the same institution ("Robinhood Cash"). Transfer detection and
 * pair categorization key off this set, so a contribution keeps reading as a
 * contribution after the cash ledger moved off the securities account.
 */
export function investmentSideAccountIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ id: accounts.id, type: accounts.type, name: accounts.name, institutionId: accounts.institutionId })
    .from(accounts)
    .all();
  const investmentInstitutions = new Set(rows.filter((r) => r.type === "investment").map((r) => r.institutionId));
  return new Set(
    rows
      .filter((r) =>
        isInvestmentSide({
          type: r.type,
          name: r.name,
          institutionHasInvestment: investmentInstitutions.has(r.institutionId),
        }),
      )
      .map((r) => r.id),
  );
}

/**
 * Every account as `{id, name}`, in THE order — `ACCOUNT_ORDER`: institution,
 * then the within-institution `displayOrder`, then name.
 *
 * 🔴 `/transactions`' account picker ran its own `orderBy(displayOrder, name)`,
 * which on the owner's ledger listed nine accounts alphabetically and then
 * appended Chase Checking, Robinhood Cash and Robinhood Crypto — the 1s and the
 * 2 — after Wells Fargo. The one list where a reader has to FIND a name was the
 * one list in no order at all.
 *
 * ⚠️ Not `listAccounts().map(...)`. That one also runs `latestBalances`, a full
 * scan of the derived cache, and a dropdown does not need a balance.
 */
export function listAccountOptions(db: AppDatabase): { id: string; name: string }[] {
  return db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .orderBy(...ACCOUNT_ORDER)
    .all();
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
    .orderBy(...ACCOUNT_ORDER)
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
    /*
     * ⛔ The SAME charset rule as `accountInputSchema`, and this is the schema
     * the rename UI actually goes through — guarding only the create path would
     * have left the reachable one open. See `lib/printable-name`.
     */
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isPrintableName, { message: "Account names cannot contain < > { } or a backslash" }),
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

  // The mirror image: flipping INTO investment routes derivation down the
  // holdings branch, which carries the anchor forward and never reads the
  // day sums — so every entry after the anchor stops counting.
  //
  // The guard keys on manual rows, and the reason is narrower than "manual is
  // what derivation cares about" (it is not — derivation filters on `status`,
  // never on provenance). It is that manual rows are the only transactions
  // with no external ground truth to re-anchor from. An IMPORTED account
  // suffers the same freeze, but its newest anchor is a recent statement, so
  // the next import restates it; blocking that case too would break the
  // legitimate repair of a stub auto-created as checking that is really a
  // brokerage. A hand-kept wallet's only anchor is its OPENING — the oldest
  // date it has — so the freeze there is permanent and inflates the balance.
  if (typeChanged && effectiveType === "investment") {
    const hasManual = db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.accountId, id), isNull(transactions.importFileId)))
      .get();
    if (hasManual) {
      throw new Error(
        "This account's balance is replayed from its own cash entries — an investment account derives value from holdings instead, so those entries would stop counting",
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
