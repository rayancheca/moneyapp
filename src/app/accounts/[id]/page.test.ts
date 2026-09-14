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
