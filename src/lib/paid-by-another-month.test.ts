import { describe, expect, test } from "vitest";
import { RESERVED_JARGON_PHRASES } from "./jargon";
import { paidByAnotherMonthNote } from "./paid-by-another-month";

const OCTOBER = "2026-10-01";
const WEEK = 114_192;

/**
 * The fourth figure on /budgets' "This month" card, in words.
 *
 * ⚖️ His answer to §6A 29: a payday paid by money that landed in another month
 * gets a figure of its own beside "in so far / still expected / already passed"
 * — "$1,141.92 paid early, in September" — so the four add up to what the month
 * note says the month is scheduled to pay. Read on Fri 2026-10-02 with his
 * Thursday Oct 1 paid by the deposit of Wed Sep 30, the header's three figures
 * came to $4,567.68 against $5,709.60 scheduled, and nothing named the rest.
 */
describe("paidByAnotherMonthNote — the fourth figure, in words", () => {
  test("says nothing when no payday this month was paid by another month's money", () => {
    expect(paidByAnotherMonthNote({ cents: 0, occurrences: 0, deposits: [] }, OCTOBER)).toBeNull();
  });

  test("his Oct 1: names the money, the deposit that paid it, and why neither figure holds it", () => {
    expect(paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-30"] }, OCTOBER)).toBe(
      "1 payday worth $1,141.92 was paid early, by the deposit of Wed, Sep 30, 2026 — money that landed before this month began, so it is counted in neither figure above.",
    );
  });

  test("several paydays are counted, and every deposit that paid one is named", () => {
    expect(
      paidByAnotherMonthNote({ cents: WEEK * 2, occurrences: 2, deposits: ["2026-09-29", "2026-09-30"] }, OCTOBER),
    ).toBe(
      "2 paydays worth $2,283.84 were paid early, by the deposits of Tue, Sep 29, 2026 and Wed, Sep 30, 2026 — money that landed before this month began, so they are counted in neither figure above.",
    );
  });

  /* ⛔ "Early" is a claim about WHEN the money landed, and it is only true of a
     deposit before the month. One dated after it can pay the month's paydays
     only once the month is over — August's Aug 27, paid by the deposit of Sep 24
     — and those words must not call it early. */
  test("money that landed after the month began is not called early", () => {
    expect(paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-24"] }, "2026-08-01")).toBe(
      "1 payday worth $1,141.92 was paid by the deposit of Thu, Sep 24, 2026 — money that landed in another month, so it is counted in neither figure above.",
    );
  });

  /* The note renders on /budgets, where exact-count locators read the page's
     graded phrases; repeating one would turn an unrelated spec red. */
  test("never repeats a phrase the page it prints on grades by", () => {
    const notes = [
      paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-30"] }, OCTOBER),
      paidByAnotherMonthNote({ cents: WEEK * 2, occurrences: 2, deposits: ["2026-09-29", "2026-09-30"] }, OCTOBER),
      paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-24"] }, "2026-08-01"),
    ];
    for (const note of notes) {
      for (const phrase of RESERVED_JARGON_PHRASES) expect(note, phrase).not.toContain(phrase);
    }
  });
});
