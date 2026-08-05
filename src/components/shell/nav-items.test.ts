import { describe, expect, it } from "vitest";

import { navLabel } from "./nav-items";

/**
 * The pills are `aria-hidden`, so this string is the entire accessible name.
 * The review-only branch must stay byte-identical — the e2e and a11y specs
 * assert on it, and it predates the duplicates pill.
 */
describe("navLabel", () => {
  it("is undefined when there is nothing to announce", () => {
    expect(navLabel("Transactions", 0, 0)).toBeUndefined();
  });

  it("keeps the historical review-only wording exactly", () => {
    expect(navLabel("Transactions", 3, 0)).toBe("Transactions, 3 to review");
  });

  it("says PAIRS, because a count of candidates is not a count of charges", () => {
    // two identical charges in each of two files produce FOUR candidates
    expect(navLabel("Transactions", 0, 4)).toBe("Transactions, 4 duplicate pairs to resolve");
  });

  it("singularizes one pair", () => {
    expect(navLabel("Transactions", 0, 1)).toBe("Transactions, 1 duplicate pair to resolve");
  });

  it("announces both queues separately rather than merging them", () => {
    expect(navLabel("Transactions", 2, 1)).toBe(
      "Transactions, 2 to review, 1 duplicate pair to resolve",
    );
  });
});
