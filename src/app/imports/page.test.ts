import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⛔ WHICH ACCOUNTS HOLDINGS PRICE IS THE REBUILD'S BRANCH, DECIDED ON THIS PAGE.
 *
 * `accountCoverage` grades EVERY investment account `market_value`, and the
 * coverage row read "priced from holdings" off that grade — of an account with no
 * holding events too, whose curve is a recorded balance held flat. The row now
 * takes `pricedFromHoldings`, and this page computes it with `derivesFromHoldings`.
 * Changing that filter to `c.accountType === "investment" || derivesFromHoldings(…)`
 * passed every unit test: neither the real ledger nor the e2e fixture has an
 * investment account without holdings, so no spec reaches the other wording.
 *
 * A source gate, like /accounts/[id]'s: the page is an async server component that
 * reads the database. The wording is pinned in lib/coverage-detail.test.ts, the
 * predicate in services/derivation.
 */

const page = fs.readFileSync(path.join(process.cwd(), "src/app/imports/page.tsx"), "utf8");
const panel = fs.readFileSync(path.join(process.cwd(), "src/components/imports/CoveragePanel.tsx"), "utf8");

describe("/imports — the coverage rows' holdings claim", () => {
  test("an account is priced from holdings when derivesFromHoldings says so, and on no other test", () => {
    const decided = page.match(/const pricedFromHoldingsIds = coverage\s*\.filter\(\(c\) => ([^\n]*)\)\s*\.map\(\(c\) => c\.accountId\);/);
    expect(decided?.[1]).toBe("derivesFromHoldings(db, { id: c.accountId, type: c.accountType as AccountType })");
  });

  test("the panel is handed exactly those ids, and each row reads its own", () => {
    expect(page).toMatch(/<CoveragePanel coverage=\{coverage\} pricedFromHoldingsIds=\{pricedFromHoldingsIds\} \/>/);
    expect(panel).toMatch(/pricedFromHoldings: pricedFromHoldingsIds\.includes\(c\.accountId\),/);
  });
});
