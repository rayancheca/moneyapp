import { describe, expect, test } from "vitest";
import { BRAND_ICONS } from "./brand-icons.generated";
import { brandMarkFor, monogramFor, normalizeForBrand } from "./brand-mark";

describe("normalizeForBrand", () => {
  test("collapses every punctuation run to one space", () => {
    // Real descriptors from the ledger, none of them tidy.
    expect(normalizeForBrand("UBER *ONE")).toBe("uber one");
    expect(normalizeForBrand("TMOBILE*PREPD AUTOPY 877-778-2106")).toBe(
      "tmobile prepd autopy 877 778 2106",
    );
    expect(normalizeForBrand("  Flamingo South Beach (rent)  ")).toBe("flamingo south beach rent");
  });
});

describe("monogramFor", () => {
  test.each([
    ["Netflix", "N"],
    ["Extra Space Storage", "ES"],
    ["Cash job (weekly pay)", "CJ"],
    ["7-Eleven", "7E"],
    ["YOUTUBEPREMIUM", "Y"],
  ])("%s → %s", (name, expected) => {
    expect(monogramFor(name)).toBe(expected);
  });

  test("a name with nothing alphanumeric still yields a mark", () => {
    // `<UNKNOWN>` is a merchant the importer really creates; a blank tile would
    // read as a rendering failure rather than as an unnamed charge.
    expect(monogramFor("***")).toBe("?");
    expect(monogramFor("")).toBe("?");
  });
});

describe("brandMarkFor", () => {
  test("finds a logo inside an untidy bank descriptor", () => {
    const m = brandMarkFor("YOUTUBEPREMIUM");
    expect(m.kind).toBe("logo");
    expect(m.icon?.title).toBe("YouTube");
  });

  test("the longest fragment wins over one it contains", () => {
    // Both "uber" and "ubereats" match "UBER EATS"; sorting by length is what
    // stops the shorter, more generic brand from shadowing the specific one.
    expect(brandMarkFor("UBER EATS").icon?.title).toBe("Uber Eats");
    expect(brandMarkFor("UBER *ONE").icon?.title).toBe("Uber");
  });

  test("a logo mark still carries a monogram to fall back to", () => {
    expect(brandMarkFor("Netflix")).toMatchObject({ kind: "logo", monogram: "N" });
  });

  test("an unmatched merchant monograms rather than failing", () => {
    // The common case on this ledger: simple-icons has dropped Amazon, OpenAI,
    // T-Mobile and every US utility, so most real series land here.
    expect(brandMarkFor("Breezeline (internet)")).toEqual({
      kind: "monogram",
      icon: null,
      monogram: "BI",
    });
    expect(brandMarkFor("FPL (electricity)").kind).toBe("monogram");
    expect(brandMarkFor("CHATGPT SUBSCRIPTION").kind).toBe("monogram");
  });

  test("a fragment is never matched against a word that merely contains it", () => {
    // Pass 32: `/CHASE/i` matched "purCHASE" and routed a statement to the wrong
    // parser. The bank brand is spelled as the forms a statement actually prints.
    expect(brandMarkFor("PURCHASE INTEREST CHARGE").kind).toBe("monogram");
    expect(brandMarkFor("Chase Sapphire").icon?.title).toBe("Chase");
  });

  test("every fragment in the table resolves to an icon that was vendored", () => {
    // A slug that is not in the generated file silently falls through to the
    // monogram, which looks like a design choice rather than a broken mapping.
    // Probing through the public API keeps the table itself private.
    const probes: [string, boolean][] = [
      ["netflix", true],
      ["spotify", true],
      ["robinhood", true],
      ["a merchant nobody has heard of", false],
    ];
    for (const [name, shouldMatch] of probes) {
      expect(brandMarkFor(name).kind === "logo").toBe(shouldMatch);
    }
    expect(Object.keys(BRAND_ICONS).length).toBeGreaterThan(50);
  });
});
