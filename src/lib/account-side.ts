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

export interface PortfolioBookInput {
  /** accounts.type */
  type: string;
  /** the cash account `accounts.cash_account_id` pairs this account with, or null when it names none */
  cashLeg: AccountSideInput | null;
}

/**
 * Whether an investment account's positions are HIS portfolio: the value, returns, P/L and holdings that
 * /investments, /summary and the dashboard's investments teaser report.
 *
 * ⚖️ Owner decisions. Robinhood #655929651 is tracked as "Robinhood Agentic" — Claude's agent trades it — and he chose
 * that name so it is KEPT OUT of his own brokerage returns (2026-09-14). When the agent buys a stock, a second
 * account holds the positions and Robinhood Agentic keeps the unspent cash, as Robinhood Cash and Robinhood Brokerage
 * split #487513525 (2026-09-15). The book is paired with its cash account by a stored link (`cash_account_id`).
 *
 * ⛔ The book belongs to whichever side its CASH ACCOUNT is on, so the pair is never split across his boundary:
 *  - the cash account outside his investment side (Robinhood Agentic, by the owner's naming): money moving to it is
 *    an external flow out of his investments (`externalInvestmentFlows`) — so the book it buys with must be outside
 *    his portfolio too, or the $26.64 would read as a withdrawal AND its positions as his gain.
 *  - the cash account on his side: the move is internal, and the book is his.
 *
 * An investment account with no link is his, as every account was before the first book existed. Net worth, the
 * account's own page and `pnpm ledger-check` still value a book that is not his — this says only whose RETURNS it is.
 */
export function isOwnPortfolioBook(book: PortfolioBookInput): boolean {
  if (book.type !== "investment") return false;
  return book.cashLeg === null || isInvestmentSide(book.cashLeg);
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
