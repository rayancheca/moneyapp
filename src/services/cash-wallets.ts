import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { isLiability } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { isWithinFinancialWindow, MIN_OPENING_DATE } from "@/lib/date-window";
import { addDays, compareDates, isValidIsoDate, todayIso } from "@/lib/dates";
import { createAccount, getAccount, listAccounts, type AccountView } from "./accounts";
import { addManualAnchor, listAnchors } from "./anchors";
import { CASH_INSTITUTION_NAME, cashWalletIds, isCashWallet } from "./cash-wallet-rule";

/**
 * Cash wallets (ux-overhaul-plan §3.7): manual, import-free accounts for the
 * cash economy — e.g. a "Cash" account for the weekly ATM salary. Creating one
 * seeds a $0 opening anchor so its very first manual transaction derives a
 * balance; without that baseline, derivation carries forward from nothing and
 * the wallet shows no balances (the deferred bug this closes).
 */

export const cashWalletInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** the wallet's start date — balances derive from this day forward */
    openingOn: z
      .string()
      .refine(isValidIsoDate, "Invalid date")
      // The wallet anchors the day BEFORE openingOn (see createCashWallet), so
      // it is that DERIVED day that has to be in range — an openingOn of
      // exactly MIN_FINANCIAL_DATE anchors at 1969-12-31, which addManualAnchor
      // rejects only AFTER createAccount has inserted the row. The leading
      // isValidIsoDate is load-bearing: zod runs every refine in a chain even
      // after an earlier one failed, and addDays throws on garbage.
      .refine(
        (d) => isValidIsoDate(d) && isWithinFinancialWindow(addDays(d, -1)),
        `Opening date must be on or after ${MIN_OPENING_DATE}`,
      )
      // A FUTURE opening date parks the whole opening balance in the future and
      // drags the net-worth series past today — measured, a 2027 date moved the
      // last point to 2026-12-31. Only the browser's `max` enforced this, and a
      // server action is a network boundary, not a form.
      .refine((d) => !isValidIsoDate(d) || compareDates(d, todayIso()) <= 0, "Opening date cannot be in the future")
      .optional(),
    /**
     * cash already in the wallet on the opening date. Optional and defaulting
     * to 0 so the old two-field call site keeps working, but without it a new
     * wallet could only ever open empty — which read as "I added a cash account
     * and my balances didn't change".
     */
    openingBalanceCents: z.number().int().min(0).optional(),
  })
  .strict();
export type CashWalletInput = z.infer<typeof cashWalletInputSchema>;

/** Find-or-create the single "Cash" institution that groups manual wallets. */
function cashInstitutionId(db: AppDatabase): string {
  const existing = db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.name, CASH_INSTITUTION_NAME))
    .get();
  if (existing) return existing.id;
  return db
    .insert(institutions)
    .values({ name: CASH_INSTITUTION_NAME })
    .returning({ id: institutions.id })
    .get().id;
}

export function createCashWallet(db: AppDatabase, input: CashWalletInput): string {
  const parsed = cashWalletInputSchema.parse(input);
  const openingOn = parsed.openingOn ?? todayIso();
  // One transaction: the institution, the account and the opening anchor commit
  // together or not at all. They used to be three loose writes, so an anchor
  // that threw left a nameless wallet behind that appeared in the account list,
  // read "no balance yet", and made EVERY net-worth day incomplete — while the
  // user was told creation had failed. Nesting is safe and idiomatic here
  // (accounts.ts updateAccount does the same); better-sqlite3 downgrades a
  // nested transaction to a SAVEPOINT.
  //
  // This path must never reach withPreMutationSnapshot, which takes a
  // VACUUM INTO and throws inside an open transaction (db/backup.ts). It cannot
  // today: the account id is brand new, so addManualAnchor's `overwrites`
  // branch is unreachable. Editing an EXISTING wallet's opening balance DOES
  // take that branch, which is why setCashWalletOpening below is not wrapped.
  return db.transaction(() => {
    const accountId = createAccount(db, {
      institutionId: cashInstitutionId(db),
      name: parsed.name,
      type: "checking",
    });
    // Anchor the opening cash the day BEFORE the opening date. Derivation carries
    // an anchor's value forward from anchoredOn+1 and never adds the anchor DAY's
    // own txn sum, so an anchor ON the opening day would silently drop a same-day
    // first transaction (the default flow: opening date and txn date both default
    // to today). Dating it one day earlier lets the opening balance stand on the
    // opening date and every transaction on or after it derive correctly.
    addManualAnchor(db, {
      accountId,
      anchoredOn: addDays(openingOn, -1),
      enteredCents: parsed.openingBalanceCents ?? 0,
    });
    return accountId;
  });
}

export const cashWalletOpeningSchema = z
  .object({
    accountId: z.string().min(1),
    openingBalanceCents: z.number().int().min(0),
  })
  .strict();
export type CashWalletOpeningInput = z.infer<typeof cashWalletOpeningSchema>;

/**
 * Change how much cash an EXISTING wallet opened with.
 *
 * The date is deliberately not a parameter, and that is what makes this safe:
 * re-anchoring the wallet's own opening day takes addManualAnchor's upsert on
 * (account, day, 'manual'), so it can only ever overwrite the opening figure.
 * Accepting a date would insert a SECOND chain-grade anchor, and two unequal
 * anchors with no transactions between them turn every day in the span to
 * basis='gap' — dropped from the chart, from the latest balance, and from
 * net-worth coverage.
 *
 * Not wrapped in a transaction: overwriting an existing manual anchor takes a
 * pre-mutation restore point, and that VACUUMs, which throws inside one.
 */
export function setCashWalletOpening(
  db: AppDatabase,
  input: CashWalletOpeningInput,
): { anchoredOn: string } {
  const parsed = cashWalletOpeningSchema.parse(input);
  if (!isCashWallet(db, parsed.accountId)) {
    throw new Error(
      "Only cash wallets have an editable opening balance — statement-fed accounts are anchored by their imports",
    );
  }
  // isCashWallet gates on the institution and the absence of imports, NOT on
  // the account's type, and the ordinary Add-an-account form will happily make
  // a `credit` account under "Cash". addManualAnchor stores a liability as the
  // NEGATED amount owed, so a positive opening here would come back negative and
  // this editor would refuse to save its own value. Cash on hand is not a debt.
  const account = getAccount(db, parsed.accountId);
  if (account && isLiability(account.type)) {
    throw new Error("A credit account records what you owe, not cash on hand");
  }
  const opening = listAnchors(db, parsed.accountId)[0];
  if (!opening) throw new Error("This wallet has no opening balance to edit");
  addManualAnchor(db, {
    accountId: parsed.accountId,
    anchoredOn: opening.anchoredOn,
    enteredCents: parsed.openingBalanceCents,
  });
  return { anchoredOn: opening.anchoredOn };
}

/** Active accounts that qualify as cash wallets (import-free — see isCashWallet). */
export function listCashWallets(db: AppDatabase): AccountView[] {
  // the rule asked once for the whole list, not once per account
  const wallets = cashWalletIds(db);
  return listAccounts(db).filter((a) => a.isActive && wallets.has(a.id));
}

export interface CashWalletSummary {
  id: string;
  name: string;
  balanceCents: number | null;
  /**
   * The opening figure. Deliberately no date alongside it: the anchor's own day
   * means different things depending on which form made the wallet
   * (createCashWallet anchors the day BEFORE the opening date, while the
   * ordinary Add-an-account form anchors ON the day), so any single label would
   * misreport one of them by a day — and a wrong date here invites a
   * "correction" through the anchor form, which inserts a SECOND anchor.
   */
  openingCents: number | null;
  /**
   * How many balances this wallet has recorded. Above one, editing the OPENING
   * moves nothing the owner can see — derivation seeds the forward walk from
   * the LAST anchor — so the UI must say so rather than accept an edit that
   * silently does nothing.
   */
  anchorCount: number;
}

/** Cash wallets with the opening balance the edit affordance needs. */
export function listCashWalletSummaries(db: AppDatabase): CashWalletSummary[] {
  return listCashWallets(db).map((w) => {
    const anchors = listAnchors(db, w.id);
    const opening = anchors[0];
    return {
      id: w.id,
      name: w.name,
      balanceCents: w.balance?.balanceCents ?? null,
      openingCents: opening?.balanceCents ?? null,
      anchorCount: anchors.length,
    };
  });
}
