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
    expect(page).toMatch(
      /<CoveragePanel coverage=\{coverage\} pricedFromHoldingsIds=\{pricedFromHoldingsIds\} heldCounts=\{heldCounts\} \/>/,
    );
    expect(panel).toMatch(/pricedFromHoldings: pricedFromHoldingsIds\.includes\(c\.accountId\),/);
  });

  /*
   * 🔴 A value he TYPED read "held at its recorded balance" on its row, beside its balance proof's "the balance you
   * counted on Sep 1, 2026, held forward" (review, 2026-10-05). ⛔ The day is the rule net worth reads
   * (`heldCountsByAccount`, on the day `accountCoverage` grades by); the wording is pinned in
   * lib/coverage-detail.test.ts, the rule in services/provenance.test.ts.
   */
  test("an account held at a balance he typed is named by the rule net worth reads, on today", () => {
    expect(page).toMatch(/const heldCounts = heldCountsByAccount\(db, coverage\);/);
    expect(panel).toMatch(/heldCountedOn: heldCounts\.get\(c\.accountId\) \?\? null,/);
  });
});

/**
 * ⚖️ Owner, 2026-09-28: a line another still-imported file prints that a re-read no longer writes stays out of the
 * ledger and is named under that read. The wording and the grouping are pinned in lib/import-file-label.test.ts, the
 * rule in services/import/lines-left-out.test.ts; this pins that the page asks that rule and renders its answer.
 */
describe("/imports — a line a re-read left out, under the read", () => {
  test("read from the ledger by the rule `pnpm ledger-check` reads, grouped by the read that left it out", () => {
    expect(page).toMatch(/const leftOutByRead = leftOutNoticesByRead\(linesLeftOut\(db\)\);/);
  });

  test("every notice for the row's file is rendered, whole", () => {
    expect(page).toMatch(/\{leftOutByRead\.get\(f\.id\)\?\.map\(\(notice, i\) => \(/);
    expect(page).toMatch(/className="text-\[11px\] text-warning">\s*\{notice\}/);
  });
});

/**
 * 🔴 The footer under "What the statements proved" called all five of his balance-less periods "a spending report, an
 * export without a closing figure" (copy of his ledger, 2026-10-12) — two were Robinhood opening statements, statements
 * by the statement schedule's rule (`countsAsStatement`). Which periods the list holds and what the footer says of
 * the rest are pinned in services/statement-evidence.test.ts and lib/statement-evidence-notes.test.ts; this pins that
 * the page asks them, and filters nothing of its own.
 */
describe("/imports — what the statements proved, and what its footer names", () => {
  test("the list, its counts and its footer are read from `statementEvidence`", () => {
    expect(page).toMatch(/const \{ periods, evidence, balanceLess \} = statementEvidence\(db\);/);
    expect(page).toMatch(/const recentPeriods = evidence\.slice\(0, RECENT_PERIODS\)\.map\(/);
    expect(page).not.toMatch(/carriesBalances\(|countsAsStatement\(|balanceLessKind\(/);
  });

  // 🔴 …and a download that recorded a balance was "an export without a closing figure" (review of 601f155): every
  // count the footer names arrives in `balanceLess` whole, so the page cannot hand it two of three
  test("the footer renders every note `balanceLessNotes` gives, and writes none of its own", () => {
    expect(page).toMatch(/\{balanceLessNotes\(balanceLess\)\.map\(\(note\) => \(/);
    expect(page).toMatch(/<p key=\{note\} className="mt-1 text-xs text-ink-faint">\s*\{note\}\s*<\/p>/);
    expect(page).not.toMatch(/carried no balance|recorded a balance/);
  });
});
