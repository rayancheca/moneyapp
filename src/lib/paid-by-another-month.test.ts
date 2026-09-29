import { describe, expect, test } from "vitest";
import { RESERVED_JARGON_PHRASES } from "./jargon";
import { paidByAnotherMonthNote, paidForAnotherMonthNote } from "./paid-by-another-month";

const OCTOBER = "2026-10-01";
const WEEK = 114_192;

/**
 * The fourth figure on /budgets' "This month" card, in words.
 *
 * ⚖️ His answer to §6A 29: a payday paid by money that landed in another month
 * gets a figure of its own beside "in so far / still expected / already passed"
 * — "$1,141.92 paid early, in September" — so the month adds up to what the
 * month note says it is scheduled to pay. Read on Fri 2026-10-02 with his
 * Thursday Oct 1 paid by the deposit of Wed Sep 30, the header's three figures
 * came to $4,567.68 against $5,709.60 scheduled, and nothing named the rest.
 */
describe("paidByAnotherMonthNote — the fourth figure, in words", () => {
  test("says nothing when no payday this month was paid by another month's money", () => {
    expect(paidByAnotherMonthNote({ cents: 0, occurrences: 0, deposits: [] }, OCTOBER)).toBeNull();
  });

  test("his Oct 1: names the money, the deposit that paid it, and why neither figure holds it", () => {
    expect(paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-30"] }, OCTOBER)).toBe(
      "$1,141.92 toward 1 payday this month was paid early, by the deposit of Wed, Sep 30, 2026 — money that landed before this month began, so it is counted in neither figure above.",
    );
  });

  /* 🔴 The figure is the MONEY in the row it names. It said "1 payday worth
     $1,141.92 was paid early, by the deposit of Wed, Sep 30" of a row holding
     $1,100.00 — a claim the reader could check, and find false. */
  test("a short deposit is named at the money it carried, not the payday's worth", () => {
    const note = paidByAnotherMonthNote({ cents: 110_000, occurrences: 1, deposits: ["2026-09-30"] }, OCTOBER);
    expect(note).toContain("$1,100.00 toward 1 payday");
    expect(note).not.toContain("$1,141.92");
    expect(note).not.toContain("worth");
  });

  test("several paydays are counted, and every deposit that paid one is named", () => {
    expect(
      paidByAnotherMonthNote({ cents: WEEK * 2, occurrences: 2, deposits: ["2026-09-29", "2026-09-30"] }, OCTOBER),
    ).toBe(
      "$2,283.84 toward 2 paydays this month was paid early, by the deposits of Tue, Sep 29, 2026 and Wed, Sep 30, 2026 — money that landed before this month began, so it is counted in neither figure above.",
    );
  });

  /* ⛔ "Early" is a claim about WHEN the money landed, and it is only true of a
     deposit before the month. One dated after it can pay the month's paydays
     only once the month is over — August's Aug 27, paid by the deposit of Sep 24
     — and those words must not call it early. */
  test("money that landed after the month began is not called early", () => {
    expect(paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-24"] }, "2026-08-01")).toBe(
      "$1,141.92 toward 1 payday this month was paid by the deposit of Thu, Sep 24, 2026 — money that landed in another month, so it is counted in neither figure above.",
    );
  });
});

/**
 * The other half: money in "in so far" that settlement spent on ANOTHER month's
 * payday. Read Fri 2026-10-02 with Wed Sep 30's lump paying Oct 1 and Thu Oct 1's
 * deposit paying Aug 27, the header printed "$1,141.92 in so far" and the fourth
 * figure's $1,141.92 on top — a week over the five paydays October schedules —
 * and nothing said the week in so far was August's.
 */
describe("paidForAnotherMonthNote — money in so far that went to another month", () => {
  test("says nothing when all of it went to this month's paydays", () => {
    expect(paidForAnotherMonthNote({ cents: 0, deposits: [], paydays: [] })).toBeNull();
  });

  test("names the money, the deposit it came from and the payday it went to", () => {
    expect(paidForAnotherMonthNote({ cents: WEEK, deposits: ["2026-10-01"], paydays: ["2026-08-27"] })).toBe(
      "$1,141.92 of the money in so far, from the deposit of Thu, Oct 1, 2026, went toward 1 payday outside this month (Thu, Aug 27, 2026) — so it is in the figure above but pays none of this month's paydays.",
    );
  });

  test("several deposits and paydays are each named", () => {
    expect(
      paidForAnotherMonthNote({
        cents: WEEK * 2,
        deposits: ["2026-10-01", "2026-10-08"],
        paydays: ["2026-08-20", "2026-08-27"],
      }),
    ).toBe(
      "$2,283.84 of the money in so far, from the deposits of Thu, Oct 1, 2026 and Thu, Oct 8, 2026, went toward 2 paydays outside this month (Thu, Aug 20, 2026 and Thu, Aug 27, 2026) — so it is in the figure above but pays none of this month's paydays.",
    );
  });
});

/* The notes render on /budgets, where exact-count locators read the page's
   graded phrases; repeating one would turn an unrelated spec red. */
test("neither note repeats a phrase the page it prints on grades by", () => {
  const notes = [
    paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-30"] }, OCTOBER),
    paidByAnotherMonthNote({ cents: WEEK * 2, occurrences: 2, deposits: ["2026-09-29", "2026-09-30"] }, OCTOBER),
    paidByAnotherMonthNote({ cents: WEEK, occurrences: 1, deposits: ["2026-09-24"] }, "2026-08-01"),
    paidForAnotherMonthNote({ cents: WEEK, deposits: ["2026-10-01"], paydays: ["2026-08-27"] }),
    paidForAnotherMonthNote({ cents: WEEK * 2, deposits: ["2026-10-01", "2026-10-08"], paydays: ["2026-08-20", "2026-08-27"] }),
  ];
  for (const note of notes) {
    expect(note).not.toBeNull();
    for (const phrase of RESERVED_JARGON_PHRASES) expect(note, phrase).not.toContain(phrase);
  }
});
