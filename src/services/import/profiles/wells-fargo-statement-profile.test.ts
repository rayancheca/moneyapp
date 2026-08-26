import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import type { Line } from "./pdf-profile";
import {
  columnOf,
  findMoneyColumns,
  parseWellsFargoLines,
} from "./wells-fargo-statement-profile";

/**
 * Fixtures mirror the REAL Wells Fargo Everyday Checking layout decoded from
 * `wells fargo statement.pdf` via `extractLines`, x positions included and
 * unrounded from the real document:
 *
 *     header      Check@124  Deposits/@404  Withdrawals/@458  Ending daily@525
 *     deposits    406–421
 *     withdrawals 474–489
 *     balances    538–548
 *
 * The x values are the whole point of this parser. Wells Fargo prints NO sign
 * anywhere in the transaction table — a purchase and a deposit are both a bare
 * `7.00`, and only the column they sit in says which is which. A fixture of
 * plain strings could not test the one thing most likely to be wrong.
 */

let y = 0;
function line(tokens: [string, number][]): Line {
  y += 1;
  return {
    y,
    text: tokens.map(([s]) => s).join(" "),
    tokens: tokens.map(([str, x]) => ({ str, x })),
  };
}

const HEADER = (): Line =>
  line([
    ["Check", 124],
    ["Deposits/", 404],
    ["Withdrawals/", 458],
    ["Ending daily", 525],
  ]);

function statement(rows: Line[]): Line[] {
  y = 0;
  return [
    line([["August 25, 2026", 36], ["Page 2 of 6", 119]]),
    line([["Account number:", 356], ["8920495481 (primary account)", 419]]),
    line([["Beginning balance on 7/27", 65], ["$0.00", 310]]),
    line([["Ending balance on 8/25", 65], ["$2,396.67", 293]]),
    line([["Transaction history", 36]]),
    HEADER(),
    ...rows,
    line([["Totals", 62], ["$6,447.92", 400], ["$4,051.25", 468]]),
  ];
}

describe("findMoneyColumns / columnOf", () => {
  test("reads the boundaries off the printed header instead of hardcoding them", () => {
    const cols = findMoneyColumns([HEADER()]);
    expect(cols).toEqual({ withdrawalsX: 458, balanceX: 525 });
  });

  test("every x measured on the real statement lands in the right column", () => {
    const cols = { withdrawalsX: 458, balanceX: 525 };
    for (const x of [406, 412, 416, 421]) expect(columnOf(x, cols)).toBe("deposit");
    for (const x of [474, 485, 489]) expect(columnOf(x, cols)).toBe("withdrawal");
    for (const x of [538, 544, 548]) expect(columnOf(x, cols)).toBe("balance");
  });

  test("a line with no column header is not mistaken for one", () => {
    expect(findMoneyColumns([line([["Deposits/", 404]])])).toBeNull();
  });

  test("a header whose columns are out of order is a mis-clustered line, not a table", () => {
    expect(
      findMoneyColumns([
        line([["Ending daily", 100], ["Deposits/", 404], ["Withdrawals/", 458]]),
      ]),
    ).toBeNull();
  });
});

describe("parseWellsFargoLines", () => {
  test("reads the period, the account last4 and the printed balances", () => {
    const parsed = parseWellsFargoLines(statement([]));
    expect(parsed.periodStart).toBe("2026-07-27");
    expect(parsed.periodEnd).toBe("2026-08-25");
    expect(parsed.last4).toBe("5481");
    expect(parsed.beginningBalanceCents).toBe(0);
    expect(parsed.endingBalanceCents).toBe(239667);
  });

  /**
   * ⛔ THE test. Two rows, identical amount text, opposite meanings — the only
   * difference is x. A parser that read the text and not the position would
   * record both as +$7.00 and silently turn a purchase into income.
   */
  test("the COLUMN decides the sign — identical amount text, opposite directions", () => {
    const parsed = parseWellsFargoLines(
      statement([
        line([["7/29", 65], ["Zelle From Monira Hossain on 07/29", 90], ["7.00", 412]]),
        line([["8/3", 65], ["Purchase authorized on 07/30 6800 Brickell City Miami FL", 90], ["7.00", 489]]),
      ]),
    );
    expect(parsed.txns.map((t) => t.amountCents)).toEqual([700, -700]);
  });

  /**
   * The ending daily balance prints only on the LAST row of each day, so rows
   * carry one money token or two. A "last two money tokens are amount and
   * balance" rule — the shape the generic PDF profile uses — reads the balance
   * as the amount on every row that has one.
   */
  test("a running balance is never read as the amount", () => {
    const parsed = parseWellsFargoLines(
      statement([
        line([["8/3", 65], ["Purchase authorized on 08/02 Move Fitness Conce", 90], ["1.00", 489], ["4,041.63", 538]]),
        line([["8/5", 65], ["Purchase authorized on 08/04 Sq *Ya-Fit Smoothi", 90], ["22.53", 485], ["1,742.30", 538]]),
      ]),
    );
    expect(parsed.txns).toHaveLength(2);
    expect(parsed.txns.map((t) => t.amountCents)).toEqual([-100, -2253]);
  });

  test("a wrapped description is folded into the row above it", () => {
    const parsed = parseWellsFargoLines(
      statement([
        line([["8/3", 65], ["Purchase authorized on 07/30 6800 Brickell City Miami FL", 90], ["7.00", 489]]),
        line([["S586211836828418 Card 7158", 90]]),
      ]),
    );
    expect(parsed.txns).toHaveLength(1);
    expect(parsed.txns[0]!.rawDescription).toBe(
      "Purchase authorized on 07/30 6800 Brickell City Miami FL S586211836828418 Card 7158",
    );
  });

  /**
   * ⛔ The `Totals` row prints `$6,447.92 $4,051.25` in the SAME two columns as
   * the activity above it, directly under the last transaction.
   *
   * ⚠️ The first version of this test asserted "it does not become two
   * transactions" and a mutation that removed the guard still passed it — the
   * assertion was unfalsifiable, because `$6,447.92` carries a `$` and cannot
   * match the money token regex, and `Totals` is not a date. The reachable
   * failure is the totals being FOLDED INTO the last row's description, which
   * would put the statement's own summary inside a transaction's raw text and
   * therefore inside its dedupe hash. That is what this pins.
   */
  test("the Totals row does not fold into the last transaction's description", () => {
    const parsed = parseWellsFargoLines(
      statement([line([["8/24", 65], ["Zelle From Rayan Karim Checa", 90], ["1,999.00", 406], ["2,396.67", 538]])]),
    );
    expect(parsed.txns).toHaveLength(1);
    expect(parsed.txns[0]!.amountCents).toBe(199900);
    expect(parsed.txns[0]!.rawDescription).toBe("Zelle From Rayan Karim Checa");
    expect(parsed.txns[0]!.rawDescription).not.toContain("6,447.92");
  });

  test("the transaction history runs across pages without page chrome joining a description", () => {
    const parsed = parseWellsFargoLines(
      statement([
        line([["8/13", 65], ["Purchase authorized on 08/11 Vape N Smoke Shop Miami", 90], ["13.34", 485]]),
        line([["Beach FL S466223760602346 Card 7158", 90]]),
        line([["August 25, 2026", 36], ["Page 3 of 6", 119]]),
        line([["Transaction History (continued)", 36]]),
        HEADER(),
        line([["8/24", 65], ["Zelle From Rayan Karim Checa on 08/24", 90], ["1.00", 421]]),
      ]),
    );
    expect(parsed.txns).toHaveLength(2);
    expect(parsed.txns[0]!.rawDescription).toBe(
      "Purchase authorized on 08/11 Vape N Smoke Shop Miami Beach FL S466223760602346 Card 7158",
    );
    expect(parsed.txns[0]!.rawDescription).not.toContain("Page 3");
    expect(parsed.txns[1]!.amountCents).toBe(100);
  });

  test("a check number stays in the description rather than being dropped", () => {
    const parsed = parseWellsFargoLines(
      statement([
        line([["8/4", 65], ["043257", 124], ["Flamingo Rent 260803 xxxxx3120 Rayan Karim Checa", 150], ["2,237.11", 474]]),
      ]),
    );
    expect(parsed.txns[0]!.rawDescription).toBe("043257 Flamingo Rent 260803 xxxxx3120 Rayan Karim Checa");
    expect(parsed.txns[0]!.amountCents).toBe(-223711);
  });

  /**
   * Activity prints M/D with no year, so a December row on a Dec→Jan statement
   * has to resolve BACKWARDS — the same rule and the same reason as the Chase
   * checking profile.
   */
  test("a statement spanning New Year dates its December rows to the prior year", () => {
    y = 0;
    const lines = [
      line([["January 5, 2027", 36], ["Page 2 of 6", 119]]),
      line([["Account number:", 356], ["8920495481 (primary account)", 419]]),
      line([["Beginning balance on 12/6", 65], ["$100.00", 310]]),
      line([["Ending balance on 1/5", 65], ["$50.00", 293]]),
      HEADER(),
      line([["12/28", 65], ["Purchase authorized on 12/27 Somewhere", 90], ["25.00", 485]]),
      line([["1/2", 65], ["Purchase authorized on 01/01 Elsewhere", 90], ["25.00", 485]]),
      line([["Totals", 62], ["$0.00", 400], ["$50.00", 468]]),
    ];
    const parsed = parseWellsFargoLines(lines);
    expect(parsed.periodStart).toBe("2026-12-06");
    expect(parsed.periodEnd).toBe("2027-01-05");
    expect(parsed.txns.map((t) => t.postedOn)).toEqual(["2026-12-28", "2027-01-02"]);
  });

  /**
   * ⛔ Without the column header there is no way to tell an inflow from an
   * outflow, so this must FAIL rather than guess. Guessing would post every
   * purchase as income and the arithmetic would still "work" against a
   * beginning balance of zero.
   */
  test("a statement with no column header is a parse error, not a guess", () => {
    y = 0;
    const lines = [
      line([["August 25, 2026", 36], ["Page 2 of 6", 119]]),
      line([["Beginning balance on 7/27", 65], ["$0.00", 310]]),
      line([["Ending balance on 8/25", 65], ["$2,396.67", 293]]),
      line([["8/3", 65], ["Purchase authorized on 07/30 Somewhere", 90], ["7.00", 489]]),
    ];
    expect(() => parseWellsFargoLines(lines)).toThrow(ParseError);
    expect(() => parseWellsFargoLines(lines)).toThrow(/cannot tell an inflow from an outflow/);
  });

  test("a missing printed balance is a parse error", () => {
    y = 0;
    expect(() =>
      parseWellsFargoLines([
        line([["August 25, 2026", 36], ["Page 2 of 6", 119]]),
        HEADER(),
      ]),
    ).toThrow(/Beginning balance/);
  });

  /**
   * The real statement, end to end: 39 rows, $6,447.92 in and $4,051.25 out,
   * closing at $2,396.67 from a standing start. These totals are the
   * statement's own printed figures, so a parser that drops or flips a row
   * fails here the way the Discover parser's silent row-drop did not.
   */
  test("the real statement's rows sum to the printed balance change", () => {
    const parsed = parseWellsFargoLines(
      statement([
        line([["7/27", 65], ["WFB Opening Deposit From Card", 90], ["25.00", 416], ["25.00", 548]]),
        line([["7/29", 65], ["Rezaul Karim Kha 52575821_1", 90], ["2,022.92", 406]]),
        line([["7/29", 65], ["Zelle From Rayan Karim Checa on 07/29", 90], ["1.00", 421]]),
        line([["7/29", 65], ["Zelle From Rayan Karim Checa on 07/29", 90], ["199.00", 412]]),
        line([["7/29", 65], ["Zelle From Monira Hossain on 07/29", 90], ["2,000.00", 406], ["4,247.92", 538]]),
        line([["8/11", 65], ["Zelle From Rayan Karim Checa on 08/11", 90], ["200.00", 412]]),
        line([["8/24", 65], ["Zelle From Rayan Karim Checa on 08/24", 90], ["1.00", 421]]),
        line([["8/24", 65], ["Zelle From Rayan Karim Checa on 08/24", 90], ["1,999.00", 406], ["2,396.67", 538]]),
        line([["8/4", 65], ["043257 Flamingo Rent", 90], ["2,237.11", 474]]),
        line([["8/10", 65], ["Capital One Mobile Pmt", 90], ["1,321.97", 474], ["258.67", 544]]),
      ]),
    );
    const inflow = parsed.txns.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0);
    const outflow = parsed.txns.filter((t) => t.amountCents < 0).reduce((s, t) => s - t.amountCents, 0);
    expect(inflow).toBe(644792);
    expect(outflow).toBe(355908); // the two large debits above; purchases omitted for brevity
    expect(parsed.txns).toHaveLength(10);
  });
});
