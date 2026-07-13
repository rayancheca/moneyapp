import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import type { Line } from "./pdf-profile";
import { parseDiscoverItLines } from "./discover-statement-profile";

/**
 * Real Discover it statement PDFs are a TWO-COLUMN layout: transaction columns
 * on the left (date x≈38, desc x≈80, merchant-category x≈257, amount x≈377) and
 * a "Cashback Bonus Rewards" sidebar on the right (x≥414) that y-clustering
 * interleaves onto the same lines. Fixtures reproduce the token x-positions so
 * the parser's column banding (and its rejection of sidebar decoys like the
 * all-caps "PREVIOUS BALANCE $15.45") is exercised.
 */

function mkLine(y: number, tokens: [number, string][]): Line {
  const sorted = [...tokens].sort((a, b) => a[0] - b[0]);
  return {
    y,
    text: sorted.map(([, s]) => s).join(" "),
    tokens: sorted.map(([x, str]) => ({ x, str })),
  };
}

const STATEMENT: Line[] = [
  mkLine(1, [[174, "DISCOVER IT CARD ENDING IN 4741"]]),
  mkLine(2, [[174, "12/19/2023 - 01/18/2024"]]),
  mkLine(3, [[38, "Previous Balance"], [300, "$104.00"]]),
  mkLine(4, [[38, "New Balance:"], [300, "$55.77"]]),
  // sidebar decoys — an all-caps PREVIOUS BALANCE and a New Balance coupon line
  mkLine(5, [[414, "PREVIOUS BALANCE"], [565, "$15.45"]]),
  mkLine(6, [[38, "New Balance"], [300, "55.77"]]), // coupon: no colon, no $ → ignored
  // payments-and-credits section (no merchant-category column)
  mkLine(7, [[38, "DATE"], [80, "PAYMENTS AND CREDITS"], [374, "AMOUNT"]]),
  mkLine(8, [[38, "12/19"], [80, "INTERNET PAYMENT - THANK YOU"], [369, "-$104.00"]]),
  mkLine(9, [[421, "1% Cashback Bonus"], [566, "+$0.41"]]), // sidebar row, no date → ignored
  // purchases section
  mkLine(10, [[38, "DATE"], [80, "PURCHASES MERCHANT CATEGORY"], [374, "AMOUNT"]]),
  mkLine(11, [[38, "01/15"], [80, "MYW FOOD MARKET BRONX NY"], [257, "Supermarkets"], [377, "$20.38"]]),
  mkLine(12, [[80, "APPLE PAY ENDING IN 3883"]]), // continuation, no date → ignored
  mkLine(13, [[38, "01/17"], [80, "SUPER TASTE NEW YORK NY"], [257, "Restaurants"], [377, "$14.59"]]),
  // interleaved sidebar noise trailing a real purchase row
  mkLine(14, [
    [38, "01/17"], [80, "NEW BEST GOURMET DELI BRONX NY"], [257, "Supermarkets"], [377, "$20.80"],
    [414, "JAN-MAR"], [501, "Activate at discover.com/5"],
  ]),
];

describe("parseDiscoverItLines", () => {
  test("extracts period, last4, and the account-summary balances (not the sidebar decoy)", () => {
    const p = parseDiscoverItLines(STATEMENT);
    expect(p.periodStart).toBe("2023-12-19");
    expect(p.periodEnd).toBe("2024-01-18");
    expect(p.last4).toBe("4741");
    expect(p.previousBalanceCents).toBe(10400);
    expect(p.newBalanceCents).toBe(5577);
  });

  test("purchases are net-worth-negative and carry their merchant category", () => {
    const p = parseDiscoverItLines(STATEMENT);
    const myw = p.txns.find((t) => t.rawDescription.includes("MYW FOOD"));
    expect(myw?.amountCents).toBe(-2038);
    expect(myw?.bankCategory).toBe("Supermarkets");
  });

  test("payments/credits are net-worth-positive", () => {
    const p = parseDiscoverItLines(STATEMENT);
    const pay = p.txns.find((t) => t.rawDescription.includes("INTERNET PAYMENT"));
    expect(pay?.amountCents).toBe(10400);
  });

  test("sidebar tokens and continuation lines never become transactions", () => {
    const p = parseDiscoverItLines(STATEMENT);
    expect(p.txns).toHaveLength(4); // 1 payment + 3 purchases; no sidebar/continuation rows
    const newBest = p.txns.find((t) => t.rawDescription.includes("NEW BEST"));
    expect(newBest?.amountCents).toBe(-2080);
    expect(newBest?.rawDescription).not.toContain("Activate"); // sidebar bleed dropped
  });

  test("clamps a pre-cycle trans date into the billing period, keeping transactedOn", () => {
    // a purchase transacted before the cycle opened (12/17) but billed here
    const p = parseDiscoverItLines([
      mkLine(1, [[174, "12/19/2023 - 01/18/2024"]]),
      mkLine(2, [[38, "Previous Balance"], [300, "$0.00"]]),
      mkLine(3, [[38, "New Balance:"], [300, "$10.00"]]),
      mkLine(4, [[38, "12/17"], [80, "EARLY STORE NY"], [257, "Supermarkets"], [377, "$10.00"]]),
    ]);
    const row = p.txns[0]!;
    expect(row.transactedOn).toBe("2023-12-17"); // real trans date preserved
    expect(row.postedOn).toBe("2023-12-19"); // clamped into the period start
  });

  test("infers the prior year for a month that overshoots the cycle close (Nov on a Dec→Jan statement)", () => {
    const p = parseDiscoverItLines([
      mkLine(1, [[174, "12/19/2023 - 01/18/2024"]]),
      mkLine(2, [[38, "Previous Balance"], [300, "$0.00"]]),
      mkLine(3, [[38, "New Balance:"], [300, "$10.00"]]),
      mkLine(4, [[38, "11/28"], [80, "LATE POST STORE NY"], [257, "Supermarkets"], [377, "$10.00"]]),
    ]);
    const row = p.txns[0]!;
    expect(row.transactedOn).toBe("2023-11-28"); // NOT 2024-11-28 (11 months in the future)
    expect(row.postedOn).toBe("2023-12-19"); // clamped into the period
  });

  test("reconciles to the cent (net-worth-signed begin + sum == end)", () => {
    const p = parseDiscoverItLines(STATEMENT);
    const begin = -p.previousBalanceCents;
    const end = -p.newBalanceCents;
    const sum = p.txns.reduce((s, t) => s + t.amountCents, 0);
    expect(begin + sum).toBe(end);
  });

  test("throws when the billing period is missing", () => {
    expect(() =>
      parseDiscoverItLines([mkLine(1, [[38, "Previous Balance"], [300, "$104.00"]])]),
    ).toThrow(ParseError);
  });

  test("throws when printed balances are missing", () => {
    expect(() =>
      parseDiscoverItLines([mkLine(1, [[174, "12/19/2023 - 01/18/2024"]])]),
    ).toThrow(ParseError);
  });
});
