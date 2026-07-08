import { describe, expect, test } from "vitest";
import { NORMALIZER_VERSION, normalizeDescription } from "./normalize";

describe("normalizeDescription v1", () => {
  test("version constant exists for traceability", () => {
    expect(NORMALIZER_VERSION).toBe(1);
  });

  test.each([
    // processor prefixes
    ["TST* JOES PIZZA #402 NEW YORK NY", "JOES PIZZA NEW YORK"],
    ["SQ *BLUE BOTTLE COFFEE", "BLUE BOTTLE COFFEE"],
    ["DD *DOORDASH CHIPOTLE", "DOORDASH CHIPOTLE"],
    ["PAYPAL *SPOTIFY", "SPOTIFY"],
    // masked cards, store numbers, long digit runs
    ["AMAZON MKTPL XXXXXXXXXXXX1234", "AMAZON MKTPL"],
    ["STARBUCKS #123 SEATTLE WA", "STARBUCKS SEATTLE"],
    ["UBER TRIP 800-593-7069 CA", "UBER TRIP 800-593-7069"],
    ["ACH DEPOSIT 0000012345678", "ACH DEPOSIT"],
    // casing + whitespace
    ["  spotify   premium  ", "SPOTIFY PREMIUM"],
    // trailing state stripped only with enough tokens left
    ["TRADER JOES 552 BROOKLYN NY", "TRADER JOES 552 BROOKLYN"],
    ["ARCO AZ", "ARCO AZ"], // too short — state kept
    // no-ops stay stable
    ["ONLINE TRANSFER TO SAVINGS", "ONLINE TRANSFER TO SAVINGS"],
  ])("%j -> %j", (raw, expected) => {
    expect(normalizeDescription(raw)).toBe(expected);
  });

  test("is idempotent", () => {
    const samples = [
      "TST* JOES PIZZA #402 NEW YORK NY",
      "SQ *BLUE BOTTLE COFFEE",
      "AMAZON MKTPL XXXXXXXXXXXX1234",
    ];
    for (const s of samples) {
      const once = normalizeDescription(s);
      expect(normalizeDescription(once)).toBe(once);
    }
  });
});
