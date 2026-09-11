/**
 * The words the UI uses for an account's type and subtype.
 *
 * 🔴 `/accounts/<id>` read **"Investment · brokerage · ····3525"** — the type
 * mapped through a label, the subtype interpolated straight out of the database
 * enum, two words apart in one line. The "Edit account" button on that very
 * header row opens a sheet whose own picker says "Brokerage".
 *
 * ⛔ THE SUBTYPE MAP HAD EXACTLY ONE CALLER while the type map had FIVE
 * IDENTICAL COPIES. Every surface that printed a type had its own transcription
 * of the same four words; both surfaces that printed a SUBTYPE printed the raw
 * enum instead, because the map that knew better was private to the sheet.
 * Measured on the real ledger, 2026-09-11:
 *
 *     /accounts/019f…2fb50   "Investment · brokerage · ····3525"
 *     /accounts/019f…6193e   "Investment · crypto · ····8474"
 *     /investments           the Portfolio-actions account picker:
 *                            "Robinhood Brokerage (brokerage)"
 *
 * ⚠️ The `<option>` above is in the SSR DOM but its sheet opens closed, so no
 * pixel baseline can ever have seen it — the same blindness that hid four
 * defects inside confirmation dialogs on 2026-09-08.
 *
 * A sixth surface inherits the vocabulary from here instead of re-deriving it.
 */

import type { AccountSubtype, AccountType } from "@/db/schema/accounts";

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  investment: "Investment",
};

export const ACCOUNT_SUBTYPE_LABEL: Record<AccountSubtype, string> = {
  brokerage: "Brokerage",
  crypto: "Crypto",
};

/**
 * The label for a stored type, falling back to the stored value itself.
 *
 * The fallback exists because a column is a wider type than a union: a row
 * written before a value was retired, or by a migration this build does not
 * know about, must still print SOMETHING rather than "undefined".
 */
export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABEL[type as AccountType] ?? type;
}

/** The same for a subtype. `null`/absent subtype → null, never an empty word. */
export function accountSubtypeLabel(subtype: string | null | undefined): string | null {
  if (subtype === null || subtype === undefined || subtype === "") return null;
  return ACCOUNT_SUBTYPE_LABEL[subtype as AccountSubtype] ?? subtype;
}
