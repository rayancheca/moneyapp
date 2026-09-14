import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { HonestyBucketsCard } from "./HonestyBucketsCard";

/**
 * ⛔ The empty state says what was CHECKED. The uncategorized bucket counts
 * uncategorized OUTFLOWS only (a credit belongs to the review queue), so
 * "Everything this period is categorized and accounted for" would have stood
 * over an uncategorized deposit in a month with no uncategorized spending.
 * Not on the real ledger today — its one month with uncategorized deposits
 * (2023-11) also has uncategorized spending, so the card lists it.
 */
describe("HonestyBucketsCard", () => {
  const empty = {
    uncategorized: { spentCents: 0, txnCount: 0, href: "/transactions?category=uncategorized&flow=out" },
    excluded: { txnCount: 0, href: "/transactions?view=excluded" },
  };

  test("an empty report names the two things it checked, not everything", () => {
    const html = renderToStaticMarkup(createElement(HonestyBucketsCard, { data: empty }));
    expect(html).toContain("No uncategorized spending and no excluded rows this period.");
    expect(html).not.toMatch(/Everything this period/);
  });

  test("a bucket with rows is listed instead", () => {
    const html = renderToStaticMarkup(
      createElement(HonestyBucketsCard, { data: { ...empty, uncategorized: { ...empty.uncategorized, spentCents: 3_000, txnCount: 1 } } }),
    );
    expect(html).toContain("1 transaction");
    expect(html).not.toContain("No uncategorized spending");
  });
});
