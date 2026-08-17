import { describe, expect, it } from "vitest";
import type { Line } from "./pdf-profile";
import { parseCryptoMoneyMovements } from "./robinhood-crypto-movement";

/** The Account Activity column header, verbatim from the real 2026-07 statement. */
const HEADER: Line = {
  y: 1,
  text: "Description Symbol Acct Type Transaction Date Qty Price Debit Credit",
  tokens: [
    { str: "Description", x: 36 },
    { str: "Symbol", x: 420 },
    { str: "Acct", x: 470 },
    { str: "Type", x: 520 },
    { str: "Transaction", x: 560 },
    { str: "Date", x: 600 },
    { str: "Qty", x: 640 },
    { str: "Price", x: 665 },
    { str: "Debit", x: 695.4 },
    { str: "Credit", x: 748.69 },
  ],
};

const movement = (date: string, amount: string, x: number, y = 2): Line => ({
  y,
  text: `Crypto Money Movement Margin COIN ${date} ${amount}`,
  tokens: [
    { str: "Crypto Money Movement", x: 36 },
    { str: "Margin", x: 470 },
    { str: "COIN", x: 520 },
    { str: date, x: 600 },
    { str: amount, x },
  ],
});

const DEBIT_X = 695;
const CREDIT_X = 749;

describe("parseCryptoMoneyMovements", () => {
  it("signs an amount in the Credit column positive — money into the account", () => {
    expect(parseCryptoMoneyMovements([HEADER, movement("07/07/2026", "$4,999.74", CREDIT_X)])).toEqual([
      { postedOn: "2026-07-07", amountCents: 499_974 },
    ]);
  });

  it("signs an amount in the Debit column negative — money out", () => {
    expect(parseCryptoMoneyMovements([HEADER, movement("07/20/2026", "$99.01", DEBIT_X)])).toEqual([
      { postedOn: "2026-07-20", amountCents: -9_901 },
    ]);
  });

  it("nets the real 2026-07 statement's fourteen rows to $3,811.52", () => {
    // the exact figure July was short; this is the whole point of the parser
    const rows: Line[] = [
      movement("07/07/2026", "$4,999.74", CREDIT_X, 2),
      movement("07/20/2026", "$99.01", DEBIT_X, 3),
      movement("07/20/2026", "$99.02", DEBIT_X, 4),
      movement("07/21/2026", "$99.02", DEBIT_X, 5),
      movement("07/22/2026", "$99.02", DEBIT_X, 6),
      movement("07/23/2026", "$99.02", DEBIT_X, 7),
      movement("07/24/2026", "$12.28", DEBIT_X, 8),
      movement("07/24/2026", "$86.73", DEBIT_X, 9),
      movement("07/27/2026", "$99.02", DEBIT_X, 10),
      movement("07/27/2026", "$99.05", DEBIT_X, 11),
      movement("07/27/2026", "$99.01", DEBIT_X, 12),
      movement("07/28/2026", "$99.01", DEBIT_X, 13),
      movement("07/29/2026", "$99.01", DEBIT_X, 14),
      movement("07/30/2026", "$99.02", DEBIT_X, 15),
    ];
    const parsed = parseCryptoMoneyMovements([HEADER, ...rows]);
    expect(parsed).toHaveLength(14);
    expect(parsed.reduce((n, r) => n + r.amountCents, 0)).toBe(381_152);
  });

  it("ignores every line that is not a Crypto Money Movement", () => {
    const equityBuy: Line = {
      y: 3,
      text: "CUSIP: 78462F103 SPY Margin Buy 07/16/2026 0.13308 $751.42435 $100.00",
      tokens: [
        { str: "CUSIP: 78462F103", x: 36 },
        { str: "SPY", x: 420 },
        { str: "07/16/2026", x: 600 },
        { str: "$100.00", x: DEBIT_X },
      ],
    };
    expect(parseCryptoMoneyMovements([HEADER, equityBuy])).toEqual([]);
  });

  it("returns nothing when the statement prints no crypto rows", () => {
    expect(parseCryptoMoneyMovements([HEADER])).toEqual([]);
  });

  it("returns nothing when there is no Debit/Credit header to measure against", () => {
    // a statement era without the column header must yield NOTHING rather than
    // guess a direction — an unsigned amount placed by assumption is the exact
    // failure mode this repo has paid for twice
    expect(parseCryptoMoneyMovements([movement("07/07/2026", "$4,999.74", CREDIT_X)])).toEqual([]);
  });

  it("refuses a row whose amount sits in neither column", () => {
    // x=400 is nowhere near either stop; signing it would be invention
    expect(() =>
      parseCryptoMoneyMovements([HEADER, movement("07/07/2026", "$4,999.74", 400)]),
    ).toThrowError(/column/i);
  });

  it("reads a parenthesised negative without double-negating it", () => {
    // the account can go cash-negative and the PDF prints ($9.90); the column
    // still decides direction, so a paren in the Debit column is still an outflow
    expect(
      parseCryptoMoneyMovements([HEADER, movement("07/07/2026", "($9.90)", DEBIT_X)]),
    ).toEqual([{ postedOn: "2026-07-07", amountCents: -990 }]);
  });
});
