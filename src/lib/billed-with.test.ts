import { describe, expect, test } from "vitest";
import { billedWithLabel, billedWithPhrase, carrierWord, lastSeenOn, type BillingCarrier } from "./billed-with";

/**
 * ⚖️ His decision 59 (2026-10-08): `Rent utilities & fees` ($182.21) is paid INSIDE the rent payment each month —
 * Sep 2 $2,291.21 = rent $2,109.00 + $182.21. Its evidence is the rent's postings, and it reads "billed with the
 * rent, last seen Sep 2" wherever it read "never billed".
 */
const RENT: BillingCarrier = { id: "rent", name: "Flamingo South Beach (rent)", lastMatchedOn: "2026-09-02" };
const TODAY = "2026-10-08";

describe("lastSeenOn — the ONE reading of when a series was last seen", () => {
  test("a series billed with nothing is seen when it last posted itself", () => {
    expect(lastSeenOn({ lastMatchedOn: "2026-08-04", billedWith: null })).toBe("2026-08-04");
    expect(lastSeenOn({ lastMatchedOn: null, billedWith: null })).toBeNull();
  });

  test("a series that never posted, billed with the rent, is seen when the rent last posted", () => {
    expect(lastSeenOn({ lastMatchedOn: null, billedWith: RENT })).toBe("2026-09-02");
  });

  test("its own posting and the carrier's: the NEWER of the two, whichever it is", () => {
    expect(lastSeenOn({ lastMatchedOn: "2026-07-01", billedWith: RENT })).toBe("2026-09-02");
    expect(lastSeenOn({ lastMatchedOn: "2026-09-20", billedWith: RENT })).toBe("2026-09-20");
  });

  test("a carrier that has never posted lends nothing — still never seen", () => {
    expect(lastSeenOn({ lastMatchedOn: null, billedWith: { ...RENT, lastMatchedOn: null } })).toBeNull();
  });
});

describe("carrierWord — what the carrier is called in a sentence", () => {
  test("a name with its own word in parentheses is called by that word", () => {
    expect(carrierWord("Flamingo South Beach (rent)")).toBe("the rent");
    expect(carrierWord("It America LLC (weekly pay)")).toBe("the weekly pay");
  });

  test("any other name is called by its whole name", () => {
    expect(carrierWord("Breezeline")).toBe("Breezeline");
    expect(carrierWord("Car insurance — Nov 11 balance")).toBe("Car insurance — Nov 11 balance");
    // a parenthesis that does not END the name is part of it
    expect(carrierWord("FPL (electricity) old")).toBe("FPL (electricity) old");
    // an empty parenthesis is no word
    expect(carrierWord("Odd ()")).toBe("Odd ()");
  });
});

describe("billedWithPhrase / billedWithLabel — the words where 'never billed' stood", () => {
  test("his line: billed with the rent, last seen Sep 2", () => {
    expect(billedWithPhrase(RENT)).toBe("billed with the rent");
    expect(billedWithLabel({ lastMatchedOn: null, billedWith: RENT }, TODAY)).toBe("billed with the rent, last seen Sep 2");
  });

  test("a last sighting in another year names its year", () => {
    expect(billedWithLabel({ lastMatchedOn: null, billedWith: { ...RENT, lastMatchedOn: "2025-12-02" } }, TODAY)).toBe(
      "billed with the rent, last seen Dec 2, 2025",
    );
  });

  test("its own newer posting is the sighting it names", () => {
    expect(billedWithLabel({ lastMatchedOn: "2026-09-20", billedWith: RENT }, TODAY)).toBe(
      "billed with the rent, last seen Sep 20",
    );
  });

  test("a carrier the bank has never billed is said so, not dated", () => {
    expect(billedWithLabel({ lastMatchedOn: null, billedWith: { ...RENT, lastMatchedOn: null } }, TODAY)).toBe(
      "billed with the rent, which has never been billed",
    );
  });

  test("a series billed with nothing has no such label", () => {
    expect(billedWithLabel({ lastMatchedOn: "2026-09-02", billedWith: null }, TODAY)).toBeNull();
  });
});
