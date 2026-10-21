import { describe, expect, test } from "vitest";
import {
  incomePaceMeasurable,
  incomePaceNote,
  MIN_INCOME_MONTHS_PRESENT,
  projectOngoingIncome,
  projectOngoingNetIncome,
} from "./income-forecast";

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

/*
 * 🔴 Review of 0795a2a: /recurring's band withheld Money in's pace over 0 months alone, and over one it printed
 * "Recent pace $0.00 (0 lines)" — a $0.00 the gate makes, since no bucket can come in two of one month.
 */
describe("incomePaceMeasurable / incomePaceNote — an income pace needs the gate's months", () => {
  test("a pace over fewer months than the presence gate needs measures nothing; the gate's two do", () => {
    expect([0, 1, 2, 3].map(incomePaceMeasurable)).toEqual([false, false, true, true]);
    // …because over one month no bucket can pass: $3,000.00 of Salary in it is still no ongoing income
    expect(projectOngoingIncome([{ label: "Salary", monthlyTotalsCents: [300000] }])).toEqual([]);
  });

  const gate =
    "Money in has no recent pace yet: a kind of income counts toward it once it has come in 2 complete months, so " +
    "a one-off never does.";

  test("the sentence names the month there is, and is null where the pace has its months", () => {
    expect(incomePaceNote([], null)).toBe(gate);
    expect(incomePaceNote(["2026-07"], null)).toBe(`${gate} Jul 2026 is the only complete month imported so far.`);
    expect(incomePaceNote(["2026-06", "2026-07"], null)).toBeNull();
    expect(incomePaceNote(["2026-05", "2026-06", "2026-07"], null)).toBeNull();
  });

  /*
   * 🔴 Review of a7b1504: on a ledger opening Jul 1 whose Card was read only to Jul 12, at 2026-08-27 the pace row read
   * "… Jul 2026 is left out: Jul 12 is the last day every account you spend from has been imported through. Money in
   * has no recent pace yet: … Jul 2026 is the only complete month imported so far." — July read only to its 12th, then
   * imported whole, one sentence apart. Decision 71 cuts SPENDING's months at that day and not Money in's, so the month
   * is named as Money in's, beside the day that cut spending's (`frontierDay`, the spending sentence's own spelling).
   */
  test("a month spending's frontier left out is named as Money in's, never as imported whole", () => {
    const unread = { months: ["2026-07"], through: "2026-07-12" };
    expect(incomePaceNote(["2026-07"], unread)).toBe(
      `${gate} Jul 12 cuts spending's months, not Money in's, and Jul 2026 is the only complete month Money in has ` +
        "so far.",
    );
    // the day carries its year where the spending sentence's does: a frontier in the stub month before the floor
    expect(incomePaceNote(["2026-01"], { months: ["2026-01"], through: "2025-12-20" })).toContain(
      "Dec 20, 2025 cuts spending's months",
    );
    // a frontier that left out none of Money in's months changes nothing
    expect(incomePaceNote(["2026-07"], { months: ["2026-08"], through: "2026-08-12" })).toBe(
      `${gate} Jul 2026 is the only complete month imported so far.`,
    );
    expect(incomePaceNote(["2026-06", "2026-07"], unread)).toBeNull();
  });
});
