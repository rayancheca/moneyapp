import { describe, expect, test } from "vitest";
import { dropSettlementLag, type Disagreement } from "./settlement-lag";

/**
 * Every scenario below is a shape the real Robinhood archive actually produced.
 * The stakes are asymmetric: a pair wrongly dropped hides missing money, while
 * a pair wrongly kept only prints a line a human then reads.
 */

const d = (day: string, cents: number): Disagreement => ({ day, cents });
const days = (result: readonly Disagreement[]) => result.map((r) => r.day);

describe("dropSettlementLag", () => {
  test("drops an adjacent-day mirror — the ledger dated the trade, the bank the settlement", () => {
    // 2025-04-09/10, $590.00: the whole of that month is four such pairs and it
    // nets to exactly $0.00
    expect(dropSettlementLag([d("2025-04-09", 59000), d("2025-04-10", -59000)])).toEqual([]);
  });

  test("drops a pair separated by a weekend", () => {
    // 2025-08-08 → 08-11 is a Friday to a Monday
    expect(dropSettlementLag([d("2025-08-08", 740), d("2025-08-11", -740)])).toEqual([]);
  });

  test("keeps a pair that straddles more than the window", () => {
    expect(days(dropSettlementLag([d("2025-04-01", 500), d("2025-04-20", -500)]))).toEqual([
      "2025-04-01",
      "2025-04-20",
    ]);
  });

  test("keeps same-signed neighbours — a lag reverses, it does not repeat", () => {
    expect(days(dropSettlementLag([d("2025-10-30", 149999), d("2025-10-31", 149999)]))).toEqual([
      "2025-10-30",
      "2025-10-31",
    ]);
  });

  test("keeps an amount that only nearly matches", () => {
    // $499.15 against the sweep's $499.16 is a real one-cent disagreement, not
    // a lag. Fuzzy amounts are how a heuristic starts cancelling real gaps.
    expect(dropSettlementLag([d("2025-10-22", 49915), d("2025-10-23", -49916)])).toHaveLength(2);
  });

  test("keeps the money that is genuinely missing", () => {
    // 2025-10-30: two ETH buys totalling $1,499.99 swept out of cash with no
    // ledger row anywhere near them
    expect(days(dropSettlementLag([d("2025-10-30", 149999)]))).toEqual(["2025-10-30"]);
  });

  test("pairs each side with its NEAREST partner, not the first one it meets", () => {
    const result = dropSettlementLag([
      d("2025-05-01", 1000),
      d("2025-05-02", -1000),
      d("2025-05-03", 1000),
      d("2025-05-04", -1000),
    ]);
    expect(result).toEqual([]);
  });

  test("refuses to pair when the match is not mutual, and strands the RIGHT row", () => {
    // 05-03 is 05-01's nearest opposite — but 05-01 is not 05-03's, because
    // 05-04 is a day closer. Walking in order and taking each first nearest
    // would marry 05-01 to 05-03 and strand 05-04; mutual-nearest marries the
    // adjacent pair and strands 05-01, which is the one that has no partner.
    //
    // ⚠️ Asserting only the COUNT or the NET here proves nothing: both walks
    // leave exactly one row worth +$10.00. Only the day tells them apart, and
    // an earlier version of this test that checked the count passed happily
    // with mutual-nearest deleted.
    const rows = [d("2025-05-01", 1000), d("2025-05-03", -1000), d("2025-05-04", 1000)];

    expect(days(dropSettlementLag(rows))).toEqual(["2025-05-01"]);
  });

  test("never invents or drops value beyond exact pairs", () => {
    // the net of what survives must equal the net of what went in, minus pairs
    // that each summed to zero — so the total is invariant
    const input = [
      d("2025-10-17", 20009),
      d("2025-10-20", 1352),
      d("2025-10-21", -22546),
      d("2025-10-30", 149999),
      d("2025-10-31", 3511),
    ];
    const before = input.reduce((n, r) => n + r.cents, 0);
    const after = dropSettlementLag(input).reduce((n, r) => n + r.cents, 0);
    expect(after).toBe(before);
  });

  test("an empty list is clean", () => {
    expect(dropSettlementLag([])).toEqual([]);
  });
});
