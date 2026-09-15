import type { AccountType } from "@/db/schema/accounts";

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

/**
 * What an account's balance is to "how long the money lasts":
 *
 *  - `spendable` — "Cash you can spend today", and the forecast's month-end cash
 *  - `investable` — "What selling investments would add"; what POSTS to one
 *    (a dividend, a brokerage fee) moves net worth but not month-end cash
 *    either (services/forecast `accountsOutsideCash`)
 *  - `owed` — card debt, netted off the cash
 *
 * ⚖️ Owner decision 2026-09-15: Robinhood Cash ($0.90, the brokerage's
 * settlement cash) and Robinhood Agentic ($26.64, Claude's trading money) are
 * `investable`, not `spendable`. Both are typed `checking` because a checking
 * account replays its transactions between printed anchors, so the TYPE cannot
 * say it; the statement that prints them can. A deposit account printed on the
 * same statement as an investment account is that brokerage's own cash.
 *
 * ⛔ NOT `isInvestmentSide`, and not the institution alone:
 *  - `isInvestmentSide` is TRANSFER semantics keyed off a name, and "Robinhood
 *    Agentic" is not a settlement name — the owner kept it out of brokerage
 *    returns by name, on purpose. Making it investment-side would change that.
 *  - "a deposit account at an institution holding an investment account"
 *    selects the same two accounts today, and is wrong for a bank that also
 *    runs a brokerage (SoFi Invest, J.P. Morgan at Chase): that bank prints its
 *    checking on its own statement, and the checking is still money he spends.
 *
 * ⚠️ Known limit: a brokerage's cash account with NO statement imported yet
 * reads `spendable` until its first statement lands, and one whose every
 * shared statement is un-imported goes back to it. Measured 2026-09-15, both on
 * the ledger have them: Robinhood Cash shares 25 files with Robinhood
 * Brokerage, Robinhood Agentic 3.
 */
export type Liquidity = "spendable" | "investable" | "owed";

export interface LiquidityInput {
  type: AccountType;
  /** true when a statement file that prints this account also prints an investment-type account */
  printedWithInvestment: boolean;
}

export function liquidityOf(account: LiquidityInput): Liquidity {
  switch (account.type) {
    case "credit":
      return "owed";
    case "investment":
      return "investable";
    case "checking":
    case "savings":
      return account.printedWithInvestment ? "investable" : "spendable";
  }
}
