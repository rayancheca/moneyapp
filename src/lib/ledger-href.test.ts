import { describe, expect, test } from "vitest";
import { ledgerHref } from "./ledger-href";

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
