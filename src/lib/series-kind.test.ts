import { describe, expect, test } from "vitest";
import { type RatePeriod, SERIES_KINDS } from "@/db/schema/recurring";
import {
  AmountHistoryError,
  currentRatePeriod,
  parseAmountHistory,
  parseAmountHistoryText,
  ratePeriodOf,
  rateOn,
  seriesIsIncomeOrSpending,
} from "./series-kind";

/**
 * ⚖️ Every kind's money is income or spending by its sign — except a transfer's, which moves money between his own
 * accounts and so is counted in no net: not the forecast's lines, not the /recurring strip and footer printed under
 * the forecast card's net, not the Upcoming tab's 30-day net.
 */
describe("seriesIsIncomeOrSpending", () => {
  test("a transfer is the one kind no net counts", () => {
    expect(Object.fromEntries(SERIES_KINDS.map((kind) => [kind, seriesIsIncomeOrSpending(kind)]))).toEqual({
      income: true,
      bill: true,
      subscription: true,
      transfer: false,
      other: true,
    });
  });
});

/**
 * ⚖️ A series' rate has a DATED history (owner decision 2026-10-08, §6A 55): his weekly pay was $1,047.00 in cash
 * through Wed Aug 26 and is $1,141.92 by payroll from Thu Aug 27, and each payday is measured against its own time's
 * rate. The history holds the PAST only; the rate in force now stays the series' own amount — one home for "now".
 */
const HIS_HISTORY: readonly RatePeriod[] = [{ throughOn: "2026-08-26", amountCents: 104_700 }];
const HIS_PAY = { nextExpectedAmountCents: 114_192, amountHistory: HIS_HISTORY };

describe("rateOn", () => {
  test("with no history, every day — past or future — reads the series' own amount", () => {
    const flat = { nextExpectedAmountCents: 114_192, amountHistory: null };
    expect(rateOn(flat, "2026-06-04")).toBe(114_192);
    expect(rateOn(flat, "2027-01-07")).toBe(114_192);
  });

  test("his pay: the cash rate through Aug 26, the payroll rate from Aug 27", () => {
    expect(rateOn(HIS_PAY, "2026-06-04")).toBe(104_700);
    expect(rateOn(HIS_PAY, "2026-08-20")).toBe(104_700);
    expect(rateOn(HIS_PAY, "2026-08-26")).toBe(104_700);
    expect(rateOn(HIS_PAY, "2026-08-27")).toBe(114_192);
    expect(rateOn(HIS_PAY, "2026-10-08")).toBe(114_192);
  });

  test("each period runs from the day after the one before it, through its own day", () => {
    const twoRaises = {
      nextExpectedAmountCents: 114_192,
      amountHistory: [
        { throughOn: "2026-03-31", amountCents: 90_000 },
        { throughOn: "2026-08-26", amountCents: 104_700 },
      ],
    };
    expect(rateOn(twoRaises, "2025-01-02")).toBe(90_000);
    expect(rateOn(twoRaises, "2026-03-31")).toBe(90_000);
    expect(rateOn(twoRaises, "2026-04-01")).toBe(104_700);
    expect(rateOn(twoRaises, "2026-08-27")).toBe(114_192);
  });

  test("a series with no amount known has no rate now, but its past periods still say theirs", () => {
    expect(rateOn({ nextExpectedAmountCents: null, amountHistory: null }, "2026-08-27")).toBeNull();
    expect(rateOn({ nextExpectedAmountCents: null, amountHistory: HIS_HISTORY }, "2026-08-26")).toBe(104_700);
    expect(rateOn({ nextExpectedAmountCents: null, amountHistory: HIS_HISTORY }, "2026-08-27")).toBeNull();
  });
});

describe("ratePeriodOf", () => {
  test("with no history there is one era, numbered 0", () => {
    expect(ratePeriodOf({ amountHistory: null }, "2020-01-01")).toBe(0);
    expect(ratePeriodOf({ amountHistory: null }, "2030-01-01")).toBe(0);
  });

  test("his pay: Aug 26 is the cash era (0), Aug 27 the payroll era (1)", () => {
    expect(ratePeriodOf(HIS_PAY, "2026-06-04")).toBe(0);
    expect(ratePeriodOf(HIS_PAY, "2026-08-26")).toBe(0);
    expect(ratePeriodOf(HIS_PAY, "2026-08-27")).toBe(1);
  });

  test("the era is the index of the period whose rate `rateOn` reads", () => {
    const history = [
      { throughOn: "2026-03-31", amountCents: 90_000 },
      { throughOn: "2026-08-26", amountCents: 104_700 },
    ];
    const series = { nextExpectedAmountCents: 114_192, amountHistory: history };
    for (const day of ["2025-01-02", "2026-03-31", "2026-04-01", "2026-08-26", "2026-08-27"]) {
      const era = ratePeriodOf(series, day);
      expect(rateOn(series, day)).toBe(era < history.length ? history[era]!.amountCents : 114_192);
    }
    expect(["2026-03-31", "2026-04-01", "2026-08-27"].map((d) => ratePeriodOf(series, d))).toEqual([0, 1, 2]);
  });

  /* the era the posted average reads (`lib/posted-average`): the rate in force now */
  test("the era in force now is the one every day past the last period is in", () => {
    expect(currentRatePeriod({ amountHistory: null })).toBe(0);
    expect(currentRatePeriod(HIS_PAY)).toBe(ratePeriodOf(HIS_PAY, "2099-12-31"));
    expect(currentRatePeriod(HIS_PAY)).toBe(1);
  });
});

/**
 * ⛔ The column has no constraint, so the one reader is strict: a history it cannot read in exactly one way is
 * refused out loud — never read as "no history", which would price every past payday at today's rate in silence.
 */
describe("parseAmountHistory", () => {
  test("no history is null", () => {
    expect(parseAmountHistory(null, 114_192)).toBeNull();
    expect(parseAmountHistory(undefined, 114_192)).toBeNull();
  });

  test("his history reads as written", () => {
    expect(parseAmountHistory([{ throughOn: "2026-08-26", amountCents: 104_700 }], 114_192)).toEqual(HIS_HISTORY);
  });

  test.each<[string, unknown]>([
    ["an empty list — no history is NULL, said one way", []],
    ["not a list", { throughOn: "2026-08-26", amountCents: 104_700 }],
    ["a list written as a string inside the JSON", '[{"throughOn":"2026-08-26","amountCents":104700}]'],
    ["a period that is not an object", [104_700]],
    ["a period that is null", [null]],
    ["a period with no day", [{ amountCents: 104_700 }]],
    ["a period with no amount", [{ throughOn: "2026-08-26" }]],
    ["a period with a key the reader does not know", [{ throughOn: "2026-08-26", amountCents: 104_700, fromOn: "2026-06-04" }]],
    ["a day that is not YYYY-MM-DD", [{ throughOn: "2026-8-26", amountCents: 104_700 }]],
    ["a day no calendar has", [{ throughOn: "2026-02-30", amountCents: 104_700 }]],
    ["an amount with a fraction of a cent", [{ throughOn: "2026-08-26", amountCents: 104_700.5 }]],
    ["an amount written as text", [{ throughOn: "2026-08-26", amountCents: "104700" }]],
    ["a zero amount", [{ throughOn: "2026-08-26", amountCents: 0 }]],
    [
      "two periods ending the same day",
      [
        { throughOn: "2026-08-26", amountCents: 90_000 },
        { throughOn: "2026-08-26", amountCents: 104_700 },
      ],
    ],
    [
      "periods out of order",
      [
        { throughOn: "2026-08-26", amountCents: 104_700 },
        { throughOn: "2026-03-31", amountCents: 90_000 },
      ],
    ],
  ])("refuses %s", (_, raw) => {
    expect(() => parseAmountHistory(raw, 114_192)).toThrow(AmountHistoryError);
    // and for its own reason, not the direction check's: with no amount known now there is no direction to hold
    expect(() => parseAmountHistory(raw, null)).toThrow(AmountHistoryError);
  });

  test("a period with a key missing or one too many is refused by its keys", () => {
    for (const period of [{ amountCents: 104_700 }, { throughOn: "2026-08-26", amountCents: 104_700, fromOn: "2026-06-04" }]) {
      expect(() => parseAmountHistory([period], 114_192)).toThrow(/exactly throughOn and amountCents/);
    }
  });

  test("refuses a past rate whose money went the other way — a history never turns pay into a bill", () => {
    expect(() => parseAmountHistory([{ throughOn: "2026-08-26", amountCents: -104_700 }], 114_192)).toThrow(
      /the other way/,
    );
    // with no amount known now there is no direction to hold it to
    expect(parseAmountHistory([{ throughOn: "2026-08-26", amountCents: -104_700 }], null)).toEqual([
      { throughOn: "2026-08-26", amountCents: -104_700 },
    ]);
  });

  test("the refusal names what it could not read", () => {
    expect(() => parseAmountHistory([{ throughOn: "2026-02-30", amountCents: 104_700 }], 114_192)).toThrow(
      /2026-02-30/,
    );
  });
});

describe("parseAmountHistoryText — the column's own text, read raw", () => {
  test("NULL is no history; his text reads as written", () => {
    expect(parseAmountHistoryText(null, 114_192)).toBeNull();
    expect(parseAmountHistoryText('[{"throughOn":"2026-08-26","amountCents":104700}]', 114_192)).toEqual(HIS_HISTORY);
  });

  test("text that is not JSON is refused as a history, not thrown as a syntax error", () => {
    expect(() => parseAmountHistoryText("[{throughOn:2026-08-26}]", 114_192)).toThrow(AmountHistoryError);
  });

  test("a list stored twice-encoded is refused — it is a string, not a list", () => {
    expect(() =>
      parseAmountHistoryText(JSON.stringify('[{"throughOn":"2026-08-26","amountCents":104700}]'), 114_192),
    ).toThrow(AmountHistoryError);
  });
});
