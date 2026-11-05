import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { isInvestmentSide, isOwnPortfolioBook } from "@/lib/account-side";

/*
 * Which side of his money each account is on — the investment side of a transfer, his portfolio, the agent's cash —
 * read from the accounts alone. Its own module so the services that ask it (analytics, the earnings, recurring) need
 * not import `accounts`, which imports the derivation: 🔴 that edge closed a 12-module import cycle through
 * derivation → observation-frontier → cash-earnings → accounts (the review of batch 9 F, 2026-10-30). `accounts`
 * re-exports all three, so every other caller reads them where it always has.
 */

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
