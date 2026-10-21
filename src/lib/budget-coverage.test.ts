import { describe, expect, test } from "vitest";
import {
  budgetCoverageFact,
  budgetCoverageSentence,
  countedFlow,
  nothingFoundSoFar,
  nothingFoundSoFarSentence,
  partReadTotal,
  readThroughSentence,
  spendingNotFoundFact,
  spendUnread,
  spentOnlyFromCashWallets,
  type BudgetCoverageInput,
} from "./budget-coverage";
import { A_LOWER_BOUND } from "./empty-period";

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
 * ⚖️ Decision 72 on a Received or Net page (ruled implied 2026-10-14): its total is graded by its category's own day as
 * a Spent total is, and the line's first word follows what the page counts — the noun its empty state already uses
 * ("income in Salary is imported through …"). ⛔ One builder: the line, the borrowed clause and the empty state ask
 * `countedFlow`.
 */
describe("the first word follows what is counted", () => {
  const line = (noun: string): string => `${noun} imported through Sep 2 · 13 days of this period unaccounted`;

  test("a Received page's line says income, a Net page's activity; a Spent page's is unchanged", () => {
    expect(countedFlow("expense")).toBe("spending");
    expect(countedFlow("income")).toBe("income");
    for (const kind of ["transfer", "rewards", "investment", "system"] as const) {
      expect(countedFlow(kind)).toBe("activity");
    }
    expect(budgetCoverageSentence(input({ counted: "income" }))).toBe(line("income"));
    expect(budgetCoverageSentence(input({ counted: "activity" }))).toBe(line("activity"));
    expect(budgetCoverageSentence(input())).toBe(line("spending"));
  });

  test("…and so does an ancestor's day it borrows — a subtree is one kind", () => {
    const coverage = { importedThroughOn: "2026-09-24", spentFromSince: "2026-04-01", spentFromAccounts: 1, spentFromWallets: 0 };
    const income = { whose: "ancestor" as const, name: "Income", coverage };
    const dormant = { importedThroughOn: null, spentFromAccounts: 0, spentFromSince: "2026-04-01", counted: "income" as const };
    expect(budgetCoverageSentence(input({ ...dormant, borrowedDay: income }))).toBe(
      "nothing imported for this category since Apr 1 · income in Income imported through Sep 24 · " +
        "13 days of this period unaccounted",
    );
    const cash = { ...income, coverage: { ...coverage, importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1 } };
    expect(budgetCoverageFact(input({ ...dormant, borrowedDay: cash }))).toBe(
      "nothing imported for this category since Apr 1 · Income received only into a cash wallet since Apr 1",
    );
  });

  /*
   * 🔴 Measured on the pristine e2e fixture (today 2026-07-08): `/categories/<Dividends>` for 2026 to date, its rows on
   * a brokerage account no import dates, would have read "spent only from accounts with no import date since Jan 1 ·
   * income in Income imported through Jul 5 · 3 days of this period unaccounted" — spending's verb on a Received page.
   */
  test("…and so does the verb, wherever its accounts have no day of their own", () => {
    const noDay = { importedThroughOn: null, spentFromAccounts: 1 };
    const since = "accounts with no import date since Mar 1";
    expect(budgetCoverageFact(input({ ...noDay, counted: "income" }))).toBe(`received only into ${since}`);
    expect(budgetCoverageFact(input({ ...noDay, counted: "activity" }))).toBe(`moved only through ${since}`);
    expect(budgetCoverageFact(input(noDay))).toBe(`spent only from ${since}`);
    const cash = { importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1 };
    expect(budgetCoverageFact(input({ ...cash, counted: "income" }))).toBe("received only into a cash wallet since Mar 1");
    expect(budgetCoverageFact(input(cash))).toBe("spent only from a cash wallet since Mar 1");
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

/*
 * ⚖️ Decision 72 under a sentence whose subject is NOT the category (review of fdcebdc, finding 3): a merchant page's
 * share sentence prints the line of the category it is a share of. 🔴 Measured on his ledger copy 2026-10-21: IKEA's
 * rank read "spending imported through Oct 2, 2026 · 10 days of this period unaccounted" and, one line down over the
 * same Oct 27, 2025 – Oct 12, 2026, its share of Housing "spending imported through Jul 31, 2026 · 73 days of this
 * period unaccounted" — two days for one window, and neither said the second was Housing's. ⛔ The borrowed clause's
 * own words ("spending in Fees imported through …"): one builder names a category's day wherever it is not the line's
 * own subject.
 */
describe("a category's line under another subject's sentence names the category (`namedFor`)", () => {
  test("its own day, in the borrowed clause's words — and the first word still follows what it counts", () => {
    expect(budgetCoverageSentence(input({ namedFor: "Housing" }))).toBe(
      "spending in Housing imported through Sep 2 · 13 days of this period unaccounted",
    );
    expect(budgetCoverageFact(input({ namedFor: "Salary", counted: "income" }))).toBe(
      "income in Salary imported through Sep 2",
    );
  });

  test("with no day of its own, 'this category' is the category, and the day it borrows names whose it is", () => {
    const travel = {
      whose: "ancestor" as const,
      name: "Travel",
      coverage: { importedThroughOn: "2026-08-12", spentFromSince: "2026-04-01", spentFromAccounts: 1, spentFromWallets: 0 },
    };
    const dormant = { importedThroughOn: null, spentFromAccounts: 0, spentFromSince: "2026-04-01", uncoveredDays: 7 };
    expect(budgetCoverageSentence(input({ ...dormant, namedFor: "Hotels", borrowedDay: travel }))).toBe(
      "nothing imported for Hotels since Apr 1 · spending in Travel imported through Aug 12 · 7 days of this period unaccounted",
    );
    const noDay = { importedThroughOn: null, spentFromAccounts: 1 };
    expect(budgetCoverageFact(input({ ...noDay, namedFor: "Dividends", counted: "income" }))).toBe(
      "Dividends received only into accounts with no import date since Mar 1",
    );
    const cash = { importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1 };
    expect(budgetCoverageFact(input({ ...cash, namedFor: "Tips" }))).toBe("Tips spent only from a cash wallet since Mar 1");
  });

  test("a borrowed ancestor is named by the same rule — the clause and the named line are one builder", () => {
    const coverage = { importedThroughOn: null, spentFromSince: "2026-04-01", spentFromAccounts: 0, spentFromWallets: 1 };
    const gifts = { whose: "ancestor" as const, name: "Gifts & Donations", coverage };
    const dormant = { importedThroughOn: null, spentFromAccounts: 0, spentFromSince: "2026-04-01" };
    // the ancestor's clause is exactly its own fact, named
    const named = budgetCoverageFact(input({ ...coverage, namedFor: "Gifts & Donations" }));
    expect(named).toBe("Gifts & Donations spent only from a cash wallet since Apr 1");
    expect(budgetCoverageFact(input({ ...dormant, borrowedDay: gifts }))).toBe(
      `nothing imported for this category since Apr 1 · ${named}`,
    );
  });
});

/*
 * ⚖️ Decisions 64 + 72 for a window of ALL his spending that is no total — one cash-flow bucket, one heatmap day: where it
 * holds no spending row and not one of its elapsed days is read by the day every account he spends from is imported
 * through, its Spent is "—", and this is why. 🔴 Measured on his ledger copy 2026-10-13 (review of 2fce458):
 * `/spending?period=2026-09` — all spending read through Aug 12, the ledger through Sep 24 — tabled Sep 13 … Sep 22
 * "$0.00 $0.00 $0.00" and Sep 23 "Spent $0.00" beside its $4,567.68, under a heatmap calling those days unaccounted.
 */
describe("spendingNotFoundFact — a window past the day all his spending is read through, with none found in it", () => {
  const READ = "2026-08-12";
  const window = { today: "2026-10-13", ledgerOpens: "2022-08-25", readThrough: READ, spentCents: 0 };
  const day = (iso: string, over: Partial<Parameters<typeof spendingNotFoundFact>[0]> = {}) =>
    spendingNotFoundFact({ ...window, from: iso, to: iso, ...over });

  test("the day it is read through is a measurement; the day after it names that day", () => {
    expect(day("2026-08-12")).toBeNull();
    expect(day("2026-08-13")).toBe("spending imported through Aug 12");
  });

  test("a window holding spending keeps its figure, however little of it is read", () => {
    expect(day("2026-09-05", { spentCents: 7_121 })).toBeNull();
  });

  test("a window with one day of its own read is a lower bound, not a dash", () => {
    expect(spendingNotFoundFact({ ...window, from: "2026-08-12", to: "2026-08-20" })).toBeNull();
    expect(spendingNotFoundFact({ ...window, from: "2026-08-13", to: "2026-08-20" })).toBe("spending imported through Aug 12");
  });

  test("a running window counts only the days that have happened", () => {
    const october = { ...window, from: "2026-10-01", to: "2026-10-31" };
    expect(spendingNotFoundFact(october)).toBe("spending imported through Aug 12");
    // read through today: every elapsed day is read, and the days still to come are no part of the claim
    expect(spendingNotFoundFact({ ...october, readThrough: "2026-10-13" })).toBeNull();
  });

  test("a window that has not begun has not happened — that is not this", () => {
    expect(day("2026-10-20")).toBeNull();
  });

  /* ⚖️ a ledger of cash wallets alone has no day a statement could move (2026-09-15): nothing is waited for */
  test("with no day to read against there is nothing to wait for", () => {
    expect(day("2026-08-13", { readThrough: null })).toBeNull();
  });

  test("a read day outside the window's year carries its year", () => {
    expect(day("2027-01-05", { today: "2027-01-20", readThrough: "2026-12-30" })).toBe("spending imported through Dec 30, 2026");
  });

  test("the words a cell, a tooltip or a sheet prints for it", () => {
    expect(nothingFoundSoFar("spending imported through Aug 12")).toBe("nothing found so far — spending imported through Aug 12");
    // …and a /spending card's whole empty sentence, in the same words
    expect(nothingFoundSoFarSentence("spending imported through Aug 12")).toBe(
      "Nothing found so far — spending imported through Aug 12.",
    );
  });
});

/*
 * ⚖️ What a total read only in part is, by what it counts (review of fdcebdc, his ledger copy 2026-10-21): a Spent or
 * Received total can only gain from the days still to import; a Net — 43 of his windows — can move either way.
 */
describe("partReadTotal", () => {
  test("spending and income are lower bounds — the empty state's own words for a zero", () => {
    expect(partReadTotal("spending")).toBe(A_LOWER_BOUND);
    expect(partReadTotal("income")).toBe(A_LOWER_BOUND);
  });

  test("a Net is neither a measurement nor a bound", () => {
    expect(partReadTotal("activity")).toBe(
      "neither a measurement nor a bound: the days still to import can move it either way",
    );
    expect(partReadTotal("activity")).not.toMatch(/lower bound/);
  });
});
