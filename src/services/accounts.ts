import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts, ACCOUNT_TYPES, ACCOUNT_SUBTYPES, isLiability } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { isInvestmentSide, isOwnPortfolioBook, liquidityOf, type Liquidity } from "@/lib/account-side";
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
  const { rows, sideOf } = accountSides(db);
  return new Set(rows.filter((r) => isInvestmentSide(sideOf(r))).map((r) => r.id));
}

/**
 * Every investment account whose positions are HIS portfolio — `isOwnPortfolioBook` (lib/account-side), given the
 * cash account each one's `cash_account_id` names. Active or not; the portfolio's own scope drops archived ones.
 *
 * ⚖️ It leaves out the brokerage book paired with Robinhood Agentic: the owner kept that account out of his own
 * brokerage returns (2026-09-14), and its positions live in the book (2026-09-15).
 */
export function ownPortfolioAccountIds(db: AppDatabase): Set<string> {
  const { rows, sideOf } = accountSides(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Set(
    rows
      .filter((r) => {
        const cash = r.cashAccountId === null ? undefined : byId.get(r.cashAccountId);
        return isOwnPortfolioBook({ type: r.type, cashLeg: cash === undefined ? null : sideOf(cash) });
      })
      .map((r) => r.id),
  );
}

/**
 * The cash accounts paired with a brokerage book that is NOT his portfolio (`ownPortfolioAccountIds`) — Robinhood
 * Agentic, once the agent has bought. What the book's shares pay posts there (a dividend), and it is the agent's
 * return, kept out of his as the book's positions and sales are.
 */
export function outsidePortfolioCashAccountIds(db: AppDatabase): Set<string> {
  const own = ownPortfolioAccountIds(db);
  return new Set(
    accountSides(db)
      .rows.filter((r) => r.cashAccountId !== null && !own.has(r.id))
      .map((r) => r.cashAccountId as string),
  );
}

/** Every account, with the one fact `isInvestmentSide` needs that its row does not carry. One read for both rules. */
function accountSides(db: AppDatabase) {
  const rows = db
    .select({
      id: accounts.id,
      type: accounts.type,
      name: accounts.name,
      institutionId: accounts.institutionId,
      cashAccountId: accounts.cashAccountId,
    })
    .from(accounts)
    .all();
  const investmentInstitutions = new Set(rows.filter((r) => r.type === "investment").map((r) => r.institutionId));
  const sideOf = (r: (typeof rows)[number]) => ({
    type: r.type,
    name: r.name,
    institutionHasInvestment: investmentInstitutions.has(r.institutionId),
  });
  return { rows, sideOf };
}

/**
 * What every account's balance is to the runway and the forecast: `liquidityOf`
 * (lib/account-side), given the one fact the account row does not carry —
 * whether a statement file that prints the account also prints an investment
 * account. Every account, active or not; `cashPosition` is where archived ones
 * leave.
 *
 * ⛔ NOT `investmentSideAccountIds`. That set is transfer semantics keyed off a
 * settlement NAME, and it leaves Robinhood Agentic out on purpose.
 */
export function accountLiquidity(db: AppDatabase): Map<string, Liquidity> {
  const investmentStatementFiles = db
    .select({ importFileId: statementPeriods.importFileId })
    .from(statementPeriods)
    .innerJoin(accounts, eq(accounts.id, statementPeriods.accountId))
    .where(eq(accounts.type, "investment"));
  const printedWithInvestment = new Set(
    db
      .selectDistinct({ accountId: statementPeriods.accountId })
      .from(statementPeriods)
      .where(inArray(statementPeriods.importFileId, investmentStatementFiles))
      .all()
      .map((r) => r.accountId),
  );
  const rows = db.select({ id: accounts.id, type: accounts.type }).from(accounts).all();
  return new Map(
    rows.map((r) => [r.id, liquidityOf({ type: r.type, printedWithInvestment: printedWithInvestment.has(r.id) })]),
  );
}

export interface CashPosition {
  /** "Cash you can spend today", and the forecast's month-end cash starts from it */
  spendableCents: number;
  /** "What selling investments would add" — a brokerage's own cash included */
  investableCents: number;
  /** positive magnitude owed on cards; a card in credit nets it DOWN */
  cardDebtCents: number;
  /** the part of `cardDebtCents` that is a net: credit balances on cards */
  cardCreditCents: number;
}

/**
 * The ONE place a balance becomes cash, investments or card debt.
 *
 * ⚖️ Owner decision 2026-09-15. `runwayCard` and both of `forecast`'s EOM-cash
 * walks each summed "checking or savings" on their own, so Robinhood Cash
 * ($0.90) and Robinhood Agentic ($26.64) — typed `checking` for balance replay —
 * were "Cash you can spend today" and month-end cash. Measured on his ledger
 * that day before the fix: $5,431.92 spendable, $108,974.93 from selling
 * investments, "27 days of cash"; September EOM cash $1,093.15.
 *
 * Active accounts only: archiving takes an account out of every analytic, as
 * `/accounts/<x>` promises. A missing balance counts as zero, as it always has.
 * `balances` lets a caller already holding `latestBalances` pass it rather than
 * read the cache twice.
 */
export function cashPosition(
  db: AppDatabase,
  balances: ReadonlyMap<string, AccountBalance> = latestBalances(db),
): CashPosition {
  const liquidity = accountLiquidity(db);
  const active = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.isActive, true)).all();
  let spendableCents = 0;
  let investableCents = 0;
  let cardDebtCents = 0;
  let cardCreditCents = 0;
  for (const { id } of active) {
    const cents = balances.get(id)?.balanceCents ?? 0;
    switch (liquidity.get(id)) {
      case "spendable":
        spendableCents += cents;
        break;
      case "investable":
        investableCents += cents;
        break;
      case "owed":
        // stored negative; the runway wants a positive debt, and a card in
        // credit nets it down, which the line then says (lib/runway)
        cardDebtCents -= cents;
        if (cents > 0) cardCreditCents += cents;
        break;
    }
  }
  return { spendableCents, investableCents, cardDebtCents, cardCreditCents };
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
