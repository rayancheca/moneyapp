import { describe, expect, test } from "vitest";
import type { BudgetCoverageInput } from "./budget-coverage";
import { budgetCoverageLine, budgetVerdict, type BudgetVerdictInput } from "./budget-verdict";
import { BUDGET_JARGON } from "./jargon";

const verdict = (over: Partial<BudgetVerdictInput> = {}) =>
  budgetVerdict({
    pace: "under",
    pct: 0.2,
    uncoveredDays: 0,
    spentFromAccounts: 1,
    spentFromWallets: 0,
    noDayRead: false,
    txnCount: 1,
    ...over,
  });

/** ⚖️ §6A 64: not one elapsed day of the window read, and not one row found in it — his October, 2026-10-12 */
const UNREAD = { pace: "under", pct: 0, uncoveredDays: 12, noDayRead: true, txnCount: 0 } as const;

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
      expect(v.explanation).toMatch(/the dark mark is how far through the period you are/);
      expect(v.explanation).not.toMatch(/period mark is left off/);
    }
  });

  test("⚖️ a cash-only definition names the mark but does not teach reading pace off it", () => {
    /*
     * The mark is still drawn — the bar is to scale — so the body says what it
     * is. But "fill behind the mark means spending is slower than time" IS a pace
     * reading, and the owner's rule is that a cash-only row makes none; the same
     * body already says no reading of where it is heading is offered.
     */
    expect(verdict(CASH_ONLY).explanation).not.toMatch(/fill behind the mark|slower than time/);
    // ⚖️ …nor, since decision 69, does a window read in part — see its own describe below
    expect(verdict({ uncoveredDays: 3 }).explanation).not.toMatch(/fill behind the mark|slower than time/);
    for (const v of [verdict({ pace: "under" }), verdict({ pace: "at-risk" })]) {
      expect(v.explanation).toMatch(/fill behind the mark means spending is slower than time/);
    }
  });

  test("⚖️ only a reading about where spending is heading may show the projection", () => {
    /*
     * 🔴 A cash-only row printed "Projected ≈ $56.36" in the warning colour beside
     * a definition saying no reading of where it is heading is offered: the row
     * gated the figure on `pace` alone, so the verdict's headline and the figure
     * beside it disagreed — the drift this module exists to prevent.
     */
    for (const pace of ["under", "at-risk"] as const) {
      for (const uncoveredDays of [0, 15]) {
        expect(verdict({ pace, uncoveredDays, ...CASH_ONLY }).showsProjection).toBe(false);
      }
    }
    // an over reading is measured rather than a forecast (paceOver says so) — cash or not
    expect(verdict({ pace: "over", pct: 1.08 }).showsProjection).toBe(false);
    expect(verdict({ pace: "over", pct: 1.3, ...CASH_ONLY }).showsProjection).toBe(false);
    // the two graded readings ARE about where it is heading
    expect(verdict({ pace: "under" }).showsProjection).toBe(true);
    expect(verdict({ pace: "at-risk" }).showsProjection).toBe(true);
    // ⚖️ …and a window read in part makes none either (decision 69, 2026-10-13 — its own describe below)
    expect(verdict({ pace: "at-risk", uncoveredDays: 3 }).showsProjection).toBe(false);
    // a wallet beside an imported account is not cash only
    expect(verdict({ pace: "at-risk", spentFromAccounts: 2, spentFromWallets: 1 }).showsProjection).toBe(true);
  });

  /*
   * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): where NO elapsed day of a budget's window is imported, Spent and Left print
   * "—" and the plan stands — the dashboard's pace tile and the category headline's rule (`lib/empty-period::
   * emptyFigure`). 🔴 Measured on his ledger copy 2026-10-12: all 12 rows read "Spent $0.00 · Left $X" over an October
   * not one day of which any account they are spent from had been imported for (Aug 12 / Sep 2).
   */
  describe("⚖️ §6A 64 — a window not one day of which has been read prints no Spent and no Left", () => {
    test("the figures are withheld under the withheld headline, with a definition of what the row draws", () => {
      const v = verdict(UNREAD);
      expect(v.unread).toBe(true);
      expect(v.headline).toBe("Awaiting statements");
      expect(v.withheld).toBe(true);
      expect(v.barIsFull).toBe(false);
      expect(v.explanation).toBe(BUDGET_JARGON.paceUnread);
      // the body names the mark the row still draws, and no amount or fill the row does not print
      expect(v.explanation).toMatch(/the dark mark is how far through the period you are/);
      expect(v.explanation).not.toMatch(/filled part|floors|percentage/);
    });

    /*
     * 🔴 Review of 6f217a7: the dashed row still printed "Projected ≈" — `projectSpend` over the $0.00 the row will not
     * print, so only the recurring tail and the arrears — in the pace colour, beside a definition saying no reading is
     * offered. On his ledger copy 2026-10-12, 6 of the 12 dashed rows: Housing "Projected ≈ $2,291.21" and Transport
     * "$368.86" in amber (the rent unread, Transport's tail past its $355.64), Car, Health, Subscriptions and Utilities
     * plain. ⚖️ §6A 64 named the dashboard's pace tile, whose dash withholds "$0.00 projected" with "$0.00 spent".
     */
    test("…and says nothing of where spending is heading: no projection, in any pace", () => {
      for (const pace of ["under", "at-risk"] as const) {
        expect(verdict({ ...UNREAD, pace }).showsProjection).toBe(false);
      }
      // the control: a window read whole projects (and since decision 69 a partly read one does not — below)
      expect(verdict({ ...UNREAD, pace: "at-risk", noDayRead: false, uncoveredDays: 0 }).showsProjection).toBe(true);
    });

    test("a partly read window keeps today's lower-bound shape", () => {
      const v = verdict({ ...UNREAD, noDayRead: false });
      expect(v.unread).toBe(false);
      expect(v.headline).toBe("Awaiting statements");
      expect(v.explanation).toBe(BUDGET_JARGON.paceWithheld);
    });

    /*
     * ⛔ The category headline's rule, whole: it prints a dash only over a window holding NO rows. A row is read
     * through the earliest of its accounts' days, so a fresher account's charge can stand in a window that day has not
     * reached — a found row is a floor, never a dash (`CategoryHeadline` prints it above the same card).
     */
    test("a row found in it keeps the figures, as the headline above the card keeps its total", () => {
      const v = verdict({ ...UNREAD, pct: 0.1, txnCount: 1 });
      expect(v.unread).toBe(false);
      expect(v.explanation).toBe(BUDGET_JARGON.paceWithheld);
    });

    test("⚖️ a cash-only row keeps its typed figures — no import will ever read a wallet's day", () => {
      const v = verdict({ ...UNREAD, ...CASH_ONLY });
      expect(v.unread).toBe(false);
      expect(v.headline).toBe("Cash only");
    });

    test("every other state prints its figures", () => {
      for (const v of [
        verdict({ pace: "under" }),
        verdict({ pace: "at-risk" }),
        verdict({ uncoveredDays: 3 }),
        verdict({ pace: "over", pct: 1.08, uncoveredDays: 12 }),
        verdict(CASH_ONLY),
      ]) {
        expect(v.unread).toBe(false);
      }
    });
  });

  /*
   * ⚖️ OWNER DECISION 2026-10-13 (decision 69): a window read in PART — "Awaiting statements" with some day of it read
   * or a row found in it — prints no "Projected ≈" and wears no pace colour, as the fully unread one already does
   * (§6A 64); the bills still to come keep their own "$X expected before <day>" line. 🔴 Its definition said "No
   * reading is offered" beside a projection of floors in the pace colour, and taught "fill behind the mark means
   * spending is slower than time" over days nobody had read — behind the mark because unread, not because slow.
   */
  describe("⚖️ decision 69 — a window read in part says nothing of where spending is heading", () => {
    test("no projection, in any pace, however few days are missing — read day or row found", () => {
      for (const pace of ["under", "at-risk"] as const) {
        for (const uncoveredDays of [1, 15]) {
          for (const read of [{ noDayRead: false, txnCount: 0 }, { noDayRead: true, txnCount: 2 }]) {
            const v = verdict({ pace, pct: 0.4, uncoveredDays, ...read });
            expect(v.headline).toBe("Awaiting statements");
            expect(v.unread).toBe(false);
            expect(v.showsProjection).toBe(false);
          }
        }
      }
      // the control: the same rows read whole are graded, and project
      for (const pace of ["under", "at-risk"] as const) {
        expect(verdict({ pace, pct: 0.4, uncoveredDays: 0 }).showsProjection).toBe(true);
      }
    });

    test("its definition says no reading of where it is heading is offered, and teaches none off the mark", () => {
      const v = verdict({ pace: "at-risk", uncoveredDays: 3 });
      expect(v.explanation).toBe(BUDGET_JARGON.paceWithheld);
      expect(v.explanation).toMatch(/no reading of where it is heading is offered/i);
      expect(v.explanation).not.toMatch(/fill behind the mark|slower than time|where this is heading/);
      // …and still names the two parts the row draws, and what its figures are
      expect(v.explanation).toMatch(/The filled part is what has gone so far/);
      expect(v.explanation).toMatch(/the dark mark is how far through the period you are/);
      expect(v.explanation).toMatch(/floors rather than measurements/);
    });
  });

  test("barIsFull tracks pace, not the sign of what is left", () => {
    // `remaining < 0` is strictly greater than the line; `pace === "over"` turns
    // at >=. They disagree at exactly 100% — where the bar has just filled.
    expect(verdict({ pace: "over", pct: 1 }).barIsFull).toBe(true);
    expect(verdict({ pace: "at-risk", pct: 0.999 }).barIsFull).toBe(false);
  });

  /*
   * ⚖️ default built, not asked (2026-10-29): an over row whose window has days unread keeps its verdict — past the
   * line on partial data is a fact more data cannot undo — and its figures are floors: how FAR past the line can only
   * grow. 🔴 Measured on his ledger copy 2026-10-29: Shopping "Over budget by 23%" ($343.82 of $280.00) over an
   * October its accounts are read through Aug 12 for, its Spent and "Over by" read as measurements beside the four
   * withheld rows whose same 29 days were called floors.
   */
  describe("⚖️ an over row read in part — the verdict stands, its figures are floors", () => {
    test("the headline, its definition and the full bar are the over row's — and its figures are floors", () => {
      const v = verdict({ pace: "over", pct: 343.82 / 280, uncoveredDays: 29, noDayRead: true, txnCount: 8 });
      expect(v.headline).toBe("Over budget by 23%");
      expect(v.explanation).toBe(BUDGET_JARGON.paceOver);
      expect(v.withheld).toBe(false);
      expect(v.barIsFull).toBe(true);
      expect(v.showsProjection).toBe(false);
      expect(v.floors).toBe(true);
    });

    test("read whole, or spent only from cash, an over row's figures are measurements", () => {
      expect(verdict({ pace: "over", pct: 1.08 }).floors).toBe(false);
      // ⚖️ 2026-09-15: cash already past the line is what was recorded, and no statement is coming to add to it
      expect(verdict({ pace: "over", pct: 1.3, uncoveredDays: 15, ...CASH_ONLY }).floors).toBe(false);
    });

    test("a floor is the window's fact, not the verdict's: a withheld row read in part is one too", () => {
      expect(verdict({ uncoveredDays: 3 }).floors).toBe(true);
      expect(verdict({ ...UNREAD, txnCount: 2 }).floors).toBe(true);
      // ⚖️ §6A 64's dash floors nothing; a wallet waits for no statement; a window read whole is measured
      expect(verdict(UNREAD).floors).toBe(false);
      expect(verdict({ uncoveredDays: 15, ...CASH_ONLY }).floors).toBe(false);
      expect(verdict({ pace: "under" }).floors).toBe(false);
      expect(verdict({ pace: "at-risk" }).floors).toBe(false);
    });
  });
});

/*
 * ⛔ One rule for every surface that prints a budget row: /budgets' row and the category page's card print the same line
 * under the same verdict. 🔴 Both printed it only while the verdict was withheld, so an over row read in part printed
 * none (his ledger copy 2026-10-29: Entertainment, Health, Shopping, Subscriptions and Travel, on both surfaces).
 */
describe("budgetCoverageLine — the line a budget row prints under its headline", () => {
  /** a row read through Aug 12, graded over October — ten of his twelve budgets on his ledger copy 2026-10-29 */
  type Row = BudgetVerdictInput & BudgetCoverageInput;
  const row = (over: Partial<Row> = {}): Row => ({
    pace: "under",
    pct: 0.4,
    uncoveredDays: 29,
    spentFromAccounts: 2,
    spentFromWallets: 0,
    noDayRead: true,
    txnCount: 8,
    importedThroughOn: "2026-08-12",
    spentFromSince: "2026-04-01",
    bounds: { start: "2026-10-01" },
    ...over,
  });
  const LINE = "spending imported through Aug 12 · 29 days of this period unaccounted";

  test("a withheld row prints its coverage sentence, and so does an over row read in part", () => {
    expect(budgetCoverageLine(row())).toBe(LINE);
    expect(budgetCoverageLine(row({ pace: "over", pct: 343.82 / 280 }))).toBe(LINE);
    // §6A 64's dash and a cash-only row keep the lines they print today
    expect(budgetCoverageLine(row({ txnCount: 0 }))).toBe(LINE);
    expect(budgetCoverageLine(row({ spentFromAccounts: 0, spentFromWallets: 1, importedThroughOn: null }))).toBe(
      "spent only from a cash wallet since Apr 1 — no statement will ever cover it",
    );
  });

  test("a graded row, an over row read whole, and cash already past the line print none", () => {
    const cash = { spentFromAccounts: 0, spentFromWallets: 1, importedThroughOn: null };
    expect(budgetCoverageLine(row({ uncoveredDays: 0, noDayRead: false }))).toBeNull();
    expect(budgetCoverageLine(row({ pace: "over", pct: 1.08, uncoveredDays: 0, noDayRead: false }))).toBeNull();
    expect(budgetCoverageLine(row({ pace: "over", pct: 1.3, ...cash }))).toBeNull();
  });
});
