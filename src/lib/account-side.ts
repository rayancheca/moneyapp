/**
 * Which accounts count as the "investment side" of a money movement. The app
 * splits a brokerage into a securities account (type `investment`, valued by
 * qty × close) and a settlement-cash sibling (type `checking`, valued by cash
 * replay — P0.1). Transfer semantics must treat that cash sibling as part of
 * the brokerage: a deposit "to Robinhood" lands there, and detection's
 * descriptor rules + pair categories key off this classification, not the raw
 * account type.
 */

export interface AccountSideInput {
  /** accounts.type — investment / checking / savings / credit / ... */
  type: string;
  name: string;
  /** true when the account's institution also holds an investment-type account */
  institutionHasInvestment: boolean;
}

/** settlement-cash naming at an investment institution ("Robinhood Cash", "Fidelity Brokerage Cash", ...) */
const SETTLEMENT_NAME_RE = /\b(cash|settlement|brokerage|invest)\b/i;

export function isInvestmentSide(account: AccountSideInput): boolean {
  if (account.type === "investment") return true;
  // a card at an investment institution is still a card, never a contribution target
  if (account.type === "credit") return false;
  return account.institutionHasInvestment && SETTLEMENT_NAME_RE.test(account.name);
}
