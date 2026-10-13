import { describe, expect, test } from "vitest";
import {
  budgetCoverageFact,
  budgetCoverageSentence,
  readThroughSentence,
  spendUnread,
  spentOnlyFromCashWallets,
  type BudgetCoverageInput,
} from "./budget-coverage";

const input = (over: Partial<BudgetCoverageInput> = {}): BudgetCoverageInput => ({
  importedThroughOn: "2026-09-02",
  spentFromSince: "2026-03-01",
  spentFromAccounts: 3,
  spentFromWallets: 0,
  uncoveredDays: 13,
  bounds: { start: "2026-09-01" },
  ...over,
});

/**
 * ⚖️ OWNER DECISION, 2026-09-15: budgets leave cash wallets out of the
 * imported-through day. A category spent from nothing but wallets then has no
 * import date, and no statement is coming to give it one.
 */
describe("spentOnlyFromCashWallets — the one test for a cash-only row", () => {
  test("holds only with a wallet and no other account", () => {
    expect(spentOnlyFromCashWallets({ spentFromAccounts: 0, spentFromWallets: 1 })).toBe(true);
    expect(spentOnlyFromCashWallets({ spentFromAccounts: 0, spentFromWallets: 2 })).toBe(true);
    // nothing spent at all is not cash
    expect(spentOnlyFromCashWallets({ spentFromAccounts: 0, spentFromWallets: 0 })).toBe(false);
    // an investment account has no import date either, and is not cash
    expect(spentOnlyFromCashWallets({ spentFromAccounts: 1, spentFromWallets: 0 })).toBe(false);
    // Car on the real ledger 2026-09-15: Cash on Hand beside Chase Checking and Venture X
    expect(spentOnlyFromCashWallets({ spentFromAccounts: 2, spentFromWallets: 1 })).toBe(false);
  });
});

/*
 * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): Spent and Left print "—" where not one elapsed day of the window was read and
 * nothing was found in it. ⛔ The one test the row's headline, the page note and the page's proofs all read — so each
 * guard is pinned here, where the page's own caller (which asks no verdict first) depends on it.
 */
describe("spendUnread — the one test for a row that prints no spend", () => {
  const UNREAD = { spentFromAccounts: 2, spentFromWallets: 0, noDayRead: true, txnCount: 0 };

  test("not one day read and nothing found: a dash", () => {
    expect(spendUnread(UNREAD)).toBe(true);
    // a wallet beside an imported account is not cash only
    expect(spendUnread({ ...UNREAD, spentFromWallets: 1 })).toBe(true);
  });

  test("a day read, a row found, or a row spent only from cash: the figures stand", () => {
    expect(spendUnread({ ...UNREAD, noDayRead: false })).toBe(false);
    expect(spendUnread({ ...UNREAD, txnCount: 1 })).toBe(false);
    // ⚖️ no import will ever read a wallet's day — a dash would hide what was typed for good
    expect(spendUnread({ ...UNREAD, spentFromAccounts: 0, spentFromWallets: 1 })).toBe(false);
  });
});

describe("a cash-only row, in the panel and in the row", () => {
  const cashOnly = (over: Partial<BudgetCoverageInput> = {}) =>
    input({ importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1, uncoveredDays: 15, ...over });

  test("the panel says the category was spent only from cash, not that nothing was imported", () => {
    expect(budgetCoverageFact(cashOnly())).toBe("spent only from a cash wallet since Mar 1");
    expect(budgetCoverageFact(cashOnly({ spentFromWallets: 2 }))).toBe("spent only from cash wallets since Mar 1");
  });

  test("the row counts no days as waiting — no statement is coming", () => {
    expect(budgetCoverageSentence(cashOnly())).toBe("spent only from a cash wallet since Mar 1 — no statement will ever cover it");
    expect(budgetCoverageSentence(cashOnly({ spentFromWallets: 2 }))).toBe(
      "spent only from cash wallets since Mar 1 — no statement will ever cover them",
    );
    expect(budgetCoverageSentence(cashOnly())).not.toMatch(/unaccounted|imported through/);
  });

  test("a wallet beside an imported account leaves the imported day and the day count as they were", () => {
    expect(budgetCoverageSentence(input({ spentFromAccounts: 2, spentFromWallets: 1 }))).toBe(
      "spending imported through Sep 2 · 13 days of this period unaccounted",
    );
  });
});

describe("budgetCoverageFact — the day the details panel names", () => {
  test("names the day every account the category is spent from has been imported through", () => {
    // Food on the real ledger 2026-09-15: Venture X Sep 13, Discover Sep 8,
    // Chase Sapphire Sep 2 — never Food's own newest row (Sep 12)
    expect(budgetCoverageFact(input())).toBe("spending imported through Sep 2");
  });

  test("with no account spent from in the window, names where the window opens", () => {
    expect(budgetCoverageFact(input({ importedThroughOn: null, spentFromAccounts: 0 }))).toBe(
      "nothing imported for this category since Mar 1",
    );
  });

  test("with accounts that carry no import date, does not claim nothing was imported", () => {
    // an investment account holds rows, but is priced rather than imported
    expect(budgetCoverageFact(input({ importedThroughOn: null, spentFromAccounts: 1 }))).toBe(
      "spent only from accounts with no import date since Mar 1",
    );
  });

  test("a day outside the graded period's year carries its year", () => {
    const january = { start: "2027-01-01" };
    expect(budgetCoverageFact(input({ importedThroughOn: "2026-12-20", bounds: january }))).toBe(
      "spending imported through Dec 20, 2026",
    );
    expect(
      budgetCoverageFact(input({ importedThroughOn: null, spentFromAccounts: 0, spentFromSince: "2026-07-01", bounds: january })),
    ).toBe("nothing imported for this category since Jul 1, 2026");
  });
});

describe("budgetCoverageSentence — the withheld row", () => {
  test("is the details panel's fact plus the days of THIS period it leaves", () => {
    // one fact in two places: the row and the panel cannot name two days
    expect(budgetCoverageSentence(input())).toBe(
      `${budgetCoverageFact(input())} · 13 days of this period unaccounted`,
    );
    expect(budgetCoverageSentence(input())).toBe("spending imported through Sep 2 · 13 days of this period unaccounted");
  });

  test("a single day is singular", () => {
    expect(budgetCoverageSentence(input({ importedThroughOn: "2026-09-14", uncoveredDays: 1 }))).toBe(
      "spending imported through Sep 14 · 1 day of this period unaccounted",
    );
  });
});

/*
 * ⚖️ His decision 72 (2026-10-13): a total over a window some of whose days are past its own read frontier reads
 * "partly read", with /budgets' line under the figure. /spending's total has a day (`spendingCoverageThrough`) and no
 * category facts, so it asks the row's sentence for a NAMED day — ⛔ the row's own words, never a copy of them.
 */
describe("readThroughSentence — /budgets' line for a window read through a named day", () => {
  test("is the row's sentence, word for word, wherever the row names a day", () => {
    for (const over of [{}, { importedThroughOn: "2026-09-14", uncoveredDays: 1 }, { bounds: { start: "2027-01-01" } }]) {
      const row = input(over);
      expect(readThroughSentence(row.importedThroughOn!, row.uncoveredDays, row.bounds)).toBe(budgetCoverageSentence(row));
    }
    // /spending's September on his ledger copy 2026-10-13: every account he spends from read through Aug 12
    expect(readThroughSentence("2026-08-12", 30, { start: "2026-09-01" })).toBe(
      "spending imported through Aug 12 · 30 days of this period unaccounted",
    );
  });
});

/*
 * 🔴 A BUDGET ON A CATEGORY WITH NO ACCOUNT OF ITS OWN COUNTED EVERY ELAPSED DAY, WHILE ITS PAGE ASKED AN ANCESTOR.
 * Measured on a copy of his ledger copy 2026-10-12, with a monthly budget made on Travel › Hotels (3 rows ever, none
 * since March): at 2026-09-02 `/categories/<Hotels>` headlined a measured $0.00 ("This window sits inside what has been
 * imported") over a budget card reading "Awaiting statements · nothing imported for this category since Mar 1 · 2 days
 * of this period unaccounted" — and at 2026-08-12 the same split, 12 days. The page asks the nearest ancestor, then
 * the ledger (§6A 49, `categoryReachFor`); the row counted against no day at all, so it waited for a statement no
 * import could bring. ⛔ The row counts against the page's day now, and names whose day it is in the page's words.
 */
describe("a category with no import day of its own names the day its page counts it against", () => {
  const dormant = (over: Partial<BudgetCoverageInput> = {}): BudgetCoverageInput =>
    input({
      importedThroughOn: null,
      spentFromAccounts: 0,
      spentFromSince: "2026-04-01",
      uncoveredDays: 7,
      bounds: { start: "2026-10-01" },
      ...over,
    });
  const fees = {
    whose: "ancestor" as const,
    name: "Fees",
    coverage: { importedThroughOn: "2026-08-12", spentFromSince: "2026-04-01", spentFromAccounts: 1, spentFromWallets: 0 },
  };

  test("its nearest ancestor's day, named as the ancestor's — the page's 'spending in Fees is imported through'", () => {
    expect(budgetCoverageSentence(dormant({ borrowedDay: fees }))).toBe(
      "nothing imported for this category since Apr 1 · spending in Fees imported through Aug 12 · 7 days of this period unaccounted",
    );
    // the panel's fact is the same two clauses, without the count
    expect(budgetCoverageFact(dormant({ borrowedDay: fees }))).toBe(
      "nothing imported for this category since Apr 1 · spending in Fees imported through Aug 12",
    );
    // spent only from accounts no import dates says so, and names the same day
    expect(budgetCoverageFact(dormant({ spentFromAccounts: 1, borrowedDay: fees }))).toBe(
      "spent only from accounts with no import date since Apr 1 · spending in Fees imported through Aug 12",
    );
  });

  test("an ancestor spent only from cash wallets is named in its own row's words", () => {
    const gifts = (wallets: number) => ({
      whose: "ancestor" as const,
      name: "Gifts & Donations",
      coverage: { importedThroughOn: null, spentFromSince: "2026-04-01", spentFromAccounts: 0, spentFromWallets: wallets },
    });
    expect(budgetCoverageFact(dormant({ borrowedDay: gifts(1) }))).toBe(
      "nothing imported for this category since Apr 1 · Gifts & Donations spent only from a cash wallet since Apr 1",
    );
    expect(budgetCoverageFact(dormant({ borrowedDay: gifts(2) }))).toMatch(/ · Gifts & Donations spent only from cash wallets since Apr 1$/);
  });

  test("the ledger's day, where no ancestor has one — in the ledger's words", () => {
    expect(budgetCoverageSentence(dormant({ borrowedDay: { whose: "ledger", on: "2026-09-24" } }))).toBe(
      "nothing imported for this category since Apr 1 · the ledger imported through Sep 24 · 7 days of this period unaccounted",
    );
    // an empty ledger has no day to name: the category's own fact stands alone
    expect(budgetCoverageFact(dormant({ borrowedDay: { whose: "ledger", on: null } }))).toBe(
      "nothing imported for this category since Apr 1",
    );
  });

  test("a borrowed day outside the graded period's year carries its year", () => {
    const january = { start: "2027-01-01" };
    expect(
      budgetCoverageFact(dormant({ bounds: january, spentFromSince: "2026-07-01", borrowedDay: { whose: "ledger", on: "2026-12-20" } })),
    ).toBe("nothing imported for this category since Jul 1, 2026 · the ledger imported through Dec 20, 2026");
  });

  test("a category with a day of its own, or spent only from cash, never names another's", () => {
    expect(budgetCoverageFact(input({ borrowedDay: fees }))).toBe("spending imported through Sep 2");
    expect(budgetCoverageFact(dormant({ spentFromWallets: 1, borrowedDay: fees }))).toBe("spent only from a cash wallet since Apr 1");
  });
});
