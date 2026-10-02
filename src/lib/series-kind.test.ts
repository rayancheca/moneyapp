import { describe, expect, test } from "vitest";
import { SERIES_KINDS } from "@/db/schema/recurring";
import { seriesIsIncomeOrSpending } from "./series-kind";

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
