import { describe, expect, test } from "vitest";
import {
  alignOverDays,
  buildDashboardSeries,
  unionDays,
  type AccountSeriesInput,
} from "./multi-series";

const checking: AccountSeriesInput = {
  id: "a1",
  label: "Checking",
  isLiability: false,
  hasHistory: true,
  points: [
    { day: "2026-07-01", balanceCents: 100000, exact: true },
    { day: "2026-07-03", balanceCents: 120000, exact: true },
  ],
};
const savings: AccountSeriesInput = {
  id: "a2",
  label: "Savings",
  isLiability: false,
  hasHistory: true,
  points: [{ day: "2026-07-02", balanceCents: 500000, exact: true }],
};
const card: AccountSeriesInput = {
  id: "c1",
  label: "Venture X",
  isLiability: true,
  hasHistory: true,
  points: [
    { day: "2026-07-01", balanceCents: -40000, exact: true },
    { day: "2026-07-02", balanceCents: -60000, exact: false }, // carried/unverified day
  ],
};

describe("unionDays", () => {
  test("sorted unique union of all accounts' days", () => {
    expect(unionDays([checking, savings, card])).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });
  test("empty input → empty axis", () => {
    expect(unionDays([])).toEqual([]);
  });
});

describe("alignOverDays", () => {
  const days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"];

  test("null before the first known day; trailing carry-forward after the last", () => {
    expect(alignOverDays(savings.points, days)).toEqual([
      null, // savings hasn't started — honestly absent, never zero
      { valueCents: 500000, exact: true, carried: false },
      { valueCents: 500000, exact: true, carried: true },
      { valueCents: 500000, exact: true, carried: true },
    ]);
  });

  test("gaps inside the range carry the last known value", () => {
    expect(alignOverDays(checking.points, days)).toEqual([
      { valueCents: 100000, exact: true, carried: false },
      { valueCents: 100000, exact: true, carried: true }, // 07-02 missing → carries 07-01
      { valueCents: 120000, exact: true, carried: false },
      { valueCents: 120000, exact: true, carried: true },
    ]);
  });

  test("an inexact source day stays inexact when carried", () => {
    const aligned = alignOverDays(card.points, days);
    expect(aligned[1]).toEqual({ valueCents: -60000, exact: false, carried: false });
    expect(aligned[2]).toEqual({ valueCents: -60000, exact: false, carried: true });
  });
});

describe("buildDashboardSeries", () => {
  const inputs = [checking, savings, card];

  test("combined: one net series summing all accounts, partial early days marked incomplete", () => {
    const out = buildDashboardSeries(inputs, { mode: "combined" });
    expect(out).toHaveLength(1);
    const net = out[0]!;
    expect(net.key).toBe("net");
    // 07-01: checking 1000 + card −400 (savings absent → partial) = 600, incomplete
    expect(net.points[0]).toMatchObject({ day: "2026-07-01", valueCents: 60000, complete: false });
    // 07-02: 1000(carried) + 5000 − 600 = 5400 — all covered, but the card day is inexact
    expect(net.points[1]).toMatchObject({ day: "2026-07-02", valueCents: 540000, complete: false });
    // 07-03: 1200 + 5000(carried) − 600(carried-inexact) = 5600 — carried days still count as covered
    expect(net.points[2]).toMatchObject({ day: "2026-07-03", valueCents: 560000, complete: false });
  });

  test("`complete` conflates two causes; the coverage fields separate them", () => {
    // this is the distinction a percentage depends on: 07-01 is incomplete
    // because an account is MISSING, 07-02 because a covered one is an
    // ESTIMATE. Only the first is a reason to refuse to compare.
    const net = buildDashboardSeries(inputs, { mode: "combined" })[0]!;

    const first = net.points[0]!;
    expect(first.complete).toBe(false);
    expect(first.coveredAccountNames).toEqual(["Checking", "Venture X"]);
    // Savings has not opened yet — not a hole, and it names the day it starts
    expect(first.notYetOpen).toEqual([{ name: "Savings", opensOn: "2026-07-02" }]);
    expect(first.gapAccounts).toEqual([]);

    const second = net.points[1]!;
    expect(second.complete).toBe(false); // an inexact member
    // …yet every account is covered, so there is nothing to exclude
    expect(second.coveredAccountNames).toHaveLength(3);
    expect(second.notYetOpen).toEqual([]);
    expect(second.gapAccounts).toEqual([]);
  });

  test("coveredCents is signed and parallel to the names", () => {
    const first = buildDashboardSeries(inputs, { mode: "combined" })[0]!.points[0]!;
    // the card is a liability: its own contribution is negative in the net frame
    expect(first.coveredCents).toEqual([100000, -40000]);
    expect(first.coveredCents!.reduce((a, b) => a + b, 0)).toBe(first.valueCents);
    expect(first.totalAccounts).toBe(3);
  });

  test("combined with all-exact coverage is complete", () => {
    const out = buildDashboardSeries([checking], { mode: "combined" });
    expect(out[0]!.points.every((p) => p.complete)).toBe(true);
  });

  test("assets: only asset accounts, natural sign", () => {
    const out = buildDashboardSeries(inputs, { mode: "assets" });
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("assets");
    expect(out[0]!.points[1]!.valueCents).toBe(600000); // 1000 carried + 5000
  });

  test("liabilities: owed frame — positive figures", () => {
    const out = buildDashboardSeries(inputs, { mode: "liabilities" });
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("liabilities");
    expect(out[0]!.label).toBe("Amount owed");
    // the debt carries to 07-03 (the card's balance didn't vanish when other accounts updated)
    expect(out[0]!.points.map((p) => p.valueCents)).toEqual([40000, 60000, 60000]);
  });

  test("liabilities with no liability accounts → empty series list", () => {
    expect(buildDashboardSeries([checking, savings], { mode: "liabilities" })).toEqual([]);
  });

  test("split: an assets line and an owed-positive liabilities line on the same axis", () => {
    const out = buildDashboardSeries(inputs, { mode: "split" });
    expect(out.map((s) => s.key)).toEqual(["assets", "liabilities"]);
    const days = out[0]!.points.map((p) => p.day);
    expect(out[1]!.points.map((p) => p.day)).toEqual(days); // shared axis
    expect(out[1]!.points.every((p) => (p.valueCents ?? 0) >= 0)).toBe(true);
  });

  test("accounts: one series per selected account, liabilities in their owed frame", () => {
    const out = buildDashboardSeries(inputs, { mode: "accounts", accountIds: ["c1", "a1"] });
    expect(out.map((s) => s.key)).toEqual(["a1", "c1"]); // input order, not selection order
    const cardSeries = out.find((s) => s.key === "c1")!;
    expect(cardSeries.label).toBe("Venture X");
    expect(cardSeries.owedFrame).toBe(true);
    expect(cardSeries.points[0]!.valueCents).toBe(40000); // owed-positive
    // an account's pre-history days are simply absent from its series (no null points)
    const checkingSeries = out.find((s) => s.key === "a1")!;
    expect(checkingSeries.points.map((p) => p.day)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });

  test("accounts: per-account carried days are honest (complete:false)", () => {
    const out = buildDashboardSeries(inputs, { mode: "accounts", accountIds: ["a1"] });
    const pts = out[0]!.points;
    expect(pts[0]!.complete).toBe(true); // exact day
    expect(pts[1]!.complete).toBe(false); // carried
    expect(pts[2]!.complete).toBe(true); // exact day
  });

  test("accounts with an empty selection → empty list", () => {
    expect(buildDashboardSeries(inputs, { mode: "accounts", accountIds: [] })).toEqual([]);
  });

  test("axis trims to days where at least one shown series exists", () => {
    const out = buildDashboardSeries([savings], { mode: "combined" });
    expect(out[0]!.points.map((p) => p.day)).toEqual(["2026-07-02"]);
  });

  test("no inputs at all → every mode returns an empty list", () => {
    for (const mode of ["combined", "assets", "liabilities", "split", "accounts"] as const) {
      expect(buildDashboardSeries([], { mode })).toEqual([]);
    }
  });

  test("assets mode with only liability accounts → empty list", () => {
    expect(buildDashboardSeries([card], { mode: "assets" })).toEqual([]);
  });

  test("split with only assets → just the assets line; with only liabilities → just the owed line", () => {
    expect(buildDashboardSeries([checking], { mode: "split" }).map((s) => s.key)).toEqual(["assets"]);
    expect(buildDashboardSeries([card], { mode: "split" }).map((s) => s.key)).toEqual(["liabilities"]);
  });

  test("accounts mode with no accountIds option → empty list", () => {
    expect(buildDashboardSeries(inputs, { mode: "accounts" })).toEqual([]);
  });

  test("a rollup day covered by NO member is a null line-break (assets before any asset existed)", () => {
    const earlyCard: AccountSeriesInput = {
      ...card,
      points: [{ day: "2026-06-30", balanceCents: -10000, exact: true }, ...card.points],
    };
    const out = buildDashboardSeries([checking, earlyCard], { mode: "assets" });
    // 06-30 is on the shared axis (the card has it) but no ASSET account covers it
    expect(out[0]!.points[0]).toMatchObject({ day: "2026-06-30", valueCents: null, complete: false });
  });

  test("accounts mode: a later-starting account's line begins at its own first day", () => {
    const out = buildDashboardSeries(inputs, { mode: "accounts", accountIds: ["a2"] });
    expect(out[0]!.points.map((p) => p.day)).toEqual(["2026-07-02", "2026-07-03"]);
  });

  test("an account with no points aligns to all-null (absent, never zero)", () => {
    const unplaceable: AccountSeriesInput = {
      id: "x",
      label: "Unplaceable",
      isLiability: false,
      hasHistory: true, // rows the ledger cannot place — a real hole
      points: [],
    };
    expect(alignOverDays(unplaceable.points, ["2026-07-01", "2026-07-02"])).toEqual([null, null]);
    // and its rollup membership keeps every day incomplete (it never covers)
    const out = buildDashboardSeries([checking, unplaceable], { mode: "combined" });
    expect(out[0]!.points.every((p) => !p.complete)).toBe(true);
    expect(out[0]!.points[0]!.gapAccounts).toEqual(["Unplaceable"]);
  });
});

describe("an EMPTY member is not a hole", () => {
  /*
   * 🔴 `rollupLine` re-derived `splitMissing`'s question with two buckets and no
   * empty one, so `Capital One 360 Checking` — zero rows, zero balances — was a
   * gap on every day of the assets rollup. `sharedCoverageChange` bails on a
   * gap, so `?chart=assets` fell back to the raw endpoint difference over two
   * different account populations: "▲ +$47,478.87 · Assets · 1Y" where
   * like-for-like is +$8,476.20, with no percentage and no scope note. Net
   * worth on the same switcher read "+$8,434.38", and assets − owed did not
   * equal it.
   */
  const emptyAccount: AccountSeriesInput = {
    id: "e1",
    label: "Capital One 360 Checking",
    isLiability: false,
    hasHistory: false, // the ledger holds nothing for it at all
    points: [],
  };

  test("it lands in emptyAccounts, never in gapAccounts", () => {
    const out = buildDashboardSeries([checking, emptyAccount], { mode: "combined" });
    const p = out[0]!.points[0]!;
    expect(p.emptyAccounts).toEqual(["Capital One 360 Checking"]);
    expect(p.gapAccounts).toEqual([]);
  });

  test("it does not make a day incomplete — there is nothing for it to cover", () => {
    const out = buildDashboardSeries([checking, emptyAccount], { mode: "combined" });
    // 2026-07-01 and 07-03 are Checking's own exact days
    expect(out[0]!.points[0]!.complete).toBe(true);
    expect(out[0]!.points.at(-1)!.complete).toBe(true);
  });

  test("hasHistory is what separates the two, not the absence of points", () => {
    const hole = { ...emptyAccount, id: "h1", label: "Unplaceable", hasHistory: true };
    const withEmpty = buildDashboardSeries([checking, emptyAccount], { mode: "combined" });
    const withHole = buildDashboardSeries([checking, hole], { mode: "combined" });
    expect(withEmpty[0]!.points[0]!.complete).toBe(true);
    expect(withHole[0]!.points[0]!.complete).toBe(false);
  });

  test("an account that has not opened YET is still notYetOpen, not empty", () => {
    const out = buildDashboardSeries([checking, savings], { mode: "combined" });
    // savings opens 07-02, so 07-01 names it as not-yet-open
    expect(out[0]!.points[0]!.notYetOpen).toEqual([{ name: "Savings", opensOn: "2026-07-02" }]);
    expect(out[0]!.points[0]!.emptyAccounts).toEqual([]);
  });
});
