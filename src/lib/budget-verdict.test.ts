import { describe, expect, test } from "vitest";
import { budgetVerdict, type BudgetVerdictInput } from "./budget-verdict";
import { BUDGET_JARGON } from "./jargon";

const verdict = (over: Partial<BudgetVerdictInput> = {}) =>
  budgetVerdict({ pace: "under", pct: 0.2, uncoveredDays: 0, ...over });

describe("budgetVerdict", () => {
  test("states the overshoot as a distance past the line, not as a total", () => {
    // 108% of a budget is "over BY 8%" — "over budget · 108%" reads as 108% over
    expect(verdict({ pace: "over", pct: 1.08 }).headline).toBe("Over budget by 8%");
  });

  test("never rounds a real overshoot down to nothing", () => {
    // 100.4% rounds to 0, and "Over budget by 0%" claims the line was met exactly
    expect(verdict({ pace: "over", pct: 1.004 }).headline).toBe("Over budget by <1%");
    // and exactly on the line is still an overshoot of less than one percent,
    // never "by 0%" — `computePace` turns over at spent >= available
    expect(verdict({ pace: "over", pct: 1 }).headline).toBe("Over budget by <1%");
  });

  test("an over row is exempt from the coverage gate — spent money is a fact", () => {
    // more data cannot un-spend it, so the verdict stands even with the window
    // half-imported. This is the ONE state that speaks over an incomplete ledger.
    const v = verdict({ pace: "over", pct: 1.08, uncoveredDays: 11 });
    expect(v.headline).toBe("Over budget by 8%");
    expect(v.withheld).toBe(false);
    expect(v.barIsFull).toBe(true);
  });

  test("withholds the verdict wherever the ledger has not covered the window", () => {
    for (const pace of ["under", "at-risk"] as const) {
      const v = verdict({ pace, uncoveredDays: 1 });
      expect(v.headline).toBe("Awaiting statements");
      expect(v.withheld).toBe(true);
      expect(v.barIsFull).toBe(false);
      // a withheld row must not leak the reading it declined to give
      expect(v.explanation).not.toMatch(/On track|Off pace/);
    }
  });

  test("states the two covered verdicts with their percentage used", () => {
    expect(verdict({ pace: "under", pct: 0.21 }).headline).toBe("On track · 21% used");
    expect(verdict({ pace: "at-risk", pct: 0.39 }).headline).toBe("Off pace · 39% used");
  });

  test("each state carries the definition of THAT state and no other", () => {
    // the drift this module exists to prevent: headline and explanation are
    // chosen by one branch, so a wrong pairing is unrepresentable
    expect(verdict({ pace: "under" }).explanation).toBe(BUDGET_JARGON.paceUnder);
    expect(verdict({ pace: "at-risk" }).explanation).toBe(BUDGET_JARGON.paceAtRisk);
    expect(verdict({ pace: "over", pct: 1.5 }).explanation).toBe(BUDGET_JARGON.paceOver);
    expect(verdict({ uncoveredDays: 3 }).explanation).toBe(BUDGET_JARGON.paceWithheld);
  });

  test("only the full bar drops the today mark, and only it says so", () => {
    /*
     * The pairing that already went wrong once: the mark is not drawn when the
     * fill covers the track, so exactly one body may describe a missing mark and
     * the other three must describe a present one.
     */
    const full = verdict({ pace: "over", pct: 1.08 });
    expect(full.barIsFull).toBe(true);
    expect(full.explanation).toMatch(/period mark is left off/);
    expect(full.explanation).not.toMatch(/fill behind the mark/);

    for (const v of [verdict({ pace: "under" }), verdict({ pace: "at-risk" }), verdict({ uncoveredDays: 3 })]) {
      expect(v.barIsFull).toBe(false);
      expect(v.explanation).toMatch(/fill behind the mark/);
      expect(v.explanation).not.toMatch(/period mark is left off/);
    }
  });

  test("barIsFull tracks pace, not the sign of what is left", () => {
    // `remaining < 0` is strictly greater than the line; `pace === "over"` turns
    // at >=. They disagree at exactly 100% — where the bar has just filled.
    expect(verdict({ pace: "over", pct: 1 }).barIsFull).toBe(true);
    expect(verdict({ pace: "at-risk", pct: 0.999 }).barIsFull).toBe(false);
  });
});
