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
