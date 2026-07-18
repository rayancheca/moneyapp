import { describe, expect, test } from "vitest";
import { MIN_INCOME_MONTHS_PRESENT, projectOngoingIncome } from "./income-forecast";

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
