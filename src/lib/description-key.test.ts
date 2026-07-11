import { describe, expect, test } from "vitest";
import { humanizeDescriptionKey, strippedDescriptionKey } from "./description-key";

describe("strippedDescriptionKey — brokerage ticker keying", () => {
  test("cash dividend rows for the same ticker share one key across dates and amounts", () => {
    // Arrange
    const april = "CASH DIV: R/D 2026-04-24 P/D 2026-05-08 - 32. SHARES AT 0.25 (COKE)";
    const july = "CASH DIV: R/D 2026-07-21 P/D 2026-08-01 - 40. SHARES AT 0.26 (COKE)";

    // Act
    const keyApril = strippedDescriptionKey(april);
    const keyJuly = strippedDescriptionKey(july);

    // Assert
    expect(keyApril).toBe("ticker:COKE:DIV");
    expect(keyJuly).toBe(keyApril);
  });

  test("recurring buy and dividend reinvestment of the same instrument group SEPARATELY", () => {
    // same ticker, different activity: a recurring buy follows the user's
    // schedule, a DRIP purchase follows dividend dates — one group would
    // corrupt cadence detection
    expect(strippedDescriptionKey("CUSIP: RECURRING (COKE)")).toBe("ticker:COKE:RECURRING");
    expect(strippedDescriptionKey("CUSIP: DIVIDEND REINVESTMENT (COKE)")).toBe(
      "ticker:COKE:REINVEST",
    );
  });

  test("plain trade rows with and without a literal CUSIP number share the TRADE key", () => {
    expect(strippedDescriptionKey("MARVELL TECHNOLOGY CUSIP: (MRVL)")).toBe("ticker:MRVL:TRADE");
    expect(strippedDescriptionKey("SERVICENOW CUSIP: 81762P102 (NOW)")).toBe("ticker:NOW:TRADE");
  });

  test("dotted share classes and cash dividends with DIVIDEND spelled out classify as DIV", () => {
    expect(strippedDescriptionKey("BERKSHIRE CUSIP: DIVIDEND PAYMENT (BRK.B)")).toBe(
      "ticker:BRK.B:DIV",
    );
  });

  test("different tickers never share a key even for identical activity", () => {
    expect(strippedDescriptionKey("CASH DIV: R/D 2026-05-11 - 15. SHARES AT 0.27 (AAPL)")).toBe(
      "ticker:AAPL:DIV",
    );
    expect(strippedDescriptionKey("CASH DIV: R/D 2026-05-21 - 24. SHARES AT 0.91 (MSFT)")).toBe(
      "ticker:MSFT:DIV",
    );
  });

  test("a parenthesized suffix WITHOUT brokerage markers is not a ticker", () => {
    // "(NYC)" must not collapse two different shops into one group
    expect(strippedDescriptionKey("JOE'S PIZZA (NYC)")).toBe("JOE'S PIZZA NYC");
    expect(strippedDescriptionKey("RAY'S CANDY (NYC)")).toBe("RAY'S CANDY NYC");
  });
});

describe("strippedDescriptionKey — retail stripping", () => {
  test("numeric dates in all common shapes are stripped", () => {
    expect(strippedDescriptionKey("STARBUCKS 05/12 STORE")).toBe("STARBUCKS STORE");
    expect(strippedDescriptionKey("STARBUCKS 6/5/2026 STORE")).toBe("STARBUCKS STORE");
    expect(strippedDescriptionKey("STARBUCKS 04-24-26 STORE")).toBe("STARBUCKS STORE");
    expect(strippedDescriptionKey("PAYMENT DUE 2026-04-24")).toBe("PAYMENT DUE");
  });

  test("month-name dates are stripped, with and without year", () => {
    expect(strippedDescriptionKey("MEMBERSHIP JUL 4 RENEWAL")).toBe("MEMBERSHIP RENEWAL");
    expect(strippedDescriptionKey("MEMBERSHIP APRIL 24, 2026 RENEWAL")).toBe(
      "MEMBERSHIP RENEWAL",
    );
  });

  test("genuine month-dates strip across abbreviated and full-spelling forms", () => {
    // each new alternation branch (full-month suffix + SEPT variant) exercised
    expect(strippedDescriptionKey("SEP 5")).toBe("");
    expect(strippedDescriptionKey("SEPTEMBER 5")).toBe("");
    expect(strippedDescriptionKey("SEPT 5")).toBe("");
    expect(strippedDescriptionKey("AUGUST 9")).toBe("");
    expect(strippedDescriptionKey("DEC. 25")).toBe("");
    expect(strippedDescriptionKey("JANUARY 1")).toBe("");
    expect(strippedDescriptionKey("FEBRUARY 2")).toBe("");
    expect(strippedDescriptionKey("MARCH 3")).toBe("");
    expect(strippedDescriptionKey("MAY 6")).toBe("");
    expect(strippedDescriptionKey("JUNE 7")).toBe("");
    expect(strippedDescriptionKey("JULY 7")).toBe("");
    expect(strippedDescriptionKey("APRIL 4")).toBe("");
    expect(strippedDescriptionKey("OCTOBER 8")).toBe("");
    expect(strippedDescriptionKey("NOVEMBER 10")).toBe("");
    expect(strippedDescriptionKey("DECEMBER 25")).toBe("");
  });

  test("month-prefixed non-month merchants keep their brand token", () => {
    // "[A-Z]*" would have eaten these brand words as if they were month names
    expect(strippedDescriptionKey("MARKET 32")).toBe("MARKET 32");
    expect(strippedDescriptionKey("SEPHORA 5 AVENUE")).toBe("SEPHORA 5 AVENUE");
    expect(strippedDescriptionKey("MAYTAG 5 APPLIANCE")).toBe("MAYTAG 5 APPLIANCE");
    expect(strippedDescriptionKey("AUGUSTA 9 GOLF")).toBe("AUGUSTA 9 GOLF");
    expect(strippedDescriptionKey("JUNIPER 9 CAFE")).toBe("JUNIPER 9 CAFE");
    expect(strippedDescriptionKey("NOVA 2 SPA")).toBe("NOVA 2 SPA");
    expect(strippedDescriptionKey("OCTOPUS 8")).toBe("OCTOPUS 8");
    expect(strippedDescriptionKey("DECATHLON 5")).toBe("DECATHLON 5");
    expect(strippedDescriptionKey("MARATHON 76")).toBe("MARATHON 76");
    expect(strippedDescriptionKey("MARSHALLS 12")).toBe("MARSHALLS 12");
    expect(strippedDescriptionKey("JANITOR 4 SERVICE")).toBe("JANITOR 4 SERVICE");
    expect(strippedDescriptionKey("APRICOT 7 ORCHARD")).toBe("APRICOT 7 ORCHARD");
    expect(strippedDescriptionKey("FEBRILE 3 CLINIC")).toBe("FEBRILE 3 CLINIC");
  });

  test("dollar amounts and decimal numbers are stripped; short integers survive", () => {
    expect(strippedDescriptionKey("REFUND $43.64 PROCESSED")).toBe("REFUND PROCESSED");
    expect(strippedDescriptionKey("REFUND $ 1,234.56 PROCESSED")).toBe("REFUND PROCESSED");
    expect(strippedDescriptionKey("FEE 0.25 APPLIED")).toBe("FEE APPLIED");
    // street numbers are identity, not noise
    expect(strippedDescriptionKey("ATM 100 BROADWAY")).toBe("ATM 100 BROADWAY");
  });

  test("trailing-dot share counts and long digit runs (confirmation numbers) are stripped", () => {
    expect(strippedDescriptionKey("CASH DIV - 32. SHARES AT 0.25")).toBe("CASH DIV SHARES AT");
    expect(strippedDescriptionKey("WIRE CONF 8834412907 OUT")).toBe("WIRE CONF OUT");
    expect(strippedDescriptionKey("SOLD 32.")).toBe("SOLD");
  });

  test("R/D and P/D tokens and bare CUSIP tokens are stripped outside the ticker path", () => {
    expect(strippedDescriptionKey("CASH DIV: R/D P/D PENDING")).toBe("CASH DIV PENDING");
    expect(strippedDescriptionKey("TRANSFER 81762P102 SETTLED")).toBe("TRANSFER SETTLED");
  });

  test("punctuation-only leftovers are dropped and whitespace collapses", () => {
    expect(strippedDescriptionKey("CASH DIV: R/D 2026-04-24 - 32. SHARES AT 0.25")).toBe(
      "CASH DIV SHARES AT",
    );
  });

  test("ordinary retail strings keep their identity tokens intact", () => {
    expect(strippedDescriptionKey("WEIXIN*A BAGEL (DENNIS")).toBe("WEIXIN*A BAGEL DENNIS");
    expect(strippedDescriptionKey("KYURAMEN (LIC, NYC)")).toBe("KYURAMEN LIC NYC");
    expect(strippedDescriptionKey("NETFLIX.COM")).toBe("NETFLIX.COM");
  });

  test("lowercase input is normalized defensively", () => {
    expect(strippedDescriptionKey("netflix.com")).toBe("NETFLIX.COM");
  });

  test("empty and whitespace-only input produce the empty (never-group) key", () => {
    expect(strippedDescriptionKey("")).toBe("");
    expect(strippedDescriptionKey("   ")).toBe("");
    // everything stripped away also yields the empty key
    expect(strippedDescriptionKey("2026-04-24 $5.00")).toBe("");
  });
});

describe("humanizeDescriptionKey — readable label for the snackbar", () => {
  test("ticker keys become '<SYMBOL> <activity words>' across every class", () => {
    expect(humanizeDescriptionKey("ticker:COKE:DIV")).toBe("COKE dividends");
    expect(humanizeDescriptionKey("ticker:COKE:REINVEST")).toBe("COKE reinvestments");
    expect(humanizeDescriptionKey("ticker:COKE:RECURRING")).toBe("COKE recurring buys");
    expect(humanizeDescriptionKey("ticker:MRVL:TRADE")).toBe("MRVL trades");
    // dotted share classes survive
    expect(humanizeDescriptionKey("ticker:BRK.B:DIV")).toBe("BRK.B dividends");
  });

  test("retail keys are already the descriptor core and pass through unchanged", () => {
    expect(humanizeDescriptionKey("STARBUCKS STORE")).toBe("STARBUCKS STORE");
    expect(humanizeDescriptionKey("NETFLIX.COM")).toBe("NETFLIX.COM");
    // a 'ticker:'-prefixed string that is NOT the exact ticker shape is literal
    expect(humanizeDescriptionKey("ticker:lowercase")).toBe("ticker:lowercase");
  });

  test("empty and whitespace-only keys humanize to the empty label", () => {
    expect(humanizeDescriptionKey("")).toBe("");
    expect(humanizeDescriptionKey("   ")).toBe("");
  });

  test("round-trips the stripped key of a real brokerage dividend", () => {
    const key = strippedDescriptionKey(
      "CASH DIV: R/D 2026-04-24 P/D 2026-05-08 - 32. SHARES AT 0.25 (COKE)",
    );
    expect(humanizeDescriptionKey(key)).toBe("COKE dividends");
  });
});
