import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { E2E_FAKE_TODAY } from "./seed-helpers";

/**
 * The per-row close date on /investments — both halves of when it speaks.
 *
 * The seeded fixture prices every holding THROUGH fake-today, so on the normal
 * seed nothing here renders at all. That is correct (a row quoted today has no
 * age to report) but it leaves the feature invisible to every other spec and to
 * all sixteen investments baselines: deleting the sub-line from the component
 * would not turn a single one of them red.
 *
 * So this spec ages closes directly in the database. There is no UI gesture
 * that makes a price older — prices only move forward, via Refresh — so driving
 * it through the app is not available, the same reasoning
 * `zz-zz-zz-duplicate-pairs` gives for seeding its pair directly.
 *
 * What it pins is the rule that decides WHERE the age is stated:
 *
 *   rows DISAGREE about their close date → each stale row prints its own date,
 *     and the column header stays silent because no one date describes the
 *     column. The page note is silent too here — it is gated on the NEWEST
 *     close and goes quiet the moment any one symbol is refreshed — so the rows
 *     are the only disclosure, which is exactly why they exist.
 *
 *   rows AGREE → the COLUMN HEADER carries the date once, and no row repeats
 *     it. Agreeing is the normal state, including the owner's real portfolio,
 *     whose ten positions have shared one close since it was last refreshed.
 *
 * Both come out of a single `priceColumnAge` call, so the two surfaces cannot
 * double up on one fact or both fall silent about it.
 *
 * Named `zz-zz-zz-` so it sorts after every spec that photographs or totals the
 * portfolio: removing closes moves value, day change and sparklines, which would
 * shift an investments baseline shot before it. Every deleted row is put back,
 * and the database is reseeded from scratch on every run, so nothing leaks.
 */

const DB_PATH = "data/e2e.db";

interface PriceRow {
  id: string;
  symbol: string;
  asset_type: string;
  quoted_on: string;
  close: number;
  source: string;
  fetched_at: string;
  created_at: string;
  updated_at: string;
}

/** the four seeded positions, as (symbol, asset_type) — WMT is an etf */
const SEEDED: readonly (readonly [string, string])[] = [
  ["AAPL", "stock"],
  ["MSFT", "stock"],
  ["WMT", "etf"],
  ["ETH", "crypto"],
];

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Drop every close after `cutoff` for the given positions; returns what it removed. */
function ageTo(cutoff: string, positions: readonly (readonly [string, string])[]): PriceRow[] {
  return withDb((db) => {
    const select = db.prepare(
      `SELECT * FROM price_cache
        WHERE symbol = ? AND asset_type = ? AND quoted_on > ?
        ORDER BY quoted_on`,
    );
    const remove = db.prepare(
      `DELETE FROM price_cache WHERE symbol = ? AND asset_type = ? AND quoted_on > ?`,
    );

    const removed: PriceRow[] = [];
    for (const [symbol, assetType] of positions) {
      const rows = select.all(symbol, assetType, cutoff) as PriceRow[];
      // Guards the fixture assumption the whole spec rests on. If the seed ever
      // stops pricing through fake-today, ageing is a no-op and every assertion
      // below would pass for the wrong reason.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.at(-1)!.quoted_on).toBe(E2E_FAKE_TODAY);
      removed.push(...rows);
      remove.run(symbol, assetType, cutoff);
    }
    return removed;
  });
}

function restore(rows: readonly PriceRow[]): void {
  withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO price_cache
         (id, symbol, asset_type, quoted_on, close, source, fetched_at, created_at, updated_at)
       VALUES
         (@id, @symbol, @asset_type, @quoted_on, @close, @source, @fetched_at, @created_at, @updated_at)`,
    );
    db.transaction((batch: readonly PriceRow[]) => {
      for (const r of batch) insert.run(r);
    })(rows);
  });
}

test.describe("when the holdings disagree about their close date", () => {
  // AAPL alone falls three days behind; the other three stay quoted today
  let removed: PriceRow[] = [];
  test.beforeAll(() => {
    removed = ageTo("2026-07-05", [["AAPL", "stock"]]);
  });
  test.afterAll(() => restore(removed));

  test("the stale row dates itself, and the page note stays silent", async ({ page }) => {
    await page.goto("/investments");
    await expect(page.getByRole("heading", { level: 1, name: "Investments" })).toBeVisible();

    const stale = page.getByRole("row").filter({ hasText: "AAPL" }).first();
    await expect(stale.getByText("as of Jul 5")).toBeVisible();

    // the rows still quoted today say nothing
    await expect(page.getByRole("row").filter({ hasText: "MSFT" }).first().getByText(/^as of /)).toHaveCount(0);
    await expect(page.getByText(/^as of /)).toHaveCount(1);

    // and the column header does NOT date itself: three of the four holdings
    // are quoted today, so "Price as of Jul 5" over this column would be a
    // false claim about them
    await expect(page.getByRole("columnheader", { name: /^Price/ })).toHaveText("Price");

    // THE POINT: the page-level note is gated on the newest close, and three
    // holdings are still quoted today — so it is absent while one sits three
    // days behind. Without the per-row date, nothing on this page discloses it.
    await expect(page.getByText(/still carries its close from/)).toHaveCount(0);
    await expect(page.getByText(/oldest close behind these figures/)).toHaveCount(0);
  });

  test("the stale row explains that the figure is stored, not live", async ({ page }) => {
    await page.goto("/investments");
    const stale = page.getByRole("row").filter({ hasText: "AAPL" }).first();

    await expect(stale.getByText("as of Jul 5")).toHaveAttribute(
      "title",
      /^Priced 3 days ago\..*stored close, not a live quote/,
    );
  });
});

test.describe("when every holding carries the same close date", () => {
  // all four fall behind together — the normal shape of a portfolio that has
  // simply not been refreshed, and the state of the owner's real one
  let removed: PriceRow[] = [];
  test.beforeAll(() => {
    removed = ageTo("2026-07-05", SEEDED);
  });
  test.afterAll(() => restore(removed));

  test("the COLUMN says it once and no row repeats it", async ({ page }) => {
    await page.goto("/investments");
    await expect(page.getByRole("heading", { level: 1, name: "Investments" })).toBeVisible();

    // the fact belongs to the whole column, so the column header carries it —
    // adjacent to every number it qualifies, and stated exactly once
    const header = page.getByRole("columnheader", { name: /^Price/ });
    await expect(header).toContainText("as of Jul 5");

    // …and not one of the four rows repeats it
    for (const symbol of ["AAPL", "MSFT", "WMT", "ETH"]) {
      await expect(page.getByRole("row").filter({ hasText: symbol }).first().getByText(/^as of /)).toHaveCount(0);
    }
    // exactly one "as of" on the page: the header's
    await expect(page.getByText(/^as of /)).toHaveCount(1);

    // the note still speaks too — it carries the CONSEQUENCE (market value and
    // allocation are computed from these closes), which a column label cannot
    await expect(page.getByText(/still carries its close from/)).toBeVisible();
  });

  test("the account-detail holdings table dates its column too", async ({ page }) => {
    // This page has no `holdingPriceSectionNotes` at all, so before the column
    // header there was NOTHING on it disclosing that Price, Day, Value, P/L and
    // Alloc all came from a close five days old.
    // the same resolver visual.spec uses — the Robinhood section's first
    // account link is the brokerage, which holds AAPL, MSFT and WMT
    await page.goto("/accounts");
    const href = await page
      .locator('section[aria-label="Robinhood"] a[href^="/accounts/"]')
      .first()
      .getAttribute("href");
    expect(href).not.toBeNull();
    await page.goto(href!);

    await expect(page.getByRole("columnheader", { name: /^Price/ })).toContainText("as of Jul 5");
    // the rows stay clean — the column spoke for all three
    await expect(page.getByRole("row").filter({ hasText: "AAPL" }).first().getByText(/^as of /)).toHaveCount(0);
  });
});
