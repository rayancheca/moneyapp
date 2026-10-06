import { describe, expect, test } from "vitest";
import { MIN_INCOME_MONTHS_PRESENT, projectOngoingIncome, projectOngoingNetIncome } from "./income-forecast";

describe("projectOngoingIncome", () => {
  test("projects a bucket present in ≥2 trailing months at its trailing mean", () => {
    const [salary] = projectOngoingIncome([
      { label: "Salary", monthlyTotalsCents: [0, 200000, 400000] },
    ]);
    expect(salary).toMatchObject({ label: "Salary", monthlyCents: 200000, monthsPresent: 2 });
  });

  test("EXCLUDES a one-off (present in a single month) — refunds/aid don't extrapolate", () => {
    const out = projectOngoingIncome([
      { label: "Salary", monthlyTotalsCents: [0, 200000, 400000] }, // 2 months → in
      { label: "Refunds & Reimbursements", monthlyTotalsCents: [0, 0, 300000] }, // 1 month → out
      { label: "Financial Aid", monthlyTotalsCents: [0, 0, 0] }, // 0 months → out
    ]);
    expect(out.map((e) => e.label)).toEqual(["Salary"]);
  });

  test("NO upward trend nudge — a recent income spike is a one-off, not a ramp", () => {
    // trend would push a growing series to 300000; income must stay at the mean 200000
    const [e] = projectOngoingIncome([{ label: "Salary", monthlyTotalsCents: [100000, 200000, 300000] }]);
    expect(e!.monthlyCents).toBe(200000);
  });

  test("sorts by monthly amount desc, then label asc for ties", () => {
    const out = projectOngoingIncome([
      { label: "Interest", monthlyTotalsCents: [100000, 100000, 100000] }, // 100000
      { label: "Salary", monthlyTotalsCents: [200000, 200000, 200000] }, // 200000
      { label: "Bonus", monthlyTotalsCents: [100000, 100000, 100000] }, // 100000, ties Interest
    ]);
    expect(out.map((e) => e.label)).toEqual(["Salary", "Bonus", "Interest"]);
  });

  test("a steady bucket is high-confidence; the basis states its presence", () => {
    const [e] = projectOngoingIncome([{ label: "Interest", monthlyTotalsCents: [50000, 50000, 50000] }]);
    expect(e!.confidence).toBe(1);
    expect(e!.basis).toContain("present 3/3 mo");
  });

  test("a lumpy bucket reads fainter (confidence < 1) but still projects", () => {
    const [e] = projectOngoingIncome([{ label: "Salary", monthlyTotalsCents: [0, 200000, 400000] }]);
    expect(e!.confidence).toBeGreaterThan(0);
    expect(e!.confidence).toBeLessThan(1);
  });

  /*
   * The agent's pace nets its clawbacks (owner decision 2026-10-06, §6A 45), so a month can come to below zero. The
   * gate counts the months that net money IN, and the mean is floored at zero: never a negative projection.
   */
  test("a NET bucket: a month below zero is not present, and a mean below zero projects $0, never less", () => {
    // $4.00 paid, $3.00 clawed back: +$1.00 a month
    expect(projectOngoingIncome([{ label: "Interest", monthlyTotalsCents: [100, 100, 100] }])[0]).toMatchObject({
      monthlyCents: 100,
      monthsPresent: 3,
    });
    expect(projectOngoingIncome([{ label: "Interest", monthlyTotalsCents: [-100, -100, 400] }])).toEqual([]);
    // present twice, and a September clawback larger than both
    expect(projectOngoingIncome([{ label: "Interest", monthlyTotalsCents: [400, 400, -1000] }])[0]).toMatchObject({
      monthlyCents: 0,
      monthsPresent: 2,
    });
  });

  test("empty input → no components", () => {
    expect(projectOngoingIncome([])).toEqual([]);
  });

  test("the presence threshold is overridable (minMonthsPresent=1 keeps one-offs)", () => {
    const out = projectOngoingIncome(
      [{ label: "Refunds & Reimbursements", monthlyTotalsCents: [0, 0, 300000] }],
      1,
    );
    expect(out.map((e) => e.label)).toEqual(["Refunds & Reimbursements"]);
    expect(MIN_INCOME_MONTHS_PRESENT).toBe(2);
  });
});

/*
 * The agent's pace nets its clawbacks (owner decision 2026-10-06, §6A 45), and a clawback can reach the pace without
 * the credit it reverses — that credit a live schedule's, projected by FIXED. 🔴 `projectOngoingIncome` dropped such a
 * bucket (no month nets money in), so the clawback netted nowhere.
 */
describe("projectOngoingNetIncome — a net bucket that can come to money out", () => {
  const net = (monthlyTotalsCents: number[]) => projectOngoingNetIncome([{ label: "Interest", monthlyTotalsCents }]);

  test("a bucket netting OUT is projected by the same gate and mean, mirrored: below zero", () => {
    // the clawbacks alone: -$3.00 a month, present 3 of 3 as money out
    expect(net([-300, -300, -300])).toEqual([expect.objectContaining({ monthlyCents: -300, monthsPresent: 3 })]);
    expect(net([-300, 0, -300])).toEqual([expect.objectContaining({ monthlyCents: -200, monthsPresent: 2 })]);
  });

  test("a one-off clawback never extrapolates, as a one-off credit never does", () => {
    expect(net([0, 0, -300])).toEqual([]);
    // present twice as money in, and a September clawback larger than both: money out once
    expect(net([400, 400, -1000])).toEqual([]);
  });

  test("a bucket netting money in, or to nothing, is `projectOngoingIncome`'s, unchanged", () => {
    for (const totals of [[100, 100, 100], [0, 200000, 400000], [-100, -100, 400], [400, 400, -800], [0, 0, 0]]) {
      expect(net(totals), totals.join()).toEqual(projectOngoingIncome([{ label: "Interest", monthlyTotalsCents: totals }]));
    }
  });
});
