import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⛔ THE REMOVE-BALANCE DIALOG ASKS THE DERIVATION WHAT REMOVAL CHANGES.
 *
 * It used to count the checked days in the STORED series from the balance's own
 * date up to the next recorded one (`daysPinnedBy`), which repeats none of the
 * rules that decide whether a balance carries the curve. Measured 2026-09-14 on
 * the owner's ledger: Robinhood Cash's live reading of 2026-07-10 read "Days that
 * stop being verified: 21 days" and Chase Sapphire's manual $0.00 of 2025-02-03
 * read "27 days" — removing either changes no verified day at all.
 *
 * A source gate, like the page's siblings: the page is an async server component
 * that reads the database. The NUMBERS are pinned where they are computed —
 * `removalEffect` in services/derivation.test.ts, and the prediction held to a
 * real `deleteAnchor` in services/anchors.test.ts.
 */

const source = fs.readFileSync(path.join(process.cwd(), "src/app/accounts/[id]/page.tsx"), "utf8");

describe("/accounts/[id] — the remove-balance dialog's blast radius", () => {
  test("no local date-range count survives", () => {
    expect(source).not.toMatch(/daysPinnedBy/);
  });

  test("every row's prediction comes out of ONE load, not one per row", () => {
    expect(source.match(/anchorRemovalEffects\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/anchorRemovalEffect\(/);
  });

  test("priced-from-holdings is the rebuild's predicate, never provenance's verdict", () => {
    expect(source).not.toMatch(/"market_value"/);
  });

  /**
   * 🔴 The page kept its own headline and reassurance, and no test read either:
   * "Removing it leaves those days to be derived from transactions alone" and
   * "it rebuilds from what is left" over Cash on Hand's only balance, whose
   * removal leaves no row. The sentences live in `removeBalanceRadius` now,
   * pinned branch by branch in components/accounts/remove-balance-radius.test.ts.
   */
  test("every sentence of the dialog comes from removeBalanceRadius, and the page keeps no copy", () => {
    expect(source.match(/removeBalanceRadius\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/function removeBalanceHeadline/);
    // (the archive dialog's own "puts it back exactly as it is now" is not this dialog's)
    expect(source).not.toMatch(/rebuilds from what is left|re-verify these days|leaves the curve exactly as it is/);
  });
});

/**
 * 🔴 THE CHART'S EXACT DAYS ARE GRADED HERE, WHERE NO SERVICE TEST LOOKS.
 * `BalanceChartPanel` is a client component, so the page grades each point before
 * handing it over. Reverting that one expression to `p.basis === "anchored" ||
 * p.basis === "derived" || balanceDayIsExact("investment", p.basis)` — every
 * cash and credit `carried` day dashed again — passed all 163 tests of the six
 * suites the fix touches. The rule itself is pinned in services/coverage.test.ts.
 */
describe("/accounts/[id] — the balance chart's exact days", () => {
  test("each point is graded by balanceDayIsExact for THIS account's type, and by nothing local", () => {
    const panel = source.match(/<BalanceChartPanel[\s\S]*?\/>/)?.[0] ?? "";
    expect(panel).toMatch(/exact: balanceDayIsExact\(account\.type, p\.basis\),/);
    expect(source.match(/balanceDayIsExact\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/basis === "/);
  });
});

/**
 * 🔴 THE HEADER CHIP READ THE SERIES' OWN LAST PAIR, and for an account priced
 * from holdings that pair is carried past the newest close. Measured on the real
 * ledger, Tue 2026-09-15: Robinhood Brokerage read "Today $0.00" above a Day
 * column dated "Sep 14 vs Sep 11" whose rows sum to +$1,110.27. The figure and
 * its name are `accountDayChange`'s — the rule the account's card reads, pinned in
 * services/account-day-change.test.ts.
 */
describe("/accounts/[id] — the header's day change", () => {
  test("the chip is accountDayChange's, and the page keeps no pair of days of its own", () => {
    expect(source.match(/accountDayChange\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/const dayTerm = change\.heading\.interval \?\? change\.heading\.label;/);
    expect(source).not.toMatch(/dayChangeLabel\(|series\[series\.length - 2\]/);
  });
});

/**
 * ⚖️ The agent's brokerage book is kept out of his returns (owner, 2026-09-14), and the holding page shows his legs
 * only (`holdingDetail`). 🔴 The book's page linked its rows there anyway: to a page about his shares, or a 404.
 */
describe("/accounts/[id] — the holdings table links to a holding page only for his books", () => {
  test("the table is told by ownPortfolioAccountIds, the holding page's own rule", () => {
    const table = source.match(/<AccountHoldingsTable[\s\S]*?\/>/)?.[0] ?? "";
    expect(table).toMatch(/opensHoldingPages=\{ownPortfolioAccountIds\(db\)\.has\(id\)\}/);
  });
});
