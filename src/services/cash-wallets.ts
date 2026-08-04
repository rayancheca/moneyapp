import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { institutions } from "@/db/schema/institutions";
import { addDays, isValidIsoDate, todayIso } from "@/lib/dates";
import { createAccount, listAccounts, type AccountView } from "./accounts";
import { addManualAnchor } from "./anchors";
import { CASH_INSTITUTION_NAME, isCashWallet } from "./manual-transactions";

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
    openingOn: z.string().refine(isValidIsoDate, "Invalid date").optional(),
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
}

/** Active accounts that qualify as cash wallets (import-free — see isCashWallet). */
export function listCashWallets(db: AppDatabase): AccountView[] {
  return listAccounts(db).filter((a) => a.isActive && isCashWallet(db, a.id));
}
