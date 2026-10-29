import { describe, expect, test } from "vitest";
import { bucketNetMeasured, type NetBucket } from "./cash-flow-net";

const read: NetBucket = { unreached: null, spendingUnaccounted: null, incomeUnread: false };

/*
 * ⛔ The one rule for a bucket's Net (the table, the chart's hover, its Net line). Each reading below is a bucket of his
 * ledger copy 2026-10-29 (`cashFlowByPeriod` at today 2026-10-29): Sep 24 read in full, Oct 15 not imported yet, Oct 30
 * not happened, Aug 24, 2022 before his records, Aug 30 with no spending past Aug 12, Oct 14 with no day checked where
 * his pay lands (Wells Fargo, through Sep 24), and Oct 4 with both.
 */
describe("bucketNetMeasured", () => {
  test("a bucket read in full has a Net", () => {
    expect(bucketNetMeasured(read)).toBe(true);
  });

  test("past the ledger's ends there is none", () => {
    expect(bucketNetMeasured({ ...read, unreached: "after-records" })).toBe(false);
    expect(bucketNetMeasured({ ...read, unreached: "future" })).toBe(false);
    expect(bucketNetMeasured({ ...read, unreached: "before-records" })).toBe(false);
  });

  test("nor where its Spent is no measurement, nor its Income — Net is the arithmetic of both", () => {
    expect(bucketNetMeasured({ ...read, spendingUnaccounted: "spending imported through Aug 12" })).toBe(false);
    expect(bucketNetMeasured({ ...read, incomeUnread: true })).toBe(false);
    expect(
      bucketNetMeasured({ ...read, spendingUnaccounted: "spending imported through Aug 12", incomeUnread: true }),
    ).toBe(false);
  });
});
