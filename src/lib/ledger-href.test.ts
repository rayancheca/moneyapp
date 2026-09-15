import { describe, expect, test } from "vitest";
import { cashFlowSegmentHref, dayLedgerHref, ledgerHref } from "./ledger-href";

describe("ledgerHref", () => {
  test("no params → the bare ledger", () => {
    expect(ledgerHref({})).toBe("/transactions");
  });

  test("a category id, merchant, account, dates, query, and flow all serialize", () => {
    const href = ledgerHref({
      category: "cat-1",
      merchant: "m-1",
      account: "acct-1",
      from: "2026-01-01",
      to: "2026-01-31",
      q: "coffee",
      flow: "out",
    });
    expect(href).toContain("category=cat-1");
    expect(href).toContain("merchant=m-1");
    expect(href).toContain("account=acct-1");
    expect(href).toContain("from=2026-01-01");
    expect(href).toContain("to=2026-01-31");
    expect(href).toContain("q=coffee");
    expect(href).toContain("flow=out");
  });

  test("category null → the Uncategorized bucket token", () => {
    expect(ledgerHref({ category: null })).toBe("/transactions?category=uncategorized");
  });

  test("the excluded view and money-in flow", () => {
    expect(ledgerHref({ view: "excluded", flow: "in" })).toBe("/transactions?view=excluded&flow=in");
  });

  test("account-scoped day link (investment drill-down)", () => {
    expect(ledgerHref({ account: "a1", from: "2026-07-10", to: "2026-07-10" })).toBe(
      "/transactions?account=a1&from=2026-07-10&to=2026-07-10",
    );
  });
});

describe("dayLedgerHref", () => {
  test("dayLedgerHref is from===to", () => {
    expect(dayLedgerHref("2026-07-04")).toBe("/transactions?from=2026-07-04&to=2026-07-04");
  });
});

describe("cashFlowSegmentHref", () => {
  test("category, Uncategorized, and Other drill to their exact windows", () => {
    expect(cashFlowSegmentHref("cat-abc", "cat-abc", { from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?category=cat-abc&from=2026-07-01&to=2026-07-31",
    );
    expect(cashFlowSegmentHref("__uncat", null, { from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?category=uncategorized&from=2026-07-01&to=2026-07-31&flow=out",
    );
    expect(cashFlowSegmentHref("__other", null, { from: "2026-07-01", to: "2026-07-31" })).toBe(
      "/transactions?from=2026-07-01&to=2026-07-31",
    );
  });

  test("income segments drill positive-only (flow=in) to match the positive-only bar", () => {
    expect(cashFlowSegmentHref("cat-salary", "cat-salary", { from: "2026-07-01", to: "2026-07-31" }, "in")).toBe(
      "/transactions?category=cat-salary&from=2026-07-01&to=2026-07-31&flow=in",
    );
  });

  /**
   * 🔴 …AND SPENDING SEGMENTS DRILL NEGATIVE-ONLY, for the identical reason.
   * The bars are GROSS spending — debits only — so a drill with no direction
   * opens the category's credits too. The Uncategorized branch above has always
   * said so in its own comment ("negatives-only → drill to outflows so it
   * reconciles"); the named categories passed no flow at all. Measured on the
   * real ledger 2026-09-11: **47 of 2,415 drawn segments** opened rows the bar
   * never drew — `?period=2023-03`'s Shopping bar is $339.88 over a list
   * carrying $312.46 of credits.
   */
  test("spending segments drill negative-only (flow=out) to match the gross bar", () => {
    expect(cashFlowSegmentHref("cat-shop", "cat-shop", { from: "2026-07-01", to: "2026-07-31" }, "out")).toBe(
      "/transactions?category=cat-shop&from=2026-07-01&to=2026-07-31&flow=out",
    );
    // …the same shape the Uncategorized bucket already had
    expect(cashFlowSegmentHref("__uncat", null, { from: "2026-07-01", to: "2026-07-31" })).toContain("flow=out");
  });

  /**
   * `ledgerHref` reads `category: null` as "the Uncategorized bucket". A segment
   * that is neither Uncategorized nor Other but carries no category id must NOT
   * inherit that meaning, or its drill would open a different bucket's rows.
   */
  test("a segment with no category id drills to its window, never to Uncategorized", () => {
    expect(cashFlowSegmentHref("cat-gone", null, { from: "2026-07-01", to: "2026-07-31" }, "in")).toBe(
      "/transactions?from=2026-07-01&to=2026-07-31&flow=in",
    );
  });
});
