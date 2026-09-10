import { describe, expect, it } from "vitest";
import { groupByDay, pageBoundary, type LedgerRow } from "./TransactionsLedger";

function row(postedOn: string, amountCents: number, id = `${postedOn}-${amountCents}`): LedgerRow {
  return {
    id,
    postedOn,
    rawDescription: "RAW",
    normalizedDescription: "Row",
    accountName: "Checking",
    amountCents,
    categoryId: null,
    categoryName: null,
    hue: null,
    icon: null,
    merchantId: null,
    isTransfer: false,
    isRecurring: false,
    needsReview: false,
    status: "active",
    notes: null,
    isManual: false,
    lowConfidence: false,
    suggestedCategoryIds: [],
  };
}

describe("groupByDay", () => {
  it("groups consecutive rows by day and nets each day", () => {
    const groups = groupByDay([
      row("2026-03-02", -1_000),
      row("2026-03-02", 2_500),
      row("2026-03-01", -400),
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-02", "2026-03-01"]);
    expect(groups.map((g) => g.netCents)).toEqual([1_500, -400]);
    expect(groups[0]!.rows).toHaveLength(2);
  });

  it("marks no group partial when the whole set is in hand", () => {
    const groups = groupByDay([row("2026-03-02", -1_000), row("2026-03-01", -400)]);
    expect(groups.every((g) => g.partial)).toBe(false);
  });

  it("flags the boundary-touching groups when the page hides rows", () => {
    const rows = [row("2026-03-03", -100), row("2026-03-02", -200), row("2026-03-01", -300)];
    const groups = groupByDay(rows, { hiddenBefore: true, hiddenAfter: true });
    expect(groups.map((g) => g.partial)).toEqual([true, false, true]);
    // the subtotals themselves stay exactly what is on the page — the caption
    // is what changes, never the arithmetic
    expect(groups.map((g) => g.netCents)).toEqual([-100, -200, -300]);
  });

  it("flags only the side that actually hides rows", () => {
    const rows = [row("2026-03-03", -100), row("2026-03-01", -300)];
    expect(groupByDay(rows, { hiddenBefore: true }).map((g) => g.partial)).toEqual([true, false]);
    expect(groupByDay(rows, { hiddenAfter: true }).map((g) => g.partial)).toEqual([false, true]);
  });

  it("flags a lone group when the boundary cuts it on either side", () => {
    const groups = groupByDay([row("2026-03-03", -100), row("2026-03-03", -200)], {
      hiddenAfter: true,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.partial).toBe(true);
  });

  it("returns no groups for no rows, whatever the boundary says", () => {
    expect(groupByDay([], { hiddenBefore: true, hiddenAfter: true })).toEqual([]);
  });
});

describe("pageBoundary", () => {
  // 157 rows at 50/page: pages 1-3 are full, page 4 holds 7.
  const total = 157;
  const size = 50;
  const rowsOn = (page: number) => Math.min(size, total - (page - 1) * size);
  /** the neighbouring rows continue the page's own day at both ends — a CUT day */
  const cut = (day = "2026-07-29") => ({
    firstDayOnPage: day,
    lastDayOnPage: day,
    previousDay: day,
    nextDay: day,
  });

  it("hides nothing on either side when one page holds every match", () => {
    expect(
      pageBoundary({ page: 1, pageSize: 50, rowsOnPage: 12, totalMatching: 12, ...cut() }),
    ).toEqual({ hiddenBefore: false, hiddenAfter: false });
  });

  it("reports rows after every page but the last", () => {
    for (const page of [1, 2, 3]) {
      expect(
        pageBoundary({ page, pageSize: size, rowsOnPage: rowsOn(page), totalMatching: total, ...cut() }),
      ).toEqual({ hiddenBefore: page > 1, hiddenAfter: true });
    }
  });

  // the regression: a short final page must not claim its last day is cut.
  // `page * rowsOnPage` gave 4 * 7 = 28 < 157 → a false "partial" on the last
  // day of the ledger, on any total that is not a multiple of the page size.
  it("reports nothing after a short final page", () => {
    expect(
      pageBoundary({ page: 4, pageSize: size, rowsOnPage: rowsOn(4), totalMatching: total, ...cut() }),
    ).toEqual({ hiddenBefore: true, hiddenAfter: false });
  });

  it("reports nothing after an exactly-full final page", () => {
    expect(
      pageBoundary({ page: 2, pageSize: 50, rowsOnPage: 50, totalMatching: 100, ...cut() }),
    ).toEqual({ hiddenBefore: true, hiddenAfter: false });
  });

  it("survives an empty page past the end without inventing rows after it", () => {
    expect(
      pageBoundary({
        page: 9,
        pageSize: 50,
        rowsOnPage: 0,
        totalMatching: 157,
        firstDayOnPage: null,
        lastDayOnPage: null,
        previousDay: "2026-07-29",
        nextDay: null,
      }),
    ).toEqual({ hiddenBefore: false, hiddenAfter: false });
  });

  /**
   * 🔴 The defect: "there are more rows" is not "this day is cut". Both edges
   * were flagged whenever a neighbouring page existed, whatever day it started
   * on. Measured on the owner's ledger 2026-09-10, unfiltered — 31 of the 203
   * page boundaries land on a day change, so 62 day headers wore the tag over a
   * subtotal that was complete. Page 3 ends on 2026-07-30, page 4 opens on
   * 2026-07-29, all 21 of that day's rows are on page 4, and its header read
   * "+$3,948.91 · partial" against a ledger total of exactly $3,948.91.
   */
  it("does not call a day cut when the boundary lands on a day change", () => {
    expect(
      pageBoundary({
        page: 4,
        pageSize: size,
        rowsOnPage: size,
        totalMatching: total,
        firstDayOnPage: "2026-07-29",
        lastDayOnPage: "2026-07-27",
        previousDay: "2026-07-30",
        nextDay: "2026-07-26",
      }),
    ).toEqual({ hiddenBefore: false, hiddenAfter: false });
  });

  it("calls exactly the cut edge cut when only one end continues", () => {
    expect(
      pageBoundary({
        page: 2,
        pageSize: size,
        rowsOnPage: size,
        totalMatching: total,
        firstDayOnPage: "2026-07-29",
        lastDayOnPage: "2026-07-27",
        previousDay: "2026-07-29", // the page before ended mid-day
        nextDay: "2026-07-26", // the page after opens on a new one
      }),
    ).toEqual({ hiddenBefore: true, hiddenAfter: false });
    expect(
      pageBoundary({
        page: 2,
        pageSize: size,
        rowsOnPage: size,
        totalMatching: total,
        firstDayOnPage: "2026-07-29",
        lastDayOnPage: "2026-07-27",
        previousDay: "2026-07-30",
        nextDay: "2026-07-27", // …and here the day runs on
      }),
    ).toEqual({ hiddenBefore: false, hiddenAfter: true });
  });

  /** ⛔ a single-day page continuing at both ends is cut at both */
  it("flags both edges when one day spans the whole page", () => {
    expect(
      pageBoundary({ page: 2, pageSize: size, rowsOnPage: size, totalMatching: total, ...cut() }),
    ).toEqual({ hiddenBefore: true, hiddenAfter: true });
  });
});
