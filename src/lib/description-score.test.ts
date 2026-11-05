import { describe, expect, test } from "vitest";
import { descriptionScore } from "./description-score";

describe("descriptionScore", () => {
  test("scores an exact match highest", () => {
    expect(descriptionScore("TRADER JOES 118", "TRADER JOES 118")).toBe(3);
  });

  test("scores containment in either direction", () => {
    // the real shape: one source prints the merchant's phone number, the other
    // truncates it away
    expect(descriptionScore("CPI CANTEEN VENDING MIAMI 800-628-", "CPI CANTEEN VENDING MIAMI")).toBe(2);
    expect(descriptionScore("CPI CANTEEN VENDING MIAMI", "CPI CANTEEN VENDING MIAMI 800-628-")).toBe(2);
  });

  test("scores a long shared prefix lowest, and eight characters is the floor", () => {
    expect(descriptionScore("MTA NYCT PAYGO NEW YORK", "MTA NYCT SUBWAY FARE")).toBe(1);
    // exactly eight shared characters qualifies; seven does not
    expect(descriptionScore("ABCDEFGH1one", "ABCDEFGH2two")).toBe(1);
    expect(descriptionScore("ABCDEFG1one", "ABCDEFG2two")).toBe(0);
  });

  /*
   * ⛔ Both read in normalizer v3's form (`withoutAchReferences`): a stored row keeps the ACH individual ID its import
   * wrote, and the same line read again — or the payee's next entry — carries none. 🔴 Compared as stored, Sep 24's
   * payroll and its own line re-read scored 1, a shared prefix, where they are one descriptor (review of b53989c8).
   */
  test("a stored row holding its ACH individual ID and the same payee's v3 line are equal", () => {
    const sep24 = "IT AMERICA LLC PAYROLL 9357426222928QJ KARIM CHECA,RAYAN";
    expect(descriptionScore(sep24, "IT AMERICA LLC PAYROLL KARIM CHECA,RAYAN")).toBe(3);
    expect(descriptionScore("IT AMERICA LLC PAYROLL KARIM CHECA,RAYAN", sep24)).toBe(3);
    expect(
      descriptionScore(
        "CAPITAL ONE MOBILE PMT CA0FDA683870046 RAYAN KARIM CHECA",
        "CAPITAL ONE MOBILE PMT RT0FDB716244107 RAYAN KARIM CHECA",
      ),
    ).toBe(3);
  });

  test("scores unrelated descriptions zero", () => {
    expect(descriptionScore("Microsoft CUSIP 594918104 MSFT", "Cash settlement Crypto Purchase ETH")).toBe(0);
  });

  test("treats an empty description as contained, never as a shared prefix", () => {
    // "".includes("") is true, so two empties are equal (3) and one empty is
    // contained in anything (2) — the prefix branch is never reached. Pinned
    // because a row with no description must not silently score 0 and be
    // treated as unrelated to itself.
    expect(descriptionScore("", "")).toBe(3);
    expect(descriptionScore("", "ANYTHING")).toBe(2);
    expect(descriptionScore("ANYTHING", "")).toBe(2);
  });
});
