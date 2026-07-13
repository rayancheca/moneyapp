import { describe, expect, test } from "vitest";
import { accountSlug, institutionSlug } from "./account-slug";

/** The 9 real accounts must produce exactly the user-confirmed folder slugs. */
const CASES: [{ name: string; type: string; last4: string | null }, string, string][] = [
  [{ name: "Chase ····3522", type: "checking", last4: "3522" }, "Chase", "chase-checking-3522"],
  [{ name: "Chase Sapphire", type: "credit", last4: "9805" }, "Chase", "chase-sapphire-9805"],
  [{ name: "Venture X", type: "credit", last4: "4147" }, "Capital One", "capital-one-venturex-4147"],
  [{ name: "Discover", type: "credit", last4: "4741" }, "Discover", "discover-4741"],
  [{ name: "Robinhood Brokerage", type: "investment", last4: "3525" }, "Robinhood", "robinhood-brokerage-3525"],
  [{ name: "Robinhood Crypto", type: "investment", last4: null }, "Robinhood", "robinhood-crypto"],
  [{ name: "Robinhood Cash", type: "checking", last4: null }, "Robinhood", "robinhood-cash"],
  [{ name: "SoFi Checking", type: "checking", last4: "9067" }, "SoFi", "sofi-checking-9067"],
  [{ name: "SoFi Savings", type: "savings", last4: "5791" }, "SoFi", "sofi-savings-5791"],
];

describe("accountSlug", () => {
  test.each(CASES)("%o @ %s → %s", (account, institution, expected) => {
    expect(accountSlug(account, institution)).toBe(expected);
  });

  test("falls back to the type when the name reduces to just the institution + card glyphs", () => {
    // synthetic auto-created stub (name is institution + masked digits)
    expect(accountSlug({ name: "Chase ····4321", type: "checking", last4: "4321" }, "Chase")).toBe(
      "chase-checking-4321",
    );
  });

  test("never emits a bare institution slug (always carries a discriminator)", () => {
    expect(accountSlug({ name: "Discover", type: "credit", last4: null }, "Discover")).toBe(
      "discover-credit",
    );
  });

  test("slugs are filesystem-safe (lowercase, single dashes, no glyphs)", () => {
    const slug = accountSlug({ name: "Robinhood Crypto", type: "investment", last4: null }, "Robinhood");
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("institutionSlug", () => {
  test("kebab-cases institution names for the combined/fallback bucket", () => {
    expect(institutionSlug("Capital One")).toBe("capital-one");
    expect(institutionSlug("SoFi")).toBe("sofi");
  });
});
