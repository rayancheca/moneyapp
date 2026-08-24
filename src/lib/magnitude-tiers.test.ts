import { describe, expect, test } from "vitest";
import {
  MAX_MAGNIFICATION,
  TIER_RATIO,
  magnitudeTiers,
  type MagnitudeInput,
} from "./magnitude-tiers";

/**
 * The real active accounts, 2026-08-24. Measured, not invented — on one linear
 * axis FIVE of these ten draw under a single device pixel, and the largest is
 * seven million times the smallest non-zero one.
 */
const ACCOUNTS: MagnitudeInput[] = [
  { key: "Robinhood Brokerage", cents: 7_029_175 },
  { key: "Robinhood Crypto", cents: 3_683_464 },
  { key: "Chase Checking", cents: 300_760 },
  { key: "Discover", cents: -55_762 },
  { key: "Venture X", cents: -36_799 },
  { key: "Robinhood Cash", cents: 11_388 },
  { key: "SoFi Savings", cents: 10 },
  { key: "SoFi Checking", cents: 1 },
  { key: "Chase Sapphire", cents: 0 },
  { key: "Cash on Hand", cents: 0 },
];

describe("magnitudeTiers — making a hundred dollars legible beside seventy thousand", () => {
  test("the real ledger splits into tiers that each fill their own axis", () => {
    const t = magnitudeTiers(ACCOUNTS);
    expect(t.tiers).toHaveLength(2);
    expect(t.tiers[0]!.keys).toEqual(["Robinhood Brokerage", "Robinhood Crypto", "Chase Checking"]);
    expect(t.tiers[1]!.keys).toEqual(["Discover", "Venture X", "Robinhood Cash"]);
  });

  test("every drawn value is at least a legible fraction of ITS OWN tier's axis", () => {
    // The whole point. On one axis Robinhood Cash is 0.16% — 0.34px at h-208.
    // Inside its own tier it is 20%, which is 42px.
    const t = magnitudeTiers(ACCOUNTS);
    for (const tier of t.tiers) {
      for (const key of tier.keys) {
        const v = Math.abs(ACCOUNTS.find((a) => a.key === key)!.cents);
        expect(v / tier.maxCents, `${key} in tier ${tier.index}`).toBeGreaterThanOrEqual(
          1 / TIER_RATIO,
        );
      }
    }
  });

  test("each tier states how much it is magnified, and the first is never magnified", () => {
    // An axis that silently changes scale is a lie. Stating the factor is what
    // makes the second panel honest rather than misleading.
    const t = magnitudeTiers(ACCOUNTS);
    expect(t.tiers[0]!.magnification).toBe(1);
    // 7,029,175 / 55,762 = 126.06…
    expect(t.tiers[1]!.magnification).toBe(126);
  });

  test("values too small to magnify honestly are LISTED, never drawn", () => {
    /*
     * SoFi Savings is ten cents against $70,291.75 — magnifying it to a full bar
     * would be a 702,917× lie dressed as information. Past the cap it stops
     * being a bar and becomes a sentence.
     */
    const t = magnitudeTiers(ACCOUNTS);
    expect(t.negligible).toEqual(["SoFi Savings", "SoFi Checking"]);
    expect(t.tiers.flatMap((x) => x.keys)).not.toContain("SoFi Savings");
  });

  test("an exact zero is its own thing — empty is not the same as tiny", () => {
    const t = magnitudeTiers(ACCOUNTS);
    expect(t.zero).toEqual(["Chase Sapphire", "Cash on Hand"]);
    expect(t.negligible).not.toContain("Chase Sapphire");
  });

  test("every input lands in exactly one bucket, and none is lost", () => {
    // The sweep that makes the partition a fact rather than an intention.
    const t = magnitudeTiers(ACCOUNTS);
    const placed = [...t.tiers.flatMap((x) => x.keys), ...t.negligible, ...t.zero];
    expect(placed).toHaveLength(ACCOUNTS.length);
    expect(new Set(placed).size).toBe(ACCOUNTS.length);
    for (const a of ACCOUNTS) expect(placed).toContain(a.key);
  });

  test("magnitude is what tiers, so a debt sits beside a balance of the same size", () => {
    // −$557.62 and +$557.62 are the same size on a bar chart. Sign is the
    // renderer's business; this decides how big things are.
    const t = magnitudeTiers([
      { key: "owed", cents: -55_762 },
      { key: "held", cents: 55_762 },
    ]);
    expect(t.tiers).toHaveLength(1);
    expect(t.tiers[0]!.keys).toEqual(["owed", "held"]);
  });

  test("values of one size all sit in one tier, unmagnified", () => {
    const t = magnitudeTiers([
      { key: "a", cents: 100_000 },
      { key: "b", cents: 90_000 },
      { key: "c", cents: 80_000 },
    ]);
    expect(t.tiers).toHaveLength(1);
    expect(t.tiers[0]!.magnification).toBe(1);
  });

  test("a chain of decades keeps splitting rather than crushing the tail", () => {
    // 1,000,000 → 1 in decades. Each tier holds the values within TIER_RATIO of
    // its own head, and the tail stays readable instead of collapsing to zero.
    const t = magnitudeTiers(
      [6, 5, 4, 3, 2, 1, 0].map((p) => ({ key: `e${p}`, cents: 10 ** p })),
    );
    expect(t.tiers.length).toBeGreaterThan(1);
    for (const tier of t.tiers) {
      const smallest = Math.min(
        ...tier.keys.map((k) => Math.abs(10 ** Number(k.slice(1)))),
      );
      expect(smallest / tier.maxCents).toBeGreaterThanOrEqual(1 / TIER_RATIO);
    }
  });

  test("no tier is ever magnified past the cap", () => {
    const t = magnitudeTiers(ACCOUNTS);
    for (const tier of t.tiers) expect(tier.magnification).toBeLessThanOrEqual(MAX_MAGNIFICATION);
  });

  test("an empty input, and an all-zero input, are handled rather than divided by", () => {
    expect(magnitudeTiers([])).toEqual({ tiers: [], negligible: [], zero: [] });
    const z = magnitudeTiers([{ key: "a", cents: 0 }, { key: "b", cents: 0 }]);
    expect(z.tiers).toEqual([]);
    expect(z.zero).toEqual(["a", "b"]);
  });

  test("ties keep the caller's order, so a render never reshuffles between two passes", () => {
    const t = magnitudeTiers([
      { key: "b", cents: 100 },
      { key: "a", cents: 100 },
    ]);
    expect(t.tiers[0]!.keys).toEqual(["b", "a"]);
  });

  test("the ratio can be tightened, and tightening it makes more tiers", () => {
    const loose = magnitudeTiers(ACCOUNTS);
    const tight = magnitudeTiers(ACCOUNTS, { tierRatio: 4 });
    expect(tight.tiers.length).toBeGreaterThan(loose.tiers.length);
  });
});
