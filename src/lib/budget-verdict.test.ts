import { describe, expect, test } from "vitest";
import { budgetVerdict, type BudgetVerdictInput } from "./budget-verdict";
import { BUDGET_JARGON } from "./jargon";

const verdict = (over: Partial<BudgetVerdictInput> = {}) =>
  budgetVerdict({ pace: "under", pct: 0.2, uncoveredDays: 0, spentFromAccounts: 1, spentFromWallets: 0, ...over });

/** spent from a cash wallet in the window, and from no other account */
const CASH_ONLY = { spentFromAccounts: 0, spentFromWallets: 1 } as const;

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

  test("⚖️ a category spent only from cash wallets says so and makes no pace claim, whatever the day count", () => {
    /*
     * Owner, 2026-09-15: budgets leave cash wallets out of the imported-through
     * day. A category spent from nothing else has typed rows only, and no import
     * will ever show what they miss — so "Awaiting statements" would promise a
     * statement that never arrives, and a graded reading would treat the typed
     * rows as all of it.
     */
    for (const pace of ["under", "at-risk"] as const) {
      for (const uncoveredDays of [0, 15]) {
        const v = verdict({ pace, pct: 0.4, uncoveredDays, ...CASH_ONLY });
        expect(v.headline).toBe("Cash only");
        expect(v.withheld).toBe(true);
        expect(v.barIsFull).toBe(false);
        expect(v.explanation).not.toMatch(/On track|Off pace|Awaiting statements/);
      }
    }
  });

  test("cash already past the line still reads over — recorded spending is a fact no import can undo", () => {
    const v = verdict({ pace: "over", pct: 1.3, uncoveredDays: 15, ...CASH_ONLY });
    expect(v.headline).toBe("Over budget by 30%");
    expect(v.withheld).toBe(false);
    expect(v.barIsFull).toBe(true);
  });

  test("a wallet beside an imported account changes nothing about the reading", () => {
    // Car on the real ledger 2026-09-15: Cash on Hand beside Chase Checking and Venture X
    expect(verdict({ pace: "under", pct: 0.21, spentFromAccounts: 2, spentFromWallets: 1 }).headline).toBe(
      "On track · 21% used",
    );
    expect(verdict({ uncoveredDays: 15, spentFromAccounts: 2, spentFromWallets: 1 }).headline).toBe(
      "Awaiting statements",
    );
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
    expect(verdict(CASH_ONLY).explanation).toBe(BUDGET_JARGON.paceCashOnly);
  });

  test("only the full bar drops the today mark, and only it says so", () => {
    /*
     * The pairing that already went wrong once: the mark is not drawn when the
     * fill covers the track, so exactly one body may describe a missing mark and
     * the other four must describe a present one.
     */
    const full = verdict({ pace: "over", pct: 1.08 });
    expect(full.barIsFull).toBe(true);
    expect(full.explanation).toMatch(/period mark is left off/);
    expect(full.explanation).not.toMatch(/fill behind the mark/);

    for (const v of [
      verdict({ pace: "under" }),
      verdict({ pace: "at-risk" }),
      verdict({ uncoveredDays: 3 }),
      verdict(CASH_ONLY),
    ]) {
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
