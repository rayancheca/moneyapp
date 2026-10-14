import { describe, expect, test } from "vitest";
import type { HeatDay } from "@/services/spending";
import { heatCellLabel, heatDaySheetSentence } from "./SpendHeatmap";

const TODAY = "2026-09-10";
const REACHES = "2026-08-31";
/*
 * ⛔ INSIDE August, so the fixture can express a day before the records begin.
 * Without an opening day the label could only ever be asked about one end of the
 * ledger — which is all it ever checked.
 */
const OPENS = "2026-08-03";

const cell = (iso: string, day: HeatDay | null = null, over: Partial<Parameters<typeof heatCellLabel>[0]> = {}) =>
  heatCellLabel({
    iso,
    monthKey: "2026-09",
    monthName: "September 2026",
    day,
    today: TODAY,
    ledgerOpens: OPENS,
    ledgerReaches: REACHES,
    // every account he spends from is read as far as the ledger reaches, unless a test says otherwise
    spendingReadThrough: REACHES,
    ...over,
  });

const heat = (spentCents: number, incomeCents = 0, txnCount = 1, refundedCents = 0): HeatDay => ({
  iso: "2026-08-04",
  spentCents,
  incomeCents,
  txnCount,
  topCategories: [],
  topMerchants: [],
  refundedCents,
});

/**
 * 🔴 Measured 2026-09-10: `/spending` opens its heatmap on September and all 30
 * cells read "no activity" — ten of days nobody has imported, twenty of days
 * that have not happened — one card under the page's own "That is a window
 * nobody has looked at, not one in which nothing happened."
 */
describe("heatCellLabel — three worlds, three sentences", () => {
  /**
   * ⛔ …AND THE MEASUREMENT IS OF THREE THINGS, NOT OF EVERYTHING. The chart
   * counts expense-kind outflows, income-kind positives and expense-kind
   * credits; a day holding only a transfer, a card payment or an investment
   * flow falls through all three. "no activity" claimed the whole ledger for
   * it. Measured 2026-09-11: **79 days, covering 298 real transactions.**
   */
  test("a day the ledger walked through and found empty is a measurement", () => {
    expect(cell("2026-08-04", null, { monthKey: "2026-08", monthName: "August 2026" })).toBe(
      "Aug 4: no spending or income",
    );
  });

  test("a past day the import has not reached says nobody has looked", () => {
    expect(cell("2026-09-04")).toBe("Sep 4: not imported yet");
  });

  test("a day after today says it has not happened", () => {
    expect(cell("2026-09-11")).toBe("Sep 11: has not happened yet");
  });

  test("today itself is not the future — it is merely unimported here", () => {
    expect(cell("2026-09-10")).toBe("Sep 10: not imported yet");
  });

  test("the last reached day is a measurement, the next one is not", () => {
    expect(cell("2026-08-31", null, { monthKey: "2026-08", monthName: "August 2026" })).toBe(
      "Aug 31: no spending or income",
    );
    expect(cell("2026-09-01")).toBe("Sep 1: not imported yet");
  });

  test("an empty ledger has reached nothing at all", () => {
    expect(cell("2026-08-04", null, { monthKey: "2026-08", monthName: "August 2026", ledgerReaches: null })).toBe(
      "Aug 4: not imported yet",
    );
  });

  /* ⛔ the padding half, fixed 2026-09-04 and still load-bearing */
  test("a padding day from a neighbouring month is never described at all", () => {
    expect(cell("2026-08-31")).toBe("Aug 31: not part of September 2026 — open its ledger");
  });

  test("a day with money reports it, and the frontier never overrides a measurement", () => {
    expect(
      cell("2026-08-04", heat(12_50, 0, 2), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: $12.50 spent across 2 transactions");
  });
});

describe("a day whose only row is a return", () => {
  /* 🔴 The service skips a credit in an expense category from both buckets on
     purpose, so such a day arrived with two zeroes and read "no activity" over
     a posted row. Two days on the owner's ledger: 2025-05-10 ($18.00 back) and
     2025-11-22 ($5.58). */
  test("names the refund instead of calling the day empty", () => {
    expect(
      cell("2026-08-04", heat(0, 0, 0, 1_800), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: $18.00 refunded");
  });

  test("a day with spending is unaffected by a refund on it", () => {
    expect(
      cell("2026-08-04", heat(5_000, 0, 1, 1_800), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: $50.00 spent across 1 transaction");
  });

  /*
   * 🔴 S22. The figure is every positive income-kind row — measured on the real
   * ledger 2026-09-15, `/spending?period=2024-09` read "Sep 10: $37.65 spent
   * across 3 transactions, mostly Food, $14,171.00 earned" over a financial-aid
   * refund, which /summary files as money he did not earn. Owner decision
   * 2026-09-14: this population is Income.
   */
  test("money in is named income, the word /spending uses for this population", () => {
    const label = cell("2026-08-04", heat(3_765, 1_417_100, 3), { monthKey: "2026-08", monthName: "August 2026" });
    expect(label).toBe("Aug 4: $37.65 spent across 3 transactions, $14,171.00 income");
    expect(label).not.toMatch(/earn/i);
  });

  test("a covered day with nothing in this chart's three buckets says exactly that", () => {
    expect(
      cell("2026-08-04", heat(0, 0, 0, 0), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: no spending or income");
  });
});

/**
 * 🔴 THE OPENING END. Measured on the owner's ledger 2026-09-14, whose first
 * active row is 2022-08-25: `/spending?period=2022-08` read
 *
 *     "Aug 1: nothing spent or earned" … "Aug 24: nothing spent or earned"
 *
 * — twenty-four days before the records begin, labelled as measured zeros, while
 * the same component on `?period=2026-09` already said "Sep 13: not imported
 * yet". The heatmap was handed `ledgerReaches` and never `ledgerOpens`, so only
 * the closing end could be asked. The ‹ button pages back with no limit (owner
 * decision 2026-09-14, E3a), so every month before August 2022 read the same.
 */
describe("heatCellLabel — the days before the records begin", () => {
  const august = { monthKey: "2026-08", monthName: "August 2026" };

  test("a day before the ledger opens says so, not that nothing was spent", () => {
    expect(cell("2026-08-02", null, august)).toBe("Aug 2: before your records begin");
  });

  test("the opening day itself is a measurement", () => {
    expect(cell("2026-08-03", null, august)).toBe("Aug 3: no spending or income");
  });

  test("a day after today has not happened, even on a ledger that holds nothing", () => {
    expect(cell("2026-09-11", null, { ledgerOpens: null, ledgerReaches: null })).toBe("Sep 11: has not happened yet");
  });

  test("a padding day is still never described, even one before the records", () => {
    expect(cell("2026-08-02")).toBe("Aug 2: not part of September 2026 — open its ledger");
  });

  /*
   * ⛔ THE FRONTIER NEVER OVERRIDES A MEASUREMENT — at the far end either. A
   * posted row dated after today is drawn in its cell ("−$50") and opens a sheet
   * listing it, and the label called the same day "has not happened yet". The
   * cash-flow buckets on this page follow the same rule: a bucket holding a row
   * is a figure.
   */
  test("a posted row on a day after today is reported, not called unhappened", () => {
    const reaches = { ledgerReaches: "2026-09-12" };
    expect(cell("2026-09-12", heat(5_000, 0, 1), reaches)).toBe("Sep 12: $50.00 spent across 1 transaction");
    expect(
      heatDaySheetSentence({
        iso: "2026-09-12",
        day: heat(5_000, 0, 1),
        today: TODAY,
        ledgerOpens: OPENS,
        spendingReadThrough: "2026-09-12",
        ...reaches,
      }),
    ).toBeNull();
  });
});

/**
 * ⛔ The cell and the sheet that opens from it must never describe two worlds —
 * the rule `heatCellLabel`'s own docstring states. The sheet carried its own copy
 * of the checks, with the same one-ended frontier.
 */
describe("heatDaySheetSentence — the sheet lands in the cell's world", () => {
  const sheet = (iso: string, day: HeatDay | null = null) =>
    heatDaySheetSentence({ iso, day, today: TODAY, ledgerOpens: OPENS, ledgerReaches: REACHES, spendingReadThrough: REACHES });

  test("a day before the records begin says so in the sheet too", () => {
    expect(sheet("2026-08-02")).toBe(
      "This day is before your records begin — nothing has been imported for it, which is not the same as nothing happening.",
    );
  });

  test.each([
    ["2026-08-02", "before your records begin", "before your records begin"],
    ["2026-08-04", "no spending or income", "No spending or income on this day."],
    ["2026-09-04", "not imported yet", "Nothing has been imported for this day yet"],
    ["2026-09-11", "has not happened yet", "This day has not happened yet."],
  ])("%s: the cell reads %j and the sheet agrees", (iso, cellWorld, sheetWorld) => {
    const monthKey = iso.slice(0, 7);
    const own = { monthKey, monthName: monthKey === "2026-08" ? "August 2026" : "September 2026" };
    expect(cell(iso, null, own)).toContain(cellWorld);
    expect(sheet(iso)).toContain(sheetWorld);
  });

  test("a day with money has no absence sentence — the sheet shows the day", () => {
    expect(sheet("2026-08-04", heat(12_50, 0, 2))).toBeNull();
  });

  test("a day whose only row is a return names it in the sheet", () => {
    expect(sheet("2026-08-04", heat(0, 0, 0, 1_800))).toBe(
      "No spending or income on this day — $18.00 came back as a refund.",
    );
  });
});

/**
 * ⚖️ His decision 72 (2026-10-13): a total over days its accounts have not been imported through is "partly read", and
 * one window reads one way everywhere. 🔴 Measured on his ledger copy 2026-10-13 (review of 06c6bf3): `/spending` for
 * September printed "spending imported through Aug 12 · 30 days of this period unaccounted" under Where it went, while
 * its heatmap — asked against `ledgerReaches`, Sep 24, the newest row anywhere — opened Sep 13 … Sep 22 on "No spending
 * or income on this day.": Venture X stops Sep 12, Wells Fargo resumes Sep 23, and Chase Sapphire and Chase Checking,
 * which he spends from too, are imported through Aug 12. A measured zero over days a card on the same page calls
 * unaccounted. The day those days are read against is the proof's (`spendingReadThrough`).
 */
describe("a day past the day all his spending is read through is unaccounted, not empty", () => {
  const READ = "2026-08-12";
  const august = { monthKey: "2026-08", monthName: "August 2026", spendingReadThrough: READ };
  const sheet = (iso: string, day: HeatDay | null = null) =>
    heatDaySheetSentence({ iso, day, today: TODAY, ledgerOpens: OPENS, ledgerReaches: REACHES, spendingReadThrough: READ });
  const UNREAD = "spending imported through Aug 12, and not every account you spend from has been read for it.";

  test("the day it is read through is a measurement", () => {
    expect(cell("2026-08-12", null, august)).toBe("Aug 12: no spending or income");
    expect(sheet("2026-08-12")).toBe("No spending or income on this day.");
  });

  test("the next day, read for some accounts and not every one, names the day all of them are read through", () => {
    expect(cell("2026-08-13", null, august)).toBe("Aug 13: nothing found so far — spending imported through Aug 12");
    expect(sheet("2026-08-13")).toBe(
      `Nothing has been found for this day so far — ${UNREAD} That is not the same as nothing happening.`,
    );
  });

  test("the ledger's own last day is unaccounted too, and the day after it is not imported at all", () => {
    expect(cell("2026-08-31", null, august)).toBe("Aug 31: nothing found so far — spending imported through Aug 12");
    expect(cell("2026-09-04", null, { spendingReadThrough: READ })).toBe("Sep 4: not imported yet");
    expect(sheet("2026-09-04")).toMatch(/^Nothing has been imported for this day yet/);
  });

  test("a day holding money still reports it", () => {
    expect(cell("2026-08-20", heat(12_50, 0, 2), august)).toBe("Aug 20: $12.50 spent across 2 transactions");
    expect(sheet("2026-08-20", heat(12_50, 0, 2))).toBeNull();
  });

  test("a refund found on such a day is named, and so is the day the rest is read through", () => {
    expect(cell("2026-08-20", heat(0, 0, 0, 1_800), august)).toBe("Aug 20: $18.00 refunded");
    expect(sheet("2026-08-20", heat(0, 0, 0, 1_800))).toBe(
      `Only a refund of $18.00 has been found for this day so far — ${UNREAD} That is not the same as nothing happening.`,
    );
  });

  test("a read day in another year is printed with its year", () => {
    const january = { monthKey: "2027-01", monthName: "January 2027", today: "2027-01-20", ledgerReaches: "2027-01-10" };
    expect(cell("2027-01-05", null, { ...january, spendingReadThrough: "2026-12-30" })).toBe(
      "Jan 5: nothing found so far — spending imported through Dec 30, 2026",
    );
  });

  /* ⚖️ a ledger of cash wallets alone has no day a statement could move — the proof grades nothing partly read there */
  test("with no day to read against, an empty day the ledger reaches is a measurement, as before", () => {
    expect(cell("2026-08-20", null, { ...august, spendingReadThrough: null })).toBe("Aug 20: no spending or income");
  });
});
