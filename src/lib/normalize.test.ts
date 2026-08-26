import { describe, expect, test } from "vitest";
import { NORMALIZER_VERSION, normalizeDescription } from "./normalize";

describe("normalizeDescription v1", () => {
  test("version constant exists for traceability", () => {
    expect(NORMALIZER_VERSION).toBe(2);
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

describe("normalizeDescription — the Wells Fargo envelope", () => {
  /**
   * ⛔ The reason this matters is not tidiness. `S<19 digits>` is unique per
   * transaction, so an un-stripped Wells Fargo row normalizes to a string
   * nothing else can ever equal — and 1,741 of the merchant map's 1,802
   * aliases match `exact`. Measured on the real import: 38 of 39 rows landed
   * uncategorized, and the merchant map could not have learned from them
   * either, because every alias it learned would have been single-use.
   */
  test("strips the opener and the per-transaction card reference", () => {
    expect(
      normalizeDescription("PURCHASE AUTHORIZED ON 07/31 LA PISCINE MIAMI BEACH FL S466213078873314 CARD 7158"),
    ).toBe("LA PISCINE MIAMI BEACH");
  });

  /**
   * The whole point: the stripped form is the SAME string Chase Sapphire
   * already taught the merchant map, so a Wells Fargo charge at a merchant he
   * has used on another card matches on the first import instead of never.
   */
  test("two cards at the same merchant normalize to one alias", () => {
    const wellsFargo = normalizeDescription(
      "PURCHASE AUTHORIZED ON 08/02 LA PISCINE MIAMI BEACH FL S306213766181718 CARD 7158",
    );
    const sapphire = normalizeDescription("LA PISCINE MIAMI BEACH FL");
    expect(wellsFargo).toBe(sapphire);
  });

  test("the reference is what makes rows unique — two charges at one merchant collapse to one key", () => {
    const a = normalizeDescription("PURCHASE AUTHORIZED ON 08/01 EL COCO LOCO FRIO HIALEAH FL S386214151667636 CARD 7158");
    const b = normalizeDescription("PURCHASE AUTHORIZED ON 08/08 EL COCO LOCO FRIO HIALEAH FL S466218927544230 CARD 7158");
    expect(a).toBe(b);
  });

  test("the envelope comes off before the processor prefix it hides", () => {
    // `SQ *` only reaches the start of the string once the opener is gone
    expect(
      normalizeDescription("PURCHASE AUTHORIZED ON 08/03 SQ *YA-FIT SMOOTHI MIAMI BEACH FL S356216003682281 CARD 7158"),
    ).toBe("YA-FIT SMOOTHI MIAMI BEACH");
    expect(
      normalizeDescription("PURCHASE AUTHORIZED ON 08/07 TST*TACO STAND MIA MIAMI FL S306221581657206 CARD 7158"),
    ).toBe("TACO STAND MIA MIAMI");
  });

  test("the recurring-payment opener is stripped too", () => {
    expect(
      normalizeDescription("RECURRING PAYMENT AUTHORIZED ON 08/06 MOVE FITNESS CONCE 130-0000000 FL S466218927544230 CARD 7158"),
    ).not.toMatch(/AUTHORIZED ON|CARD 7158|S466218927544230/);
  });

  /**
   * A constructed shape, not one in the data yet — Wells Fargo prints this
   * opener for a purchase taken with cash back and the ledger has no such row
   * to date. The short store number survives on purpose: the normalizer keeps
   * numbers under five digits, because they are usually part of the name.
   */
  test("a cash-back purchase loses the envelope and its dollar amount", () => {
    expect(
      normalizeDescription("PURCHASE WITH CASH BACK $ 40.00 AUTHORIZED ON 08/04 PUBLIX 1234 MIAMI FL S123456789012345 CARD 7158"),
    ).toBe("PUBLIX 1234 MIAMI");
  });

  /**
   * The envelope is Wells Fargo's alone — measured, no other account in the
   * ledger uses it. Rows that do not carry it must come through untouched, or
   * this change would silently rewrite 10,000 existing keys.
   */
  test("descriptions without the envelope are unchanged by it", () => {
    expect(normalizeDescription("LA PISCINE MIAMI BEACH FL")).toBe("LA PISCINE MIAMI BEACH");
    expect(normalizeDescription("ZELLE PAYMENT TO CARSON LAMA JPM99CQXLSRM")).toBe("ZELLE PAYMENT TO CARSON LAMA JPM99CQXLSRM");
    expect(normalizeDescription("CAPITAL ONE MOBILE PMT CA0C5802750FB02")).toBe("CAPITAL ONE MOBILE PMT CA0C5802750FB02");
  });

  test("a bare 'CARD 7158' without a reference number is not mistaken for the envelope", () => {
    expect(normalizeDescription("SOME MERCHANT CARD 7158")).toBe("SOME MERCHANT CARD 7158");
  });
});
