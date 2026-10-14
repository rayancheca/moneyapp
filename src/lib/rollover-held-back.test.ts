import { describe, expect, test } from "vitest";
import { ROLLOVER_WAITS, rolloverHeldBackSentence } from "./rollover-held-back";

/*
 * ⚖️ Decision 67 (2026-10-13): a closed period not read whole banks nothing until its statements land. The panel names
 * what it held back, in the words of the period it is — 🔴 on his ledger copy 2026-10-12 every rolling budget banked
 * from a September no statement had confirmed, and nothing on the panel said so.
 */
describe("rolloverHeldBackSentence — what a rolling budget is waiting on", () => {
  const SEPTEMBER = { start: "2026-09-01", end: "2026-09-30" };

  test("nothing held back says nothing", () => {
    expect(rolloverHeldBackSentence([], "monthly", "2026-10-01")).toBeNull();
  });

  test("his September, by its name", () => {
    expect(rolloverHeldBackSentence([SEPTEMBER], "monthly", "2026-10-01")).toBe(
      "September 2026 is not fully imported, so nothing rolls over from it yet.",
    );
  });

  test("two months are named both, and are 'them'", () => {
    const august = { start: "2026-08-01", end: "2026-08-31" };
    expect(rolloverHeldBackSentence([august, SEPTEMBER], "monthly", "2026-10-01")).toBe(
      "August 2026 and September 2026 are not fully imported, so nothing rolls over from them yet.",
    );
  });

  test("more are counted between the first and the last", () => {
    const held = ["07", "08", "09"].map((m) => ({ start: `2026-${m}-01`, end: `2026-${m}-28` }));
    expect(rolloverHeldBackSentence(held, "monthly", "2026-10-01")).toBe(
      "3 months, July 2026 to September 2026, are not fully imported, so nothing rolls over from them yet.",
    );
  });

  test("a week is the week of its first day, and a day from another year says its year", () => {
    expect(rolloverHeldBackSentence([{ start: "2026-09-28", end: "2026-10-04" }], "weekly", "2026-10-05")).toBe(
      "The week of Sep 28 is not fully imported, so nothing rolls over from it yet.",
    );
    expect(rolloverHeldBackSentence([{ start: "2025-12-29", end: "2026-01-04" }], "weekly", "2026-01-05")).toBe(
      "The week of Dec 29, 2025 is not fully imported, so nothing rolls over from it yet.",
    );
  });

  test("days are spanned, and a year is its number", () => {
    const days = ["10", "11", "12", "13"].map((d) => ({ start: `2026-10-${d}`, end: `2026-10-${d}` }));
    expect(rolloverHeldBackSentence(days, "daily", "2026-10-14")).toBe(
      "4 days, Oct 10 – Oct 13, are not fully imported, so nothing rolls over from them yet.",
    );
    expect(rolloverHeldBackSentence([{ start: "2025-01-01", end: "2025-12-31" }], "annual", "2026-01-01")).toBe(
      "2025 is not fully imported, so nothing rolls over from it yet.",
    );
  });

  /*
   * 🔴 "…, so a missing statement cannot bank itself as savings" was flat, and the rule it stands on has a documented
   * gap (`services/budgets::categoryCoverage`): a period is read on the accounts the category has lately been spent
   * from, so a statement missing on an account it has never been spent from is not waited for (review of 73a743d).
   * The sentence says the rule's own reach, and no further — `budgets.test.ts` pins the gap it leaves.
   */
  test("the rule it stands on is said once, and says why — no further than the rule reaches", () => {
    expect(ROLLOVER_WAITS).toBe(
      "A period adds nothing until the accounts this category has lately been spent from are imported through its " +
        "last day, so a missing statement on one of them cannot bank itself as savings.",
    );
  });
});
