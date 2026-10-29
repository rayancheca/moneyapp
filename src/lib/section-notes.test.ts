import { describe, expect, test } from "vitest";
import { TAXONOMY } from "@/db/seed";
import { FORBIDDEN_NAME_CHARS } from "@/services/category-edit";
import {
  budgetSectionNotes,
  cashEarningsSectionNotes,
  categoryCountLabel,
  categoryNoteRows,
  type CashEarningsNoteInput,
  categorySectionNotes,
  holdingPriceSectionNotes,
  NAME_LIST_SEPARATOR,
  RESERVED_NOTE_PHRASES,
  type SectionNote,
} from "./section-notes";
import { PATH_SEPARATOR } from "./category-path";
import type { PayShortfall } from "./pay-shortfall";
import { ACCOUNT_NOT_READ, ACCOUNT_READ } from "./unbanked-income";

const row = (over: Partial<Parameters<typeof budgetSectionNotes>[0]["rows"][number]> = {}) => ({
  categoryPath: "Food",
  overdueCents: 0,
  overdueBills: 0,
  uncoveredDays: 0,
  pace: "under" as const,
  spentFromAccounts: 1,
  spentFromWallets: 0,
  noDayRead: false,
  txnCount: 1,
  rolloverMayAddCents: 0,
  ...over,
  // unread unless a test says otherwise — his ledger's arrears 2026-10-08, on days no checked statement had reached
  overdueUnreadCents: over.overdueUnreadCents ?? over.overdueCents ?? 0,
  // …and a statement is what that waits for, unless a test says its days to post are
  overdueInGraceCents: over.overdueInGraceCents ?? 0,
});

describe("budgetSectionNotes", () => {
  test("says nothing when there is nothing measured to say", () => {
    expect(budgetSectionNotes({ rows: [row(), row({ categoryPath: "Housing" })] })).toEqual([]);
  });

  test("emits nothing at all for an empty page rather than a zero", () => {
    // the failure this guards: "0 bills came due" reads as a measurement when it
    // is really the absence of one
    expect(budgetSectionNotes({ rows: [] })).toEqual([]);
  });

  test("totals overdue bills across rows and names them", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Housing", overdueCents: 228_570, overdueBills: 1 }),
        row({ categoryPath: "Subscriptions", overdueCents: 499, overdueBills: 1 }),
        row({ categoryPath: "Food" }),
      ],
    });
    const overdue = notes.find((n) => n.id === "budgets-overdue")!;
    expect(overdue.body).toContain("2 bills");
    expect(overdue.body).toContain("$2,290.69");
    expect(overdue.body).toContain("Housing, Subscriptions");
    // two bills across two budgets: the counts already agree, so the sentence
    // does not repeat itself — the clause exists to resolve a mismatch, and
    // saying "2 budgets" here would be noise the reader has to reconcile
    expect(overdue.body).not.toContain("budgets:");
  });

  test("reads singular for one overdue bill", () => {
    const notes = budgetSectionNotes({ rows: [row({ overdueCents: 1_000, overdueBills: 1 })] });
    expect(notes[0]!.body).toContain("One bill");
    expect(notes[0]!.body).toContain("it yet");
  });

  /*
   * 🔴 The count was the number of BUDGET ROWS and the noun was "bill".
   *
   * Measured on the owner's real ledger at today = 2026-09-16, the page read
   * "4 bills totalling $3,467.60" over EIGHT overdue bills — Car held two, so
   * did Housing, Subscriptions and Utilities. At today = 2026-09-01 it read
   * "One bill totalling $2,291.21" over rent AND rent utilities & fees.
   *
   * ⛔ The type could not express the condition: `BudgetNoteInput` carried no
   * bill count, so no fixture over it could tell one bill from four in a row.
   * This module's own header names the same failure in a sibling sentence —
   * "2 categories hold no transactions: Food, Drink, Pets" says two, lists
   * three. Here the count agreed with the LIST and disagreed with the NOUN.
   */
  test("counts BILLS, not the budgets they are spread across", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Car", overdueCents: 105_653, overdueBills: 2 }),
        row({ categoryPath: "Housing", overdueCents: 229_121, overdueBills: 2 }),
        row({ categoryPath: "Subscriptions", overdueCents: 1_099, overdueBills: 2 }),
        row({ categoryPath: "Utilities", overdueCents: 10_887, overdueBills: 2 }),
      ],
    });
    const overdue = notes.find((n) => n.id === "budgets-overdue")!;
    expect(overdue.body).toContain("8 bills");
    expect(overdue.body).not.toContain("4 bills");
    expect(overdue.body).toContain("$3,467.60");
    // and the budget count is stated too, so the four names are not read as
    // four bills — the list length always equals the number said beside it
    expect(overdue.body).toContain("4 budgets");
    expect(overdue.body).toContain("Car, Housing, Subscriptions, Utilities");
  });

  test("two bills in ONE budget still name one budget", () => {
    const notes = budgetSectionNotes({
      rows: [row({ categoryPath: "Housing", overdueCents: 229_121, overdueBills: 2 })],
    });
    const body = notes.find((n) => n.id === "budgets-overdue")!.body;
    expect(body).toContain("2 bills");
    expect(body).toContain("1 budget");
    expect(body).not.toContain("1 budgets");
    expect(body).toContain("Housing");
    // the pronoun follows the BILLS, not the rows — one row, two bills
    expect(body).toContain("them yet");
  });

  /*
   * 🔴 "no import has covered them yet" OF DAYS AN IMPORT HAD COVERED. The note said it of every overdue bill, read or
   * not — the reverse of the row beside it, which said "not imported" of both (review of a132c57, 2026-10-08). ⛔ The
   * rows' split, summed the way the total is: "not posted" only of what the ledger has read, both halves by amount
   * for a mix — the runway's voice.
   */
  test("says \"not posted\" only of what the ledger has read, and both halves of a mix", () => {
    const body = (overdueUnreadCents: number) =>
      budgetSectionNotes({
        rows: [row({ categoryPath: "Housing", overdueCents: 229_121, overdueUnreadCents, overdueBills: 2 })],
      }).find((n) => n.id === "budgets-overdue")!.body;
    expect(body(0)).toBe(
      "2 bills totalling $2,291.21 due by today and not posted — 1 budget: Housing. That money is committed, so the " +
        "room left is smaller than it looks.",
    );
    expect(body(18_221)).toBe(
      "2 bills totalling $2,291.21 due by today: $2,109.00 not posted, and no statement has covered the other $182.21 " +
        "yet — 1 budget: Housing. That money is committed, so the room left is smaller than it looks.",
    );
    expect(body(229_121)).toBe(
      "2 bills totalling $2,291.21 due by today and no statement has covered them yet — 1 budget: Housing. That money " +
        "is committed, so the room left is smaller than it looks.",
    );
  });

  test("the split is summed across rows, as the total is", () => {
    const body = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Housing", overdueCents: 229_121, overdueUnreadCents: 229_121, overdueBills: 2 }),
        row({ categoryPath: "Utilities", overdueCents: 10_887, overdueUnreadCents: 0, overdueBills: 2 }),
      ],
    }).find((n) => n.id === "budgets-overdue")!.body;
    expect(body).toContain("$2,400.08 due by today: $108.87 not posted, and no statement has covered the other $2,291.21 yet");
  });

  /*
   * ⚖️ §6A 64: a row not one elapsed day of whose window is read prints "Left —" — there is no room left on it to look
   * smaller than it is. 🔴 On his ledger copy 2026-10-13 the note read "That money is committed, so the room left is
   * smaller than it looks." over Housing and Utilities, both printing "Left —" (review of 6f217a7). The rows' own test
   * (`spendUnread`): over rows that print no "left" the money is said to come out of the plan they do print.
   */
  test("over rows that print \"Left —\", the money comes out of their plans — no room left is spoken of", () => {
    const body = (rows: Parameters<typeof row>[0][]) =>
      budgetSectionNotes({ rows: rows.map(row) }).find((n) => n.id === "budgets-overdue")!.body;
    const unread = { noDayRead: true, txnCount: 0, uncoveredDays: 13 };
    const housing = { categoryPath: "Housing", overdueCents: 229_121, overdueBills: 2 };
    const utilities = { categoryPath: "Utilities", overdueCents: 10_887, overdueBills: 2 };
    expect(body([{ ...housing, ...unread }, { ...utilities, ...unread }])).toBe(
      "4 bills totalling $2,400.08 due by today and no statement has covered them yet — 2 budgets: Housing, " +
        "Utilities. That money is committed out of their plans.",
    );
    expect(body([{ ...housing, ...unread }])).toMatch(/— 1 budget: Housing\. That money is committed out of its plan\.$/);
    // one row prints what is left, one does not: the room left is spoken of where it is shown
    expect(body([{ ...housing, ...unread }, utilities])).toMatch(
      /Utilities\. That money is committed, so the room left is smaller than it looks where it is shown\.$/,
    );
    // ⚖️ a row with a row found in it keeps its figures as floors (§6A 64), and its "left" with them
    expect(body([{ ...housing, ...unread, txnCount: 1 }])).toMatch(/so the room left is smaller than it looks\.$/);
  });

  /*
   * 🔴 …and "no import has covered them yet" of bills on accounts read through today — an archived card, a cash wallet
   * — whose days to post are not over (review of the 2026-10-08 batch): no import will ever come. Summed as the rest.
   */
  test("bills waiting only for their days to post say so — summed across rows, as the total is", () => {
    const body = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Housing", overdueCents: 229_121, overdueInGraceCents: 229_121, overdueBills: 2 }),
        row({ categoryPath: "Storage", overdueCents: 4_500, overdueInGraceCents: 4_500, overdueBills: 1 }),
      ],
    }).find((n) => n.id === "budgets-overdue")!.body;
    // 🔴 of three bills it said "the days a payment has to post" (review of 384917c) — "them", as its statement words do
    expect(body).toContain(
      "3 bills totalling $2,336.21 due by today and the days their payments have to post are not over yet — 2 budgets:",
    );
  });

  test("counts under-measured rows, exempting `over` the same way the row does", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Food", uncoveredDays: 11 }),
        row({ categoryPath: "Travel", uncoveredDays: 4 }),
        // already over: a fact more data cannot undo, so it is NOT under-measured
        row({ categoryPath: "Housing", uncoveredDays: 30, pace: "over" }),
      ],
    });
    const coverage = notes.find((n) => n.id === "budgets-coverage")!;
    expect(coverage.body).toContain("2 of 3 budgets");
    // the worst gap is reported from the rows that actually qualify, not from the
    // exempt one — 11 on Food, never 30 on Housing
    expect(coverage.body).toContain("11 days on Food");
    expect(coverage.body).not.toContain("Housing");
  });

  /*
   * ⚖️ OWNER DECISION, 2026-09-15: budgets leave cash wallets out of the
   * imported-through day. A budget spent only from wallets has no import date and
   * no statement will ever bring one — its row says so ("Cash only"). This note
   * says the ledger has not REACHED some days yet, which for that row is true of
   * no day, so it must not count it.
   */
  test("a budget spent only from cash wallets is not counted as grading days the ledger has not reached", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Car", uncoveredDays: 15, spentFromAccounts: 0, spentFromWallets: 1 }),
        row({ categoryPath: "Food", uncoveredDays: 11 }),
      ],
    });
    const body = notes.find((n) => n.id === "budgets-coverage")!.body;
    expect(body).toContain("1 of 2 budgets");
    expect(body).toContain("11 days on Food");
    expect(body).not.toContain("Car");
  });

  test("a page whose only unread budget is spent from cash wallets carries no coverage note", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Car", uncoveredDays: 15, spentFromAccounts: 0, spentFromWallets: 1 }),
        row({ categoryPath: "Food" }),
      ],
    });
    expect(notes.find((n) => n.id === "budgets-coverage")).toBeUndefined();
  });

  test("a wallet beside an imported account leaves the budget counted", () => {
    // Car on the real ledger 2026-09-15: still waiting on Chase Checking
    const notes = budgetSectionNotes({
      rows: [row({ categoryPath: "Car", uncoveredDays: 15, spentFromAccounts: 2, spentFromWallets: 1 })],
    });
    expect(notes.find((n) => n.id === "budgets-coverage")!.body).toContain("15 days on Car");
  });

  /*
   * ❓ OWNER DECISION, 2026-09-04. `/budgets` read "12 of 12 budgets are grading
   * days the ledger has not reached — up to 4 days on Car." Every one of the
   * twelve was at 4 (Sep 1–4 elapsed, none imported), and `reduce` with a
   * strict `>` simply kept the first alphabetically — so naming Car implied it
   * was distinctive when nothing distinguished it. Asked as a concrete
   * either/or, he chose: DROP THE NAME WHEN THEY ALL TIE.
   */
  test("names no budget when every one of them is at the same gap", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Car", uncoveredDays: 4 }),
        row({ categoryPath: "Food", uncoveredDays: 4 }),
        row({ categoryPath: "Travel", uncoveredDays: 4 }),
      ],
    });
    const body = notes.find((n) => n.id === "budgets-coverage")!.body;
    expect(body).toContain("3 of 3 budgets");
    expect(body).toContain("4 days each");
    expect(body).not.toContain("Car");
    expect(body).not.toContain("up to");
  });

  test("a single under-measured budget is not a tie — it is named", () => {
    const notes = budgetSectionNotes({ rows: [row({ categoryPath: "Car", uncoveredDays: 4 })] });
    expect(notes.find((n) => n.id === "budgets-coverage")!.body).toContain("4 days on Car");
  });

  test("one budget genuinely ahead of the rest is still named", () => {
    const notes = budgetSectionNotes({
      rows: [row({ categoryPath: "Car", uncoveredDays: 4 }), row({ categoryPath: "Food", uncoveredDays: 11 })],
    });
    expect(notes.find((n) => n.id === "budgets-coverage")!.body).toContain("11 days on Food");
  });

  /*
   * ❓ PINNED, NOT DECIDED. The 2026-09-04 decision was asked about the all-tie
   * case only. When rows SHARE the worst gap and another sits lower, the note
   * names the first of them — measured 2026-09-15, "up to 15 days on Car" over
   * rows tied at 15 with Travel at 13. Whether a shared lead should drop the
   * name too is his call; changing it flips this test on purpose.
   */
  test("a partial tie at the worst gap still names the first row that holds it", () => {
    const notes = budgetSectionNotes({
      rows: [
        row({ categoryPath: "Car", uncoveredDays: 15 }),
        row({ categoryPath: "Food", uncoveredDays: 15 }),
        row({ categoryPath: "Travel", uncoveredDays: 13 }),
      ],
    });
    const body = notes.find((n) => n.id === "budgets-coverage")!.body;
    expect(body).toContain("3 of 3 budgets");
    expect(body).toContain("up to 15 days on Car");
    expect(body).not.toContain("days each");
  });

  test("reports the worst gap even when it is not the first row", () => {
    // the existing case has the worst gap first, so the reduce only ever kept its
    // accumulator — this exercises the arm that replaces it
    const notes = budgetSectionNotes({
      rows: [row({ categoryPath: "Travel", uncoveredDays: 4 }), row({ categoryPath: "Food", uncoveredDays: 11 })],
    });
    expect(notes[0]!.body).toContain("11 days on Food");
  });

  test("reads singular for a one-day coverage gap", () => {
    // pre-existing branch, never exercised until the coverage gate was run
    const notes = budgetSectionNotes({ rows: [row({ uncoveredDays: 1 })] });
    expect(notes[0]!.body).toContain("up to 1 day on");
    expect(notes[0]!.body).not.toContain("1 days");
  });

  test("never states a projection or a verdict over an uncovered window", () => {
    const notes = budgetSectionNotes({ rows: [row({ uncoveredDays: 11 })] });
    const body = notes.map((n) => n.body).join(" ");
    expect(body).toMatch(/lower bounds/);
    expect(body).not.toMatch(/projected|on track|will be/i);
  });

  /*
   * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): a row not one elapsed day of whose window has been read prints no Spent and
   * no Left — so the note may not call its spend a lower bound. 🔴 Measured on his ledger copy 2026-10-12: "12 of 12
   * budgets are grading days the ledger has not reached — 12 days each. Their spend and percentages are lower bounds,
   * not measurements" over twelve rows that print no spend and no percentage at all. ⛔ The rows' own test
   * (`lib/budget-coverage::spendUnread`), so the note and the rows cannot disagree about which rows print a dash.
   */
  describe("⚖️ §6A 64 — rows that print no spend", () => {
    const UNREAD = { uncoveredDays: 12, noDayRead: true, txnCount: 0 } as const;
    const coverage = (rows: ReturnType<typeof row>[]) =>
      budgetSectionNotes({ rows }).find((n) => n.id === "budgets-coverage")!.body;

    test("every one of them: no spend is called a lower bound", () => {
      expect(coverage([row({ ...UNREAD, categoryPath: "Car" }), row({ ...UNREAD, categoryPath: "Food" })])).toBe(
        "2 of 2 budgets are grading days the ledger has not reached — 12 days each. Not one elapsed day of their " +
          "periods has been imported, so neither their spend nor a verdict is shown.",
      );
    });

    test("some of them: each kind is said of the rows it is true of", () => {
      expect(coverage([row({ ...UNREAD, categoryPath: "Car" }), row({ categoryPath: "Food", uncoveredDays: 4 })])).toBe(
        "2 of 2 budgets are grading days the ledger has not reached — up to 12 days on Car. No verdict is shown for " +
          "any of them: 1 has not had one elapsed day imported, so no spend is shown there either, and the others' " +
          "spend and percentages are lower bounds, not measurements.",
      );
      const twoUnread = [row({ ...UNREAD, categoryPath: "Car" }), row({ ...UNREAD, categoryPath: "Fees" })];
      expect(coverage([...twoUnread, row({ uncoveredDays: 4 })])).toMatch(/: 2 have not had one elapsed day imported/);
    });

    test("a row found in it, or one spent only from cash, keeps its figures and the lower-bound words", () => {
      for (const kept of [{ txnCount: 1 }, { spentFromAccounts: 0, spentFromWallets: 1 }]) {
        const body = coverage([row({ ...UNREAD, ...kept }), row({ uncoveredDays: 4 })]);
        expect(body).toMatch(/Their spend and percentages are lower bounds, not measurements, so no verdict is shown/);
      }
    });
  });

  /*
   * ⚖️ default built, not asked (2026-10-29): an over row whose window has days unread keeps its verdict, and its rows
   * say its figures are floors (`budgetCoverageLine`). The note keeps counting the rows whose verdict is withheld — and
   * says the over ones are read in part too, so that count does not read as "the rest are read in full". 🔴 Measured on
   * his ledger copy 2026-10-29: "7 of 12 budgets are grading days the ledger has not reached — 29 days each. No verdict
   * is shown for any of them: …" beside 5 rows reading "Over budget by N%" over the same October — Health and Travel
   * read through Oct 2 (27 days), Entertainment, Shopping and Subscriptions through Aug 12 (29).
   */
  describe("⚖️ over rows read in part — the count beside them does not call them read in full", () => {
    const coverage = (rows: ReturnType<typeof row>[]) =>
      budgetSectionNotes({ rows }).find((n) => n.id === "budgets-coverage")?.body;
    const DASH = { uncoveredDays: 29, noDayRead: true, txnCount: 0 } as const;
    const FLOOR = { uncoveredDays: 29, noDayRead: true, txnCount: 2 } as const;
    const OVER = { ...FLOOR, pace: "over" } as const;
    /** his twelve on his ledger copy 2026-10-29, in page order */
    const HIS = [
      row({ ...DASH, categoryPath: "Car" }),
      row({ ...DASH, categoryPath: "Cash & ATM" }),
      row({ ...OVER, categoryPath: "Entertainment" }),
      row({ ...DASH, categoryPath: "Fees" }),
      row({ ...FLOOR, categoryPath: "Food" }),
      row({ ...OVER, categoryPath: "Health", uncoveredDays: 27, noDayRead: false }),
      row({ ...FLOOR, categoryPath: "Housing", pace: "at-risk" }),
      row({ ...OVER, categoryPath: "Shopping" }),
      row({ ...OVER, categoryPath: "Subscriptions" }),
      row({ ...FLOOR, categoryPath: "Transport", pace: "at-risk" }),
      row({ ...OVER, categoryPath: "Travel", uncoveredDays: 27, noDayRead: false }),
      row({ ...FLOOR, categoryPath: "Utilities" }),
    ];

    test("his twelve: the seven withheld counted and tied as before, and the five over said to be floors", () => {
      expect(coverage(HIS)).toBe(
        "7 of 12 budgets are grading days the ledger has not reached — 29 days each. No verdict is shown for any of " +
          "them: 3 have not had one elapsed day imported, so no spend is shown there either, and the others' spend " +
          "and percentages are lower bounds, not measurements. The 5 over their plans are grading such days too, so " +
          "each is over by at least what it shows.",
      );
    });

    test("one over row is said in the singular — the e2e fixture's Housing", () => {
      expect(
        coverage([
          row({ categoryPath: "Food", uncoveredDays: 4 }),
          row({ categoryPath: "Housing", uncoveredDays: 3, pace: "over" }),
          row({ categoryPath: "Subscriptions", uncoveredDays: 4 }),
          row({ categoryPath: "Utilities", uncoveredDays: 3, txnCount: 0 }),
        ]),
      ).toBe(
        "3 of 4 budgets are grading days the ledger has not reached — up to 4 days on Food. Their spend and " +
          "percentages are lower bounds, not measurements, so no verdict is shown for them. The one over its plan is " +
          "grading such days too, so it is over by at least what it shows.",
      );
    });

    test("an over row read whole, or cash already past the line, is not said to be grading such days", () => {
      for (const measured of [{ uncoveredDays: 0 }, { spentFromAccounts: 0, spentFromWallets: 1 }]) {
        const body = coverage([row({ uncoveredDays: 4 }), row({ ...OVER, ...measured })]);
        expect(body).toBe(
          "1 of 2 budgets are grading days the ledger has not reached — up to 4 days on Food. Their spend and " +
            "percentages are lower bounds, not measurements, so no verdict is shown for them.",
        );
      }
    });

    /*
     * ⚖️ default built, not asked (2026-10-29): with no withheld row there is no count to correct, and each over row
     * carries its own line — the note stays what it was, absent.
     */
    test("over rows read in part beside no withheld row add no note of their own", () => {
      expect(coverage([row({ ...OVER, categoryPath: "Shopping" }), row({ categoryPath: "Food" })])).toBeUndefined();
    });

    /*
     * ⚖️ default built, not asked (2026-10-29): a rolling row whose closed period held back can still bank has a
     * line that can still rise (`lib/rollover-held-back::lineMayRise`), so how far past it an over row is, and a
     * withheld row's percentage, are no floors — the note says only what is true of every row it counts. 🔴 Review
     * of 48475ec4, measured on his ledger copy 2026-10-29: Fees, $15.00 rolling with September held back at $0.00,
     * and a $20.00 Oct 10 row on Venture X — "The 6 over their plans are grading such days too, so each is over by
     * at least what it shows." — read $20.00 of $30.00 once Fees' accounts were read through Sep 30, nothing added.
     */
    describe("⚖️ a line that can still rise — a closed period still to bank", () => {
      const RISES = { rolloverMayAddCents: 1_500 } as const;
      const FEES = row({ ...OVER, categoryPath: "Fees", ...RISES });
      const FOOD = row({ categoryPath: "Food", uncoveredDays: 4 });

      test("his twelve with Fees over: each has spent at least what it shows, one can have more roll over", () => {
        const withFees = HIS.map((r) => (r.categoryPath === "Fees" ? FEES : r));
        expect(coverage(withFees)).toBe(
          "6 of 12 budgets are grading days the ledger has not reached — 29 days each. No verdict is shown for any " +
            "of them: 2 have not had one elapsed day imported, so no spend is shown there either, and the others' " +
            "spend and percentages are lower bounds, not measurements. The 6 over their plans are grading such days " +
            "too, so each has spent at least what it shows, though more can still roll over into 1 of them.",
        );
      });

      test("one over row whose line can still rise, and every one of several", () => {
        expect(coverage([FOOD, FEES])).toBe(
          "1 of 2 budgets are grading days the ledger has not reached — up to 4 days on Food. Their spend and " +
            "percentages are lower bounds, not measurements, so no verdict is shown for them. The one over its " +
            "plan is grading such days too, so it has spent at least what it shows, though more can still roll " +
            "over into it.",
        );
        expect(coverage([FOOD, FEES, { ...FEES, categoryPath: "Cash" }])).toContain(
          ". The 2 over their plans are grading such days too, so each has spent at least what it shows, though " +
            "more can still roll over into each of them.",
        );
      });

      test("a withheld row whose line can still rise: its spend is a lower bound, no percentage called one", () => {
        expect(coverage([{ ...FOOD, ...RISES }, row({ categoryPath: "Fees", uncoveredDays: 4 })])).toBe(
          "2 of 2 budgets are grading days the ledger has not reached — 4 days each. Their spend is a lower bound, " +
            "not a measurement, so no verdict is shown for them.",
        );
        const car = row({ ...DASH, categoryPath: "Car" });
        expect(coverage([car, row({ ...FLOOR, categoryPath: "Food", ...RISES })])).toBe(
          "2 of 2 budgets are grading days the ledger has not reached — 29 days each. No verdict is shown for any " +
            "of them: 1 has not had one elapsed day imported, so no spend is shown there either, and the others' " +
            "spend is a lower bound, not a measurement.",
        );
      });

      test("a dash whose line can still rise changes nothing — it shows no spend or percentage to call one", () => {
        // Cash & ATM's and Fees' October on his ledger copy 2026-10-29: September held back at $0.00, nothing found
        const withDashes = HIS.map((r) => (r.noDayRead && r.txnCount === 0 ? { ...r, ...RISES } : r));
        expect(coverage(withDashes)).toBe(coverage(HIS));
      });
    });
  });
});

describe("categorySectionNotes", () => {
  const cat = (over: Partial<Parameters<typeof categorySectionNotes>[0]["rows"][number]> = {}) => ({
    path: "Food",
    subtreeTxnCount: 10,
    isArchived: false,
    hasLiveChildren: false,
    isEditable: true,
    hasScheduledSeries: false,
    ...over,
  });

  test("a parent whose CHILDREN hold the transactions is never called empty", () => {
    // the defect this exists to prevent: the per-row count is direct-only, so
    // Investments reads 0 while its children hold thousands
    const notes = categorySectionNotes({
      rows: [
        cat({ path: "Investments", subtreeTxnCount: 0, hasLiveChildren: true }),
        cat({ path: "Investments > Buys", subtreeTxnCount: 2_066 }),
      ],
    });
    expect(notes).toEqual([]);
  });

  /*
   * ⛔ THE ONE THAT MATTERS. `Car > Car Insurance` holds zero transactions and
   * carries a confirmed −$361.49 monthly bill that has not charged yet. Calling
   * it empty tells the owner to archive a live commitment.
   *
   * Coverage cannot enforce this test. The gate is an operand in an `&&` chain,
   * and v8 scores that operand covered the moment it is EVALUATED — which every
   * other test here already does. Branch coverage reads 100% with the excluding
   * direction never once executed, so this case is only ever caught by someone
   * writing it on purpose.
   */
  test("a category carrying a scheduled series is never called empty", () => {
    const notes = categorySectionNotes({
      rows: [cat({ path: "Car > Car Insurance", subtreeTxnCount: 0, hasScheduledSeries: true }), cat()],
    });
    expect(notes).toEqual([]);
  });

  test("a category the archive guard refuses is never named", () => {
    // advertising an action the service will reject is worse than silence
    const notes = categorySectionNotes({
      rows: [cat({ path: "Uncategorized", subtreeTxnCount: 0, isEditable: false }), cat()],
    });
    expect(notes).toEqual([]);
  });

  test("a parent whose only children are ARCHIVED counts as a leaf", () => {
    // hasLiveChildren, not hasChildren: filtering on parentId alone would hide
    // such a row from this note forever
    const notes = categorySectionNotes({
      rows: [
        cat({ path: "Hobbies", subtreeTxnCount: 0, hasLiveChildren: false }),
        cat({ path: "Hobbies > Model Trains", subtreeTxnCount: 0, isArchived: true }),
        cat(),
      ],
    });
    expect(notes[0]!.body).toContain("Hobbies holds no transactions.");
  });

  test("names every empty category when there are few, and reads singular for one", () => {
    const one = categorySectionNotes({ rows: [cat({ path: "Gifts", subtreeTxnCount: 0 }), cat()] });
    expect(one[0]!.body).toContain("Gifts holds no transactions.");
    expect(one[0]!.body).toContain("you do not use it");
    expect(one[0]!.body).toContain("its transactions are landing");
    expect(one[0]!.body).toContain("before archiving it.");

    const two = categorySectionNotes({
      rows: [
        cat({ path: "Fees > Interest Charges", subtreeTxnCount: 0 }),
        cat({ path: "Utilities > Water/Gas", subtreeTxnCount: 0 }),
        cat({ path: "Food", subtreeTxnCount: 500 }),
      ],
    });
    expect(two[0]!.body).toContain(
      "2 categories hold no transactions: Fees > Interest Charges, Utilities > Water/Gas.",
    );
    expect(two[0]!.body).toContain("you do not use them");
    expect(two[0]!.body).toContain("before archiving one.");
  });

  test("caps the list and switches to a count when many are empty", () => {
    // the e2e fixture really does have 28 of these; naming all of them would
    // turn a note into a wall
    const rows = [...Array.from({ length: 7 }, (_, i) => cat({ path: `Empty ${i}`, subtreeTxnCount: 0 })), cat()];
    const [note] = categorySectionNotes({ rows });
    expect(note!.body).toContain("7 categories hold no transactions, including Empty 0, Empty 1, Empty 2, Empty 3.");
    expect(note!.body).not.toContain("Empty 4");
  });

  test("says nothing when every category is archived", () => {
    expect(categorySectionNotes({ rows: [cat({ isArchived: true }), cat({ isArchived: true })] })).toEqual([]);
  });

  describe("categoryNoteRows", () => {
    const node = (over: Partial<Parameters<typeof categoryNoteRows>[0][number]> = {}) => ({
      id: "id-food",
      name: "Food",
      isArchived: false,
      isEditable: true,
      children: [],
      ...over,
    });
    const counts = (m: Record<string, number> = {}) => (id: string) => m[id] ?? 0;

    test("a root's subtree count includes its children's", () => {
      const [root] = categoryNoteRows(
        [node({ id: "id-inv", name: "Investments", children: [node({ id: "id-buys", name: "Buys" })] })],
        new Set(),
        counts({ "id-buys": 2_066 }),
      );
      expect(root!.subtreeTxnCount).toBe(2_066);
      expect(root!.hasLiveChildren).toBe(true);
    });

    test("a root whose only child is ARCHIVED is a leaf", () => {
      // listCategoryTree filters children by parentId alone, so the archived
      // child is present in the tree; counting it would hide this root forever
      const [root] = categoryNoteRows(
        [node({ id: "id-h", name: "Hobbies", children: [node({ id: "id-m", name: "Trains", isArchived: true })] })],
        new Set(),
        counts(),
      );
      expect(root!.hasLiveChildren).toBe(false);
      expect(root!.subtreeTxnCount).toBe(0);
    });

    test("a child is printed as a path, so a leaf is findable in the manager", () => {
      const rows = categoryNoteRows(
        [node({ id: "id-fees", name: "Fees", children: [node({ id: "id-ic", name: "Interest Charges" })] })],
        new Set(),
        counts(),
      );
      expect(rows.map((r) => r.path)).toEqual(["Fees", "Fees > Interest Charges"]);
      expect(rows[1]!.hasLiveChildren).toBe(false);
    });

    test("the scheduled set is matched by id, at either level", () => {
      const rows = categoryNoteRows(
        [node({ id: "id-car", name: "Car", children: [node({ id: "id-ins", name: "Car Insurance" })] })],
        new Set(["id-ins"]),
        counts(),
      );
      expect(rows.map((r) => r.hasScheduledSeries)).toEqual([false, true]);
    });

    test("the count comes from the supplied source, not from the tree node", () => {
      // the whole point of the accessor: excluded rows and split parts reach a
      // category without appearing in the manager's active-parent-row count, and
      // a category /spending shows spend for must never read as holding nothing
      const rows = categoryNoteRows(
        [node({ id: "id-fees", name: "Fees", children: [node({ id: "id-ic", name: "Interest Charges" })] })],
        new Set(),
        counts({ "id-ic": 1 }),
      );
      expect(rows[1]!.subtreeTxnCount).toBe(1);
      expect(categorySectionNotes({ rows })).toEqual([]);
    });
  });

  test("says nothing when every category is in use", () => {
    expect(categorySectionNotes({ rows: [cat(), cat({ path: "Housing" })] })).toEqual([]);
  });

  test("says nothing at all on a ledger with nothing imported yet", () => {
    /*
     * The rule at the top of this module: never assert a measured zero. A fresh
     * install has a full seeded taxonomy and no transactions, so EVERY category
     * is empty — measured, 41 of them. Listing the app's own starter categories
     * back at a first-run user, with a two-way explanation where neither branch
     * is the reason, is the exact output that rule forbids.
     */
    const virgin = ["Food", "Housing", "Housing > Rent", "Income > Salary"].map((path) =>
      cat({ path, subtreeTxnCount: 0 }),
    );
    expect(categorySectionNotes({ rows: virgin })).toEqual([]);

    // …but one imported transaction anywhere is enough to make the rest speak
    const started = [...virgin, cat({ path: "Groceries", subtreeTxnCount: 1 })];
    expect(categorySectionNotes({ rows: started })[0]!.body).toContain("4 categories hold no transactions");
  });

  test("never concludes the categories are unused, and never repeats the page header", () => {
    const [note] = categorySectionNotes({ rows: [cat({ path: "Gifts", subtreeTxnCount: 0 }), cat()] });
    // the state is observable; the CAUSE is not, and three different causes
    // produced it on the real ledger
    expect(note!.body).toMatch(/can mean/);
    expect(note!.body).not.toMatch(/unused|no longer needed|safe to archive|you can delete/i);
    // /categories' PageHeader already owns the archiving-is-not-deletion line
    expect(note!.body).not.toMatch(/nothing is deleted|never deletes|history intact/i);
  });
});

describe("holdingPriceSectionNotes", () => {
  const days = (from: string, to: string) =>
    Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const fmt = (iso: string) => iso;
  const call = (rows: { quotedOn: string | null }[], today = "2026-08-13") =>
    holdingPriceSectionNotes({ rows, today, daysBetween: days, formatDay: fmt });

  test("says nothing when every holding is priced through today", () => {
    expect(call([{ quotedOn: "2026-08-13" }, { quotedOn: "2026-08-13" }])).toEqual([]);
  });

  test("emits nothing rather than a zero when nothing is priced at all", () => {
    // an unpriced holding is the holdings table's story; "priced 0 days ago" here
    // would be a measurement of an absence
    expect(call([{ quotedOn: null }, { quotedOn: null }])).toEqual([]);
    expect(call([])).toEqual([]);
  });

  test("reports one shared date as covering every position", () => {
    const [note] = call([{ quotedOn: "2026-08-06" }, { quotedOn: "2026-08-06" }]);
    expect(note!.body).toContain("Every position");
    expect(note!.body).toContain("2026-08-06");
    expect(note!.body).toContain("7 days ago");
  });

  test("NEVER says 'every position' when the dates disagree — it anchors on the oldest", () => {
    // the trap: a max()-driven "every position ... from <newest>" is a false
    // statement about the stalest rows the moment one symbol lags
    const [note] = call([{ quotedOn: "2026-08-06" }, { quotedOn: "2026-08-12" }]);
    expect(note!.body).not.toContain("Every position");
    expect(note!.body).toContain("oldest close");
    expect(note!.body).toContain("2026-08-06");
    expect(note!.body).not.toContain("2026-08-12");
  });

  test("finds the oldest and newest whichever order the rows arrive in", () => {
    // the reduce compares pairwise, so a descending list exercises the other arm
    const descending = call([{ quotedOn: "2026-08-12" }, { quotedOn: "2026-08-06" }])[0]!.body;
    const ascending = call([{ quotedOn: "2026-08-06" }, { quotedOn: "2026-08-12" }])[0]!.body;
    expect(descending).toBe(ascending);
    expect(descending).toContain("2026-08-06");
  });

  test("ignores holdings with no price when computing the oldest", () => {
    const [note] = call([{ quotedOn: null }, { quotedOn: "2026-08-06" }]);
    expect(note!.body).toContain("Every position");
    expect(note!.body).toContain("2026-08-06");
  });

  test("reads singular for a one-day gap", () => {
    const [note] = call([{ quotedOn: "2026-08-12" }]);
    expect(note!.body).toContain("1 day ago");
    expect(note!.body).not.toContain("1 days ago");
  });

  test("states no projection and no verdict", () => {
    const body = call([{ quotedOn: "2026-08-06" }])[0]!.body;
    expect(body).not.toMatch(/probably|should be|estimated|worth about/i);
  });
});

describe("reserved phrases", () => {
  /**
   * A note is live DOM text on a page whose e2e specs assert EXACT counts of
   * phrases like "rolled over" and "expected by now, not imported". Repeating one
   * breaks an unrelated assertion — and says the same thing twice in two voices.
   */
  const everyNote = (): SectionNote[] => [
    ...budgetSectionNotes({
      rows: [
        row({ categoryPath: "Housing", overdueCents: 228_570 }),
        row({ categoryPath: "Food", uncoveredDays: 11 }),
        // ⚖️ an over row read in part, whose clause sits beside its row's "Over budget by N%" (2026-10-29)
        row({ categoryPath: "Travel", uncoveredDays: 27, pace: "over" }),
      ],
    }),
    ...categorySectionNotes({
      rows: [
        { path: "Food", subtreeTxnCount: 10, isArchived: false, hasLiveChildren: false, isEditable: true, hasScheduledSeries: false },
        {
          path: "Gifts",
          subtreeTxnCount: 0,
          isArchived: false,
          hasLiveChildren: false,
          isEditable: true,
          hasScheduledSeries: false,
        },
      ],
    }),
    ...holdingPriceSectionNotes({
      rows: [{ quotedOn: "2026-08-06" }, { quotedOn: "2026-08-12" }],
      today: "2026-08-13",
      daysBetween: (f, t) => Math.round((Date.parse(t) - Date.parse(f)) / 86_400_000),
      formatDay: (iso) => iso,
    }),
  ];

  test("no note repeats a phrase the surrounding UI already owns", () => {
    for (const note of everyNote()) {
      for (const phrase of RESERVED_NOTE_PHRASES) {
        expect(note.body, `note ${note.id} must not contain "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  test("every note carries a stable id and a non-empty body", () => {
    const notes = everyNote();
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
    for (const n of notes) expect(n.body.trim().length).toBeGreaterThan(0);
  });
});

describe("the punctuation these notes rely on", () => {
  /**
   * A note that states a COUNT and then joins names with a separator is only
   * unambiguous while no name can contain that separator. That invariant spans
   * two modules — the note prints it, `createCategory`/`renameCategory` enforce
   * it — so it is asserted rather than remembered. Changing either separator
   * here without extending `FORBIDDEN_NAME_CHARS` fails this test instead of
   * quietly reopening "2 categories: Food, Drink, Pets" (says two, lists three).
   */
  test("every separator character is one a category name may not contain", () => {
    for (const separator of [NAME_LIST_SEPARATOR, PATH_SEPARATOR]) {
      const meaningful = [...separator.trim()];
      expect(meaningful.length, `${JSON.stringify(separator)} must punctuate with something`).toBeGreaterThan(0);
      for (const char of meaningful) {
        expect(
          FORBIDDEN_NAME_CHARS as readonly string[],
          `a name containing ${JSON.stringify(char)} would make a note contradict its own list`,
        ).toContain(char);
      }
    }
  });

  test("the seeded taxonomy — the one naming path no validator guards — obeys it too", () => {
    // createCategory and renameCategory are the only two paths a user's name
    // takes; db/seed.ts is the third and calls neither, so the sweep is here.
    const seeded = TAXONOMY.flatMap((entry) => [entry.name, ...entry.subs]);
    expect(seeded.length).toBeGreaterThan(0);
    for (const name of seeded) {
      for (const char of FORBIDDEN_NAME_CHARS) {
        expect(name, `seeded category ${JSON.stringify(name)} contains ${char}`).not.toContain(char);
      }
    }
  });
});

describe("cashEarningsSectionNotes", () => {
  const formatDay = (iso: string) => iso;
  const row = (over: Partial<CashEarningsNoteInput["rows"][number]> = {}) => ({
    seriesName: "Cash job (weekly pay)",
    basis: "series-stale" as const,
    impliedCents: 523_000,
    bankedCents: 0,
    unbankedCents: 523_000,
    periodsSinceBanked: 11,
    lastBankedOn: "2026-06-05",
    // July 2026's own five paydays — the span the $5,230.00 was counted over
    firstPeriodOn: "2026-07-02",
    lastPeriodOn: "2026-07-30",
    ...over,
  });
  const notes = (over: Partial<CashEarningsNoteInput["rows"][number]> = {}) =>
    cashEarningsSectionNotes({ rows: [row(over)], formatDay });

  test("a silent schedule names the gap, the silence, and every reading", () => {
    // The live ledger's own July: $5,230.00 implied, nothing banked, eleven
    // paydays since 2026-06-05.
    const [note] = notes();
    expect(note).toBeDefined();
    // suffixed with the series name so two silent schedules cannot share a React key
    expect(note!.id).toMatch(/^cash-earnings-unbanked-/);
    expect(note!.body).toContain("$5,230.00");
    expect(note!.body).toContain("11 expected paydays");
    // the scope marker: the sentence before it counts THIS PERIOD's paydays (5),
    // this one counts the schedule's silence (11), and without the phrase a
    // reader merges the two
    expect(note!.body).toContain("Across the whole schedule");
    expect(note!.body).toContain("2026-06-05");
    // every explanation, because the module genuinely cannot choose
    expect(note!.body).toContain("held as cash");
    expect(note!.body).toContain("spent as cash");
    expect(note!.body).toContain("ended");
  });

  /*
   * ⚖️ Default built, not asked (2026-10-21) — the card's caveat's (059d8aa): his pay has been payroll by ACH since
   * Aug 27 (decision 55), and payroll landing in an account the ledger does not read is as quiet as pay never paid.
   * 🔴 Review of 619ceb4 (MEDIUM): on his ledger copy 2026-10-21 with a Salary-filed −$1,141.92 on Fri Sep 25 and
   * Wells Fargo derived through Fri Oct 16, on Oct 23, October, Q4 and YTD explained four payroll weeks as "that money
   * was held as cash, spent as cash, the schedule has ended, …" while the card beside them named payroll landing in an
   * account the ledger does not read.
   */
  test("the silence names pay landing in an account the ledger does not read, in the card's words", () => {
    const [note] = notes();
    expect(note!.body).toContain(
      `— that money was held as cash, spent as cash, paid into ${ACCOUNT_NOT_READ}, or the schedule has ended. The ` +
        "income figures",
    );
    expect(ACCOUNT_NOT_READ).toBe("an account the ledger does not read");
  });

  /*
   * ⚖️ …and the claim before it says where the ledger could see the money land: "reached an account the ledger reads"
   * (`ACCOUNT_READ`) — default built, not asked (2026-10-29), the review's own wording. 🔴 Review of cc30142: "none of
   * it reached an account" stood a sentence before "paid into an account the ledger does not read" — read literally,
   * money that reached no account offered as paid into one. On his ledger copy 2026-10-29 with a Salary-filed
   * −$1,141.92 on Fri Sep 25 and Wells Fargo derived through Fri Oct 16, 27 of /spending's 42 months, quarters, weeks
   * and years printed both.
   */
  test("what reached an account is the ones the ledger reads, beside the one it does not", () => {
    const none = notes()[0]!.body;
    const only = notes({ impliedCents: 418_400, bankedCents: 144_700, unbankedCents: 273_700 })[0]!.body;
    expect(none).toContain(`and none of it reached ${ACCOUNT_READ}. Across`);
    expect(only).toContain(`and only $1,447.00 reached ${ACCOUNT_READ}. Across`);
    expect(ACCOUNT_READ).toBe("an account the ledger reads");
    for (const body of [none, only]) {
      expect(body).toContain(`paid into ${ACCOUNT_NOT_READ}`);
      expect(body).not.toMatch(/reached an account(?! the ledger reads)/u);
    }
  });

  test("a period that banked SOME of it names the part that landed", () => {
    // June 2026 on the live ledger: $4,184.00 implied, $1,447.00 banked in two
    // deposits, still stale because nothing has arrived since. "none of it
    // reached an account" would be false here, and it is the branch the real
    // data hits most often.
    const [note] = notes({ impliedCents: 418_400, bankedCents: 144_700, unbankedCents: 273_700 });
    expect(note!.body).toContain("only $1,447.00 reached an account");
    expect(note!.body).not.toContain("none of it");
  });

  test("a schedule that has never paid says so instead of naming a date", () => {
    const [note] = notes({ lastBankedOn: null, periodsSinceBanked: 4 });
    expect(note!.body).toContain("nothing attributed to it has ever banked");
    expect(note!.body).not.toContain("since");
  });

  test("a live schedule keeping up says nothing at all", () => {
    // His ordinary rhythm is to bank in lumps, so a single unbanked week is not
    // news. A strip that always has something to say stops being read.
    expect(notes({ basis: "series-live", periodsSinceBanked: 1 })).toEqual([]);
  });

  test("no confirmed schedule means nothing is measured, so nothing is said", () => {
    expect(
      notes({ basis: "no-series", impliedCents: 0, unbankedCents: 0, periodsSinceBanked: 0 }),
    ).toEqual([]);
  });

  test("no confirmed schedule stays silent even when the numbers would speak", () => {
    // Caught by mutation. The natural producer zeroes every implied figure for
    // `no-series`, so the guard looked dead — but this module takes arbitrary
    // input, and a caller assembling rows by hand can hand it a gap with no
    // schedule behind it. Without a confirmed schedule there is no measurement,
    // and a note about an unmeasured thing is the one shape this file refuses.
    expect(notes({ basis: "no-series", unbankedCents: -50_000 })).toEqual([]);
  });

  test("never asserts a measured zero", () => {
    // A window before the series began implies nothing. "implies $0.00 and none
    // was banked" is true and useless, and the doctrine forbids it.
    expect(notes({ impliedCents: 0, bankedCents: 0, unbankedCents: 0 })).toEqual([]);
  });

  /*
   * 🔴 "NONE OF IT REACHED AN ACCOUNT" OVER PAYDAYS NOBODY HAS READ. The note was
   * measured against the calendar, never against how far the account the pay
   * lands in has been imported. Measured 2026-09-14 on /spending?period=2026-09:
   * "Cash job (weekly pay) implies $2,094.00 of earnings over Sep 3 – 10, 2026
   * and none of it reached an account" — while Chase Checking, the only account
   * that pay has ever landed in, is read through Aug 12, and the dashboard says
   * of the same series "9 of them fall on days the records already cover,
   * through Aug 12". 11 of 14 /spending windows printed at least one false
   * sentence. The reading now carries the checked frontier; these rows pass it.
   */
  const checked = { checkedThrough: "2026-08-12", periodsCovered: 5, checkedPeriodsCovered: 5, checkedPeriodsSinceBanked: 9 };

  test("paydays past the day the records reach are not called unbanked", () => {
    const [note] = notes({
      ...checked,
      impliedCents: 209_400,
      unbankedCents: 209_400,
      firstPeriodOn: "2026-09-03",
      lastPeriodOn: "2026-09-10",
      periodsSinceBanked: 14,
      periodsCovered: 2,
      checkedPeriodsCovered: 0,
    });
    expect(note!.body).not.toContain("reached an account");
    /*
     * 🔴 The frontier is a CHECKED day (`earliestVerified` over `verifiedThrough`),
     * and this said "which nothing has imported yet" of it. On the e2e fixture
     * Chase Total Checking is checked through Jun 30 with rows imported to Jul 4,
     * and /spending?period=2026-07 printed exactly that (measured 2026-09-15).
     */
    expect(note!.body).toContain(
      ", all of it after 2026-08-12, the last day every account that pay lands in has been checked through — so the ledger has not looked for it.",
    );
    expect(note!.body).not.toContain("nothing has imported");
    // …and the silence says how much of it the records actually cover
    expect(note!.body).toContain("9 of them");
  });

  test("a window straddling the frontier scopes the claim to the days that were read", () => {
    const [note] = notes({ ...checked, impliedCents: 418_800, unbankedCents: 418_800, periodsCovered: 4, checkedPeriodsCovered: 1 });
    expect(note!.body).toContain("none of it reached an account the ledger reads through 2026-08-12");
    expect(note!.body).toContain(
      "; the other 3 paydays fall after that, the last day every account that pay lands in has been checked through.",
    );
    expect(note!.body).not.toContain("nothing has imported");
  });

  /*
   * 🔴 One left after the frontier read "the other 1 payday falls after that" — the template's count printed bare
   * (review of 8ef2fc5, the spending-year note). One is "the other payday", as `unbankedIncomeFrontierClause` says
   * "the other one".
   */
  test("one payday after the frontier is 'the other payday', never 'the other 1 payday'", () => {
    const [note] = notes({
      ...checked,
      impliedCents: 418_800,
      unbankedCents: 418_800,
      periodsCovered: 4,
      checkedPeriodsCovered: 3,
    });
    expect(note!.body).toContain(
      "none of it reached an account the ledger reads through 2026-08-12; the other payday falls after that, the " +
        "last day every account that pay lands in has been checked through.",
    );
    expect(note!.body).not.toContain("the other 1 ");
  });

  test("the 'only' branch is scoped too — never a bare total over unread paydays", () => {
    const [note] = notes({
      ...checked,
      impliedCents: 1_570_500,
      bankedCents: 144_700,
      unbankedCents: 1_425_800,
      periodsCovered: 15,
      checkedPeriodsCovered: 10,
    });
    expect(note!.body).toContain("only $1,447.00 reached an account the ledger reads through 2026-08-12");
    expect(note!.body).not.toContain("only $1,447.00 reached an account the ledger reads.");
  });

  test("a window and a silence read in full keep the sentence exactly as it was", () => {
    const [plain] = notes();
    const [read] = notes({ ...checked, checkedPeriodsSinceBanked: 11 });
    expect(read!.body).toBe(plain!.body);
  });

  test("a window read in full keeps its claim, and the silence says how much of it was read", () => {
    // July on the live ledger: all five of July's paydays fall on or before Aug 12,
    // but 5 of the schedule's 14 silent paydays do not — "14 … held as cash, spent
    // as cash, or ended" presented a list as complete over paydays nobody had read
    const [note] = notes({ ...checked, periodsSinceBanked: 14 });
    expect(note!.body).toContain("none of it reached an account the ledger reads.");
    expect(note!.body).toContain("14 expected paydays have passed");
    expect(note!.body).toContain("9 of them fall on days the records cover, through 2026-08-12");
  });

  /*
   * 🔴 "…OR IT HAS NOT BEEN IMPORTED YET" of paydays past the CHECKED day. The list of explanations gained a fourth when
   * some paydays fall after `LAST_CHECKED_DAY` — and said it in import words, of a day measured to a checked statement
   * balance: the e2e fixture's Chase Total Checking is checked through Jun 30 with rows imported to Jul 4. ⚖️ His
   * decision 65 (2026-10-12): the words name what the quiet waits for. The forecast, /budgets, the dashboard and this
   * note's own claim already say it — "the ledger has not looked for their deposits" (`notLookedForDeposits`).
   */
  test("paydays past the checked day are ones the ledger has not looked for, never 'not imported'", () => {
    const [note] = notes({ ...checked, periodsSinceBanked: 14 });
    expect(note!.body).toContain(
      "— that money was held as cash, spent as cash, paid into an account the ledger does not read, the schedule has " +
        "ended, or the ledger has not looked for their deposits. The income figures",
    );
    expect(note!.body).not.toContain("imported");
  });

  test("…of one payday, its deposit", () => {
    const [note] = notes({ ...checked, periodsSinceBanked: 10 });
    expect(note!.body).toContain("9 of them fall on days the records cover, through 2026-08-12");
    expect(note!.body).toContain(", or the ledger has not looked for its deposit. ");
  });

  test("…and of an account with no checked record, every payday's", () => {
    const [note] = notes({ ...checked, checkedThrough: null, checkedPeriodsCovered: 0, checkedPeriodsSinceBanked: 0 });
    expect(note!.body).toContain(", or the ledger has not looked for their deposits. ");
    expect(note!.body).not.toContain("imported");
  });

  test("an account with no checked record claims nothing about what reached it", () => {
    const [note] = notes({ ...checked, checkedThrough: null, checkedPeriodsCovered: 0, checkedPeriodsSinceBanked: 0 });
    expect(note!.body).not.toContain("reached an account");
    expect(note!.body).toContain("not been checked");
  });

  test("fewer than three missed paydays on read days is not a silent schedule yet", () => {
    expect(notes({ ...checked, checkedPeriodsCovered: 0, checkedPeriodsSinceBanked: 2 })).toEqual([]);
  });

  test("banking MORE than the period earned reads as catching up, not as a windfall", () => {
    // June banked $1,447.00 in two deposits; a month that clears a backlog will
    // bank more than it earned, and without this the page looks like a raise.
    const [note] = notes({ basis: "series-live", bankedCents: 900_000, unbankedCents: -376_000 });
    expect(note!.id).toMatch(/^cash-earnings-catchup-/);
    expect(note!.body).toContain("$3,760.00");
    expect(note!.body).toContain("earlier");
  });

  /*
   * 🔴 Measured on the owner's ledger 2026-10-07, /spending?period=2026-09: "It
   * America LLC (weekly pay) banked $1,141.92 more than its paydays over Sep 3 –
   * 24, 2026 came to. Cash is deposited in lumps, …" — of weekly ACH payroll into
   * Wells Fargo. The surplus is one deposit banking several paydays, which is
   * true of cash and of payroll alike; "Cash" was true of neither that month.
   */
  test("a catch-up names a lump of pay, never cash, so it stays true of payroll", () => {
    const [note] = notes({
      seriesName: "It America LLC (weekly pay)",
      basis: "series-live",
      bankedCents: 570_960,
      unbankedCents: -114_192,
    });
    expect(note!.id).toMatch(/^cash-earnings-catchup-/);
    expect(note!.body).not.toMatch(/\bcash\b/i);
    expect(note!.body).toContain(
      "One deposit can bank several paydays at once, so the surplus is earlier pay arriving late",
    );
    expect(note!.body).toContain("read it as a backlog clearing rather than as a period that earned more.");
  });

  test("one note per series, and a quiet series contributes none", () => {
    const out = cashEarningsSectionNotes({
      rows: [
        row(),
        row({ seriesName: "Tutoring", basis: "series-live", unbankedCents: 0, impliedCents: 0 }),
      ],
      formatDay,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toContain("Cash job (weekly pay)");
  });

  test("names the paydays it counted, never the period around them", () => {
    // 🔴 The live defect, 2026-09-10: `cashEarnings` bounds the implied figure at
    // `today`, so `/spending?period=2026-09` counted September's one elapsed
    // payday ($1,047.00) and captioned it "in this period" — of a month whose own
    // schedule is $4,188.00, which /budgets says on the same ledger. Q3 read
    // $10,470.00 of a quarter implying $13,611.00, and a custom Sep 1 – Dec 31
    // window read $1,047.00 over seventeen paydays.
    const [note] = notes({
      impliedCents: 104_700,
      unbankedCents: 104_700,
      firstPeriodOn: "2026-09-03",
      lastPeriodOn: "2026-09-03",
    });
    expect(note!.body).toContain("implies $1,047.00 of earnings on Sep 3, 2026 and");
    expect(note!.body).not.toContain("in this period");
  });

  test("a span of several paydays is named by its own two ends", () => {
    const [note] = notes();
    expect(note!.body).toContain("implies $5,230.00 of earnings over Jul 2 – 30, 2026 and");
  });

  /*
   * An invented window beats nothing only if it is true. With no covered payday there is no span to name — and no
   * paydays to have "came to" anything. 🔴 Jun 5 – Jun 5 and Sep 23 – Sep 23 on his ledger read "banked $400.00 more
   * than its paydays came to" of windows holding no payday at all (review of the shortfall batch).
   */
  test("says nothing about a span when no payday was covered — nor of paydays it has none of", () => {
    const [note] = notes({
      basis: "series-live",
      impliedCents: 0,
      bankedCents: 900_000,
      unbankedCents: -900_000,
      firstPeriodOn: null,
      lastPeriodOn: null,
    });
    expect(note!.body).toContain("banked $9,000.00 in a window where none of its paydays has passed.");
    expect(note!.body).not.toContain("more than its paydays");
  });

  test("the catch-up note names its span too", () => {
    const [note] = notes({ basis: "series-live", bankedCents: 900_000, unbankedCents: -376_000 });
    expect(note!.body).toContain("more than its paydays over Jul 2 – 30, 2026 came to.");
    expect(note!.body).not.toContain("more than this period earned");
  });

  test("note ids stay unique when two schedules are both silent", () => {
    // The id is a React key; two stale series producing the same id would drop
    // one of the notes silently.
    const out = cashEarningsSectionNotes({
      rows: [row(), row({ seriesName: "Second gig" })],
      formatDay,
    });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((n) => n.id)).size).toBe(2);
  });

  /*
   * ⚖️ DEFAULT (A), built 2026-10-21: a stale schedule's note names money out on a day of its own as the card and the
   * shortfall note do — "went back out on <day>" (`wentBackOutPhrase`) — in every shape its claim takes. 🔴 Review of
   * 27ca437 (MEDIUM): it printed the one rule's banked figure and never the day, and its `continue` skipped the
   * shortfall note, the only other path that named it.
   */
  describe("a stale schedule's note names money that went back out, whatever its claim", () => {
    const OUT: PayShortfall = {
      readPaydays: 0,
      firstReadOn: null,
      lastReadOn: null,
      readCents: 0,
      bankedInsideCents: 0,
      noPaydayInsideCents: 0,
      shortCents: 0,
      paidOutside: [],
      neverBankedCents: 0,
      notBankedYetCents: 0,
      notBankedYetPaydays: [],
      paidAcross: [],
      noPaydayBeyondCents: 0,
      otherBeyondCents: 0,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
      paidUnread: [],
      paidUncounted: [],
      wentBackOut: [{ postedOn: "2026-07-03", cents: 114_192 }],
      bankedCents: 0,
    };
    const BACK = "$1,141.92 went back out on 2026-07-03";
    const lead = (over: Partial<CashEarningsNoteInput["rows"][number]>): string => {
      const body = notes({ shortfall: OUT, ...over })[0]!.body;
      return body.slice(0, body.indexOf(" Across the whole schedule"));
    };

    test("read in full: after what reached an account", () => {
      expect(lead({ bankedCents: 144_700 })).toBe(
        `Cash job (weekly pay) implies $5,230.00 of earnings over Jul 2 – 30, 2026 and only $1,447.00 reached an ` +
          `account the ledger reads; ${BACK}.`,
      );
    });

    /*
     * ⛔ After the paydays past the checked day, so "after that" is the checked day. 🔴 Review of 337baa7 (MEDIUM): put
     * between the two, it read "…reached an account through Fri, Oct 16, 2026; $1,141.92 went back out on Fri, Sep 25,
     * 2026; the other payday falls after that, the last day every account that pay lands in has been checked through"
     * — Sep 25 read as the checked day (his ledger copy 2026-10-21, the Sep 25 return inserted, today Oct 23).
     */
    test("read in part: after the paydays past the checked day, which 'after that' still names", () => {
      expect(lead({ ...checked, periodsCovered: 5, checkedPeriodsCovered: 3 })).toContain(
        `none of it reached an account the ledger reads through 2026-08-12; the other 2 paydays fall after that, the ` +
          `last day every account that pay lands in has been checked through; ${BACK}.`,
      );
    });

    test("none read: after 'the ledger has not looked for it'", () => {
      expect(lead({ ...checked, checkedPeriodsCovered: 0 })).toContain(
        `all of it after 2026-08-12, the last day every account that pay lands in has been checked through — so the ` +
          `ledger has not looked for it; ${BACK}.`,
      );
    });

    test("the account it lands in unchecked: after 'whether any of it arrived'", () => {
      expect(lead({ ...checked, checkedThrough: null })).toContain(
        `so the ledger cannot say whether any of it arrived; ${BACK}.`,
      );
    });

    test("no money out: the claim is the one it always was", () => {
      expect(lead({ shortfall: { ...OUT, wentBackOut: [] } })).toBe(
        "Cash job (weekly pay) implies $5,230.00 of earnings over Jul 2 – 30, 2026 and none of it reached an account " +
          "the ledger reads.",
      );
    });

    /*
     * ⛔ …and the pay deposits OUTSIDE the window put into its read paydays (`paidOutside`), in the shortfall note's
     * words — the money that reached an account is then the window's own, "inside the window". 🔴 Review of 337baa7
     * (MEDIUM, pre-existing): with Wed Sep 30's payroll paying Thu Oct 1 early, Wells Fargo read through Oct 23 and
     * today Oct 30, October read "implies $5,709.60 of earnings over Oct 1 – 29, 2026 and none of it reached an account
     * through Fri, Oct 23, 2026" while the calendar drew Oct 1 paid by the deposit of Sep 30 — and the live schedule's
     * shortfall note named it "paid early, by the deposit of Wed, Sep 30, 2026" (his ledger copy 2026-10-21, the Sep 30
     * row inserted).
     */
    describe("…and what deposits outside the window paid of its read paydays", () => {
      const EARLY = { depositOn: "2026-07-01", paydays: ["2026-07-02"], cents: 104_600, early: true };
      const PAID = "$1,046.00 (Jul 2) was paid early, by the deposit of 2026-07-01";

      test("read in full: none of it reached an account inside the window, and who paid the rest", () => {
        expect(lead({ shortfall: { ...OUT, paidOutside: [EARLY], wentBackOut: [] } })).toBe(
          "Cash job (weekly pay) implies $5,230.00 of earnings over Jul 2 – 30, 2026 and none of it reached an account " +
            `the ledger reads inside the window; ${PAID}.`,
        );
      });

      test("read in part: after the paydays past the checked day, before the money that went back out", () => {
        expect(
          lead({ ...checked, bankedCents: 104_600, checkedPeriodsCovered: 3, shortfall: { ...OUT, paidOutside: [EARLY] } }),
        ).toContain(
          "only $1,046.00 reached an account the ledger reads inside the window through 2026-08-12; the other 2 " +
            "paydays fall after that, the last day every account that pay lands in has been checked through; " +
            `${PAID}; ${BACK}.`,
        );
      });

      test("paid late, by a deposit after the window, is 'paid by', never 'early'", () => {
        const late = { ...EARLY, depositOn: "2026-08-03", paydays: ["2026-07-30"], early: false };
        expect(lead({ shortfall: { ...OUT, paidOutside: [late], wentBackOut: [] } })).toContain(
          "none of it reached an account the ledger reads inside the window; $1,046.00 (Jul 30) was paid by the " +
            "deposit of 2026-08-03.",
        );
      });
    });

    /*
     * ⛔ …and the money inside the window that paid ANOTHER window's read payday (`paidAcross`) is that window's: it is
     * not what "reached an account" of this one's earnings, and it is named after the claim, in the shortfall note's
     * words — "another $X banked inside the window, from the deposit of …, paid Oct 1's payday early". 🔴 Review of
     * 0c9bc8d (MEDIUM): on his ledger copy 2026-10-21 with Wed Sep 30's payroll paying Thu Oct 1, Wells Fargo read
     * through Oct 23 and today Oct 30, Q3 read "implies $14,085.60 of earnings over Jul 2 – Sep 24, 2026 and only
     * $6,851.52 reached an account" — Sep 30's $1,141.92 among it — while Q4 on the same page named that deposit paying
     * Oct 1 early: one deposit on both sides, and a $7,234.08 shortfall to read where the card says $8,376.00.
     */
    describe("…and what its deposits paid of another window's paydays", () => {
      const AHEAD = { depositOn: "2026-07-29", paydays: ["2026-08-06"], cents: 104_600, early: true };
      const ANOTHER = "another $1,046.00 banked inside the window, from the deposit of 2026-07-29, paid Aug 6's payday early";

      test("read in full: what reached an account is the window's own, and the rest is named", () => {
        expect(lead({ bankedCents: 209_200, shortfall: { ...OUT, paidAcross: [AHEAD], wentBackOut: [] } })).toBe(
          "Cash job (weekly pay) implies $5,230.00 of earnings over Jul 2 – 30, 2026 and only $1,046.00 reached an " +
            `account the ledger reads inside the window; ${ANOTHER}.`,
        );
      });

      test("all of it paid another window's payday: none of it reached an account", () => {
        expect(lead({ bankedCents: 104_600, shortfall: { ...OUT, paidAcross: [AHEAD], wentBackOut: [] } })).toBe(
          "Cash job (weekly pay) implies $5,230.00 of earnings over Jul 2 – 30, 2026 and none of it reached an " +
            `account the ledger reads inside the window; ${ANOTHER}.`,
        );
      });

      // ⛔ the shortfall note's order: who paid its paydays from outside, then its money that paid another's, then out
      test("read in part: after the paydays past the checked day, between money from outside and money out", () => {
        const paidIn = { depositOn: "2026-07-01", paydays: ["2026-07-02"], cents: 104_600, early: true };
        expect(
          lead({
            ...checked,
            bankedCents: 313_800,
            checkedPeriodsCovered: 3,
            shortfall: { ...OUT, paidOutside: [paidIn], paidAcross: [AHEAD] },
          }),
        ).toContain(
          "only $2,092.00 reached an account the ledger reads inside the window through 2026-08-12; the other 2 " +
            "paydays fall after that, the last day every account that pay lands in has been checked through; " +
            `$1,046.00 (Jul 2) was paid early, by the deposit of 2026-07-01; ${ANOTHER}; ${BACK}.`,
        );
      });

      test("several deposits: each with the payday it paid, late or early", () => {
        const late = { depositOn: "2026-07-03", paydays: ["2026-06-25"], cents: 104_600, early: false };
        expect(lead({ bankedCents: 313_800, shortfall: { ...OUT, paidAcross: [late, AHEAD], wentBackOut: [] } })).toBe(
          "Cash job (weekly pay) implies $5,230.00 of earnings over Jul 2 – 30, 2026 and only $1,046.00 reached an " +
            "account the ledger reads inside the window; another $2,092.00 banked inside the window paid paydays " +
            "outside it: $1,046.00, from the deposit of 2026-07-03, paid Jun 25's payday and $1,046.00, from the " +
            "deposit of 2026-07-29, paid Aug 6's payday early.",
        );
      });
    });
  });

  /*
   * ⛔ THE SILENCE IS THE PAYDAYS NO DEPOSIT PAID (`periodsSinceBanked`), so a sentence counting them "since the last
   * deposit" says which it left out (`paidEarlyAside`). 🔴 Review of 337baa7 (MEDIUM): with Wed Sep 30's payroll paying
   * Thu Oct 1 early, Wells Fargo read through Oct 23 and today Oct 30, /spending October read "Across the whole
   * schedule, 4 expected paydays have passed since the last deposit on Wed, Sep 30, 2026" — five Thursdays had (his
   * ledger copy 2026-10-21, the Sep 30 row inserted).
   */
  describe("a stale schedule's silence names the paydays a deposit paid early, which it does not count", () => {
    test("one: '(not counting Jun 11, which was paid early)'", () => {
      expect(notes({ silencePaidEarly: ["2026-06-11"] })[0]!.body).toContain(
        "Across the whole schedule, 11 expected paydays have passed since the last deposit on 2026-06-05 (not " +
          "counting Jun 11, which was paid early) — ",
      );
    });

    test("several, before the part the records cover", () => {
      expect(notes({ ...checked, silencePaidEarly: ["2026-06-11", "2026-06-18"] })[0]!.body).toContain(
        "11 expected paydays have passed since the last deposit on 2026-06-05 (not counting Jun 11 and Jun 18, which " +
          "were paid early), and 9 of them fall on days the records cover, through 2026-08-12 — ",
      );
    });

    test("none: the sentence it always was", () => {
      expect(notes({ silencePaidEarly: [] })[0]!.body).toContain(
        "11 expected paydays have passed since the last deposit on 2026-06-05 — ",
      );
    });
  });

  /*
   * 🔴 Read on his ledger 2026-10-13: /spending September printed the surplus note (the Sep 24 deposit paid Aug 27),
   * and August — Aug 6, 13 and 20 paid by no deposit, Aug 27 by Sep 24's — said nothing beside "INCOME $54.12"; June
   * read Salary $1,447.00 against four paydays of $4,188.00 with no note. The unbanked note speaks only of a STALE
   * series, and his is "Awaiting statements". These rows carry what the page measures (`payShortfall`); the figures
   * are a copy of his ledger's, today 2026-10-13, Wells Fargo checked through Thu Sep 24.
   */
  describe("a window whose read paydays were not banked inside it — the shortfall note", () => {
    const HIS = {
      seriesName: "It America LLC (weekly pay)",
      basis: "series-live" as const,
      lastBankedOn: "2026-09-24",
      periodsSinceBanked: 2,
      checkedThrough: "2026-09-24",
      checkedPeriodsSinceBanked: 0,
    };
    const AUGUST: PayShortfall = {
      readPaydays: 4,
      firstReadOn: "2026-08-06",
      lastReadOn: "2026-08-27",
      readCents: 428_292,
      bankedInsideCents: 0,
      noPaydayInsideCents: 0,
      shortCents: 428_292,
      paidOutside: [{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: 114_192, early: false }],
      neverBankedCents: 314_100,
      notBankedYetCents: 0,
      notBankedYetPaydays: [],
      paidAcross: [],
      noPaydayBeyondCents: 0,
      otherBeyondCents: 0,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
      paidUnread: [],
      paidUncounted: [],
      wentBackOut: [],
      bankedCents: 0,
    };
    const august = (over: Partial<PayShortfall> = {}) =>
      notes({
        ...HIS,
        impliedCents: 428_292,
        bankedCents: 0,
        unbankedCents: 428_292,
        firstPeriodOn: "2026-08-06",
        lastPeriodOn: "2026-08-27",
        periodsCovered: 4,
        checkedPeriodsCovered: 4,
        shortfall: { ...AUGUST, ...over },
      });

    test("August: the payday a later deposit paid is named with that deposit, the rest never reached a bank", () => {
      const out = august();
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe("cash-earnings-shortfall-It America LLC (weekly pay)");
      expect(out[0]!.body).toBe(
        "It America LLC (weekly pay)'s paydays over Aug 6 – 27, 2026 came to $4,282.92, and none of it was banked " +
          "inside the window: $1,141.92 (Aug 27) was paid by the deposit of 2026-09-24 and $3,141.00 never reached a " +
          "bank.",
      );
    });

    /*
     * ⚖️ Decision 55: the dashboard's "never reached a bank" is the paydays less every deposit banked — net. 🔴 This
     * read "$1,047.00 was banked inside the window and $3,141.00 never reached a bank. $400.00 from the deposit of …
     * went toward no payday.", and ALL said $11,517.00 beside the dashboard's $11,117.00 (review of a4b0fca).
     */
    test("June: the $400.00 that paid no payday is inside the banked figure, and the figures add up to $4,188.00", () => {
      const [note] = notes({
        ...HIS,
        impliedCents: 418_800,
        bankedCents: 144_700,
        unbankedCents: 274_100,
        firstPeriodOn: "2026-06-04",
        lastPeriodOn: "2026-06-25",
        shortfall: {
          ...AUGUST,
          firstReadOn: "2026-06-04",
          lastReadOn: "2026-06-25",
          readCents: 418_800,
          bankedInsideCents: 144_700,
          noPaydayInsideCents: 40_000,
          shortCents: 274_100,
          paidOutside: [],
          neverBankedCents: 274_100,
          towardNoPayday: [{ depositOn: "2026-06-05", cents: 40_000 }],
        },
      });
      expect(note!.body).toBe(
        "It America LLC (weekly pay)'s paydays over Jun 4 – 25, 2026 came to $4,188.00, of which $1,447.00 was " +
          "banked inside the window ($400.00 of it, from the deposit of 2026-06-05, went toward no payday) and " +
          "$2,741.00 never reached a bank.",
      );
    });

    test("July: no deposit paid any of it", () => {
      const [note] = august({
        firstReadOn: "2026-07-02",
        lastReadOn: "2026-07-30",
        readPaydays: 5,
        readCents: 523_500,
        shortCents: 523_500,
        paidOutside: [],
        neverBankedCents: 523_500,
      });
      expect(note!.body).toBe(
        "It America LLC (weekly pay)'s paydays over Jul 2 – 30, 2026 came to $5,235.00, and none of it reached a bank.",
      );
    });

    test("paydays after the checked day are named as not looked for (decision 65), never as unbanked", () => {
      const [note] = august({ unlookedPaydays: 2 });
      expect(note!.body).toContain(
        " never reached a bank; 2 more paydays in the window fall after 2026-09-24, the last day every account that " +
          "pay lands in has been checked through — so the ledger has not looked for their deposits.",
      );
      const [one] = august({ unlookedPaydays: 1 });
      expect(one!.body).toContain(
        "; 1 more payday in the window falls after 2026-09-24, the last day every account that pay lands in has been " +
          "checked through — so the ledger has not looked for its deposit.",
      );
    });

    test("a payday a deposit paid before the window began was paid early (§6A 29)", () => {
      const [note] = august({
        firstReadOn: "2026-10-01",
        lastReadOn: "2026-10-08",
        readPaydays: 2,
        readCents: 228_384,
        shortCents: 228_384,
        paidOutside: [{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: 114_192, early: true }],
        neverBankedCents: 114_192,
      });
      expect(note!.body).toContain(
        "none of it was banked inside the window: $1,141.92 (Oct 1) was paid early, by the deposit of 2026-09-30 and " +
          "$1,141.92 never reached a bank.",
      );
    });

    test("several paydays one deposit paid, and paydays paid by several deposits, each named", () => {
      const [note] = august({
        paidOutside: [
          { depositOn: "2026-07-30", paydays: ["2026-08-06"], cents: 104_700, early: true },
          { depositOn: "2026-09-24", paydays: ["2026-08-20", "2026-08-27"], cents: 218_892, early: false },
        ],
        neverBankedCents: 104_700,
      });
      expect(note!.body).toContain(
        ": $1,047.00 (Aug 6) was paid early, by the deposit of 2026-07-30, $2,188.92 (Aug 20 and Aug 27) was paid by " +
          "the deposit of 2026-09-24, and $1,047.00 never reached a bank.",
      );
    });

    test("every read payday paid, some from outside the window: no 'never'", () => {
      const [note] = august({ bankedInsideCents: 314_100, shortCents: 114_192, neverBankedCents: 0 });
      expect(note!.body).toContain(
        "came to $4,282.92, of which $3,141.00 was banked inside the window and $1,141.92 (Aug 27) was paid by the " +
          "deposit of 2026-09-24.",
      );
      expect(note!.body).not.toContain("never");
    });

    test("a window banked in full inside itself says nothing new — September keeps its surplus note alone", () => {
      const out = notes({
        ...HIS,
        impliedCents: 456_768,
        bankedCents: 570_960,
        unbankedCents: -114_192,
        firstPeriodOn: "2026-09-03",
        lastPeriodOn: "2026-09-24",
        shortfall: {
          ...AUGUST,
          firstReadOn: "2026-09-03",
          lastReadOn: "2026-09-24",
          readCents: 456_768,
          bankedInsideCents: 570_960,
          shortCents: 0,
          paidOutside: [],
          neverBankedCents: 0,
        },
      });
      expect(out.map((n) => n.id)).toEqual(["cash-earnings-catchup-It America LLC (weekly pay)"]);
    });

    test("a window that banked what its read paydays came to is not short, whoever paid them", () => {
      // Oct 1 paid early by Sep 30 and Oct 8 by Oct 7, with $1,141.92 more banked inside: nothing is short, net
      expect(
        august({
          readCents: 228_384,
          bankedInsideCents: 228_384,
          shortCents: 0,
          paidOutside: [{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: 114_192, early: true }],
          neverBankedCents: 0,
        }),
      ).toEqual([]);
    });

    /*
     * 🔴 Review of 2a415d5 (MEDIUM): this read "of which $1,541.92 was banked inside the window ($400.00 of it, …, went
     * toward no payday) and $741.92 (Oct 1) was paid early, by the deposit of 2026-09-30" — a deposit that paid
     * $1,141.92, given the net shortfall, where /budgets' fourth figure says $1,141.92 paid early.
     */
    test("outside money that paid MORE than the net shortfall keeps its own figure; what is left over is named", () => {
      // Oct 1 paid early by Sep 30, Oct 8 by Oct 7, and $400.00 on Oct 9 that paid no payday: short only $741.92, net
      const [note] = august({
        firstReadOn: "2026-10-01",
        lastReadOn: "2026-10-08",
        readPaydays: 2,
        readCents: 228_384,
        bankedInsideCents: 114_192,
        shortCents: 74_192,
        paidOutside: [{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: 114_192, early: true }],
        neverBankedCents: 0,
        noPaydayBeyondCents: 40_000,
        towardNoPayday: [{ depositOn: "2026-10-09", cents: 40_000 }],
      });
      expect(note!.body).toBe(
        "It America LLC (weekly pay)'s paydays over Oct 1 – 8, 2026 came to $2,283.84, of which $1,141.92 was banked " +
          "inside the window and $1,141.92 (Oct 1) was paid early, by the deposit of 2026-09-30; another $400.00 " +
          "banked inside the window, from the deposit of 2026-10-09, went toward no payday.",
      );
    });

    /*
     * ⛔ Each deposit day named once: the part after the split says "the same deposit" of the days the banked figure's
     * parenthesis named. 🔴 Both parts named every day — "from the deposits of A and B" twice (review of the shortfall
     * batch): the money is not divided between the days, so the second naming said nothing new.
     */
    test("money that paid no payday, split between the payday it nets and the rest: its days named once", () => {
      // Aug 6 paid by Sep 24 from outside, Aug 13 by no deposit, and $1,500.00 on Aug 14 that paid no payday: it nets
      // Aug 13's $1,047.00, and the other $453.00 has no unpaid payday left to net
      const split = {
        firstReadOn: "2026-08-06",
        lastReadOn: "2026-08-13",
        readPaydays: 2,
        readCents: 209_400,
        bankedInsideCents: 104_700,
        noPaydayInsideCents: 104_700,
        shortCents: 59_400,
        paidOutside: [{ depositOn: "2026-09-24", paydays: ["2026-08-06"], cents: 104_700, early: false }],
        neverBankedCents: 0,
        noPaydayBeyondCents: 45_300,
        towardNoPayday: [{ depositOn: "2026-08-14", cents: 150_000 }],
      };
      const [note] = august(split);
      expect(note!.body).toBe(
        "It America LLC (weekly pay)'s paydays over Aug 6 – 13, 2026 came to $2,094.00, of which $1,047.00 was " +
          "banked inside the window ($1,047.00 of it, from the deposit of 2026-08-14, went toward no payday) and " +
          "$1,047.00 (Aug 6) was paid by the deposit of 2026-09-24; another $453.00 banked inside the window, from " +
          "the same deposit, went toward no payday.",
      );
      // …and of two days, each once
      const [two] = august({
        ...split,
        towardNoPayday: [
          { depositOn: "2026-08-14", cents: 100_000 },
          { depositOn: "2026-08-15", cents: 50_000 },
        ],
      });
      expect(two!.body.match(/2026-08-14/g)).toHaveLength(1);
      expect(two!.body).toContain(
        "($1,047.00 of it, from the deposits of 2026-08-14 and 2026-08-15, went toward no payday)",
      );
      expect(two!.body).toContain("another $453.00 banked inside the window, from the same deposits, went toward");
    });

    test("money that paid no payday and nets no payday is named by its days, once, after the split", () => {
      const [note] = august({
        firstReadOn: "2026-08-06",
        lastReadOn: "2026-08-06",
        readPaydays: 1,
        readCents: 104_700,
        bankedInsideCents: 0,
        noPaydayInsideCents: 0,
        shortCents: 0,
        paidOutside: [{ depositOn: "2026-09-24", paydays: ["2026-08-06"], cents: 104_700, early: false }],
        neverBankedCents: 0,
        noPaydayBeyondCents: 45_300,
        towardNoPayday: [{ depositOn: "2026-08-14", cents: 45_300 }],
      });
      expect(note!.body).toContain("another $453.00 banked inside the window, from the deposit of 2026-08-14, went");
    });

    test("money that paid another window's payday is named after the split — late, or early (§6A 29)", () => {
      const AHEAD = { depositOn: "2026-09-30", paydays: ["2026-10-01", "2026-10-08"], cents: 228_384, early: true };
      const across = (early: boolean) =>
        august({
          readCents: 456_768,
          bankedInsideCents: 342_576,
          shortCents: 114_192,
          paidOutside: [],
          neverBankedCents: 114_192,
          paidAcross: [
            { depositOn: "2026-09-03", paydays: ["2026-08-27"], cents: 114_192, early: false },
            ...(early ? [AHEAD] : []),
          ],
        })[0]!.body;
      expect(across(false)).toContain(
        "and $1,141.92 never reached a bank; another $1,141.92 banked inside the window, from the deposit of " +
          "2026-09-03, paid Aug 27's payday.",
      );
      // "none of them" of the lead's four paydays — of one, "that payday" (the test of Sep 21 – 27 below)
      expect(across(true)).toContain(
        "; another $3,425.76 banked inside the window paid none of them: $1,141.92, from the deposit of 2026-09-03, " +
          "paid Aug 27's payday and $2,283.84, from the deposit of 2026-09-30, paid the paydays of Oct 1 and Oct 8 " +
          "early.",
      );
    });

    test("no read payday, no note — a window of unread paydays is the forecast's to name", () => {
      const unread = { readPaydays: 0, readCents: 0, firstReadOn: null, lastReadOn: null, paidOutside: [] };
      expect(august({ ...unread, shortCents: 0, neverBankedCents: 0, unlookedPaydays: 2 })).toEqual([]);
    });

    /*
     * 🔴 Review of 36f212f on the integration (MEDIUM): his ledger copy, checked through Thu Sep 24, with Wed Sep 30's
     * $1,141.92 returned on Fri Oct 2 — October and Q4 read "It America LLC (weekly pay)'s paydays came to $0.00, and
     * none of it reached a bank; 2 more paydays …" (re-measured 2026-10-21). With a Wed Oct 7 payroll imported past the
     * statement instead, October and Q4 said nothing of the $1,141.92 the year nets. ⛔ The shortfall sentence needs a
     * read payday; a window with none names the money a window over it counts, and nothing else.
     */
    const UNREAD = { readPaydays: 0, readCents: 0, firstReadOn: null, lastReadOn: null, paidOutside: [] };

    test("no read payday: never 'came to $0.00', whatever short figure it is handed", () => {
      const out = august({ ...UNREAD, shortCents: 114_192, neverBankedCents: 114_192, unlookedPaydays: 2 });
      expect(out.map((n) => n.body).join(" ")).not.toContain("came to $0.00");
      expect(out).toEqual([]);
    });

    test("no read payday, money that went back out: named on its day, beside the paydays not looked for", () => {
      const out = august({
        ...UNREAD,
        shortCents: 0,
        neverBankedCents: 0,
        unlookedPaydays: 1,
        wentBackOut: [{ postedOn: "2026-10-02", cents: 114_192 }],
      });
      expect(out).toEqual([
        {
          id: "cash-earnings-unread-It America LLC (weekly pay)",
          body:
            "Of It America LLC (weekly pay)'s pay, $1,141.92 went back out on 2026-10-02; 1 payday in the window " +
            "falls after 2026-09-24, the last day every account that pay lands in has been checked through — so the " +
            "ledger has not looked for its deposit.",
        },
      ]);
    });

    test("no read payday, money that paid its own payday past the checked day: named — the year nets it", () => {
      const october = {
        ...UNREAD,
        shortCents: 0,
        neverBankedCents: 0,
        otherBeyondCents: 114_192,
        paidUnread: [{ depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: 114_192 }],
      };
      expect(august(october).map((n) => n.body)).toEqual([
        "Of It America LLC (weekly pay)'s pay, $1,141.92 banked inside the window, from the deposit of 2026-10-07, " +
          "paid Oct 8's payday.",
      ]);
      // …and where the surplus note speaks, it names the window's money itself
      const surplus = notes({
        ...HIS,
        impliedCents: 0,
        bankedCents: 114_192,
        unbankedCents: -114_192,
        firstPeriodOn: null,
        lastPeriodOn: null,
        shortfall: { ...AUGUST, ...october },
      });
      expect(surplus.map((n) => n.id)).toEqual(["cash-earnings-catchup-It America LLC (weekly pay)"]);
      // …and an unchecked account reads nothing anywhere, so no window over this one nets it
      expect(notes({ ...HIS, checkedThrough: null, shortfall: { ...AUGUST, ...october } })).toEqual([]);
      // the payday it paid is named with no more than the money beyond the read paydays
      const [capped] = august({ ...october, otherBeyondCents: 50_000, unlookedPaydays: 1 });
      expect(capped!.body).toContain(
        "$500.00 banked inside the window, from the deposit of 2026-10-07, paid Oct 8's payday;",
      );
    });

    test("no read payday, money for a payday no window reads: named with it — early unless before the window", () => {
      // 🔴 Review of f6da264: "…$1,141.92 banked inside the window went toward no payday on or before 2026-09-24" of
      // money the settlement says paid Thu Oct 15 early (his ledger copy 2026-10-21, on payroll Wednesdays)
      const october = {
        ...UNREAD,
        shortCents: 0,
        neverBankedCents: 0,
        otherBeyondCents: 3 * 114_192 + 35_808,
        paidUnread: [{ depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: 114_192 }],
        paidUncounted: [
          { depositOn: "2026-10-07", paydays: ["2026-10-01"], cents: 114_192, early: false },
          { depositOn: "2026-10-14", paydays: ["2026-10-15"], cents: 114_192, early: true },
        ],
      };
      expect(august(october).map((n) => n.body)).toEqual([
        "Of It America LLC (weekly pay)'s pay, $2,283.84 banked inside the window, from the deposit of 2026-10-07, " +
          "paid the paydays of Oct 1 and Oct 8, $1,141.92 banked inside the window, from the deposit of 2026-10-14, " +
          "paid Oct 15's payday early, and $358.08 banked inside the window was more than the paydays its deposits " +
          "paid came to.",
      ]);
      // each part capped at what is left of the money beyond the read paydays, in that order — and none for change
      const [capped] = august({ ...october, otherBeyondCents: 250_000 });
      expect(capped!.body).toBe(
        "Of It America LLC (weekly pay)'s pay, $2,283.84 banked inside the window, from the deposit of 2026-10-07, " +
          "paid the paydays of Oct 1 and Oct 8 and $216.16 banked inside the window, from the deposit of 2026-10-14, " +
          "paid Oct 15's payday early.",
      );
    });

    test("a read payday a deposit inside paid, then money out on a day of its own: the payday stays banked", () => {
      // his Sep 21 – 27 with $1,141.92 back out on Fri Sep 25: Sep 23's lump paid Sep 24, as the calendar draws it
      const [note] = august({
        readPaydays: 1,
        firstReadOn: "2026-09-24",
        lastReadOn: "2026-09-24",
        readCents: 114_192,
        bankedInsideCents: 114_192,
        shortCents: 0,
        paidOutside: [],
        neverBankedCents: 0,
        paidAcross: [
          {
            depositOn: "2026-09-23",
            paydays: ["2026-09-03", "2026-09-10", "2026-09-17"],
            cents: 342_576,
            early: false,
          },
          { depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: 114_192, early: false },
        ],
        wentBackOut: [{ postedOn: "2026-09-25", cents: 114_192 }],
      });
      // 🔴 it read "came to $1,141.92, and none of it reached a bank" — the return netted away the payday it paid
      // 🔴 …and "paid none of them" of the one payday its lead names (review of batch 6; the week of Sep 21 – 27 on his
      // ledger copy 2026-10-29 with the Sep 25 return and Wells Fargo derived through Oct 16)
      expect(note!.body).toBe(
        "It America LLC (weekly pay)'s payday on Sep 24, 2026 came to $1,141.92, and all of it was banked inside " +
          "the window; another $4,567.68 banked inside the window did not pay that payday: $3,425.76, from the " +
          "deposit of 2026-09-23, paid the paydays of Sep 3, Sep 10, and Sep 17 and $1,141.92, from the deposit of " +
          "2026-09-24, paid Aug 27's payday; $1,141.92 went back out on 2026-09-25.",
      );
      expect(note!.body).not.toContain("none of them");
    });

    test("a read payday paid from outside, and its own money for a payday past the checked day: named", () => {
      // checked through Thu Oct 1: Sep 30 paid Oct 1 early, Oct 7 paid Oct 8 — which the year nets, as the dashboard
      const out = notes({
        ...HIS,
        checkedThrough: "2026-10-01",
        impliedCents: 342_576,
        bankedCents: 114_192,
        unbankedCents: 228_384,
        firstPeriodOn: "2026-10-01",
        lastPeriodOn: "2026-10-15",
        shortfall: {
          ...AUGUST,
          readPaydays: 1,
          firstReadOn: "2026-10-01",
          lastReadOn: "2026-10-01",
          readCents: 114_192,
          bankedInsideCents: 0,
          shortCents: 0,
          paidOutside: [{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: 114_192, early: true }],
          neverBankedCents: 0,
          otherBeyondCents: 114_192,
          unlookedPaydays: 1,
          paidUnread: [{ depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: 114_192 }],
        },
      });
      expect(out.map((n) => n.body)).toEqual([
        "It America LLC (weekly pay)'s payday on Oct 1, 2026 came to $1,141.92, and none of it was banked inside " +
          "the window: $1,141.92 (Oct 1) was paid early, by the deposit of 2026-09-30; another $1,141.92 banked " +
          "inside the window, from the deposit of 2026-10-07, paid Oct 8's payday; 1 more payday in the window falls " +
          "after 2026-10-01, the last day every account that pay lands in has been checked through — so the ledger " +
          "has not looked for its deposit.",
      ]);
    });

    test("a stale series keeps the note it has — never both", () => {
      const out = notes({
        shortfall: { ...AUGUST, readCents: 523_000, shortCents: 523_000, neverBankedCents: 523_000, paidOutside: [] },
      });
      expect(out.map((n) => n.id)).toEqual(["cash-earnings-unbanked-Cash job (weekly pay)"]);
    });

    test("…but a stale series whose unbanked note holds back (too few quiet READ paydays) still names the shortfall", () => {
      const out = notes({
        checkedThrough: "2026-08-12",
        periodsCovered: 5,
        checkedPeriodsCovered: 5,
        checkedPeriodsSinceBanked: 2,
        shortfall: {
          ...AUGUST,
          readCents: 523_000,
          bankedInsideCents: 313_600,
          shortCents: 209_400,
          paidOutside: [],
          neverBankedCents: 209_400,
        },
      });
      expect(out.map((n) => n.id)).toEqual(["cash-earnings-shortfall-Cash job (weekly pay)"]);
    });

    test("no confirmed schedule, no note, whatever the figures say", () => {
      expect(august().length).toBe(1);
      expect(notes({ ...HIS, basis: "no-series", shortfall: AUGUST })).toEqual([]);
    });
  });

  /*
   * 🔴 Review of a4b0fca: the surplus note called ALL of a window's surplus "earlier pay arriving late — … a backlog
   * clearing", though with payroll landing the Wednesday before the Thursday it pays (§6A 29) September's Wed Sep 30
   * pays Thu Oct 1 — and October's shortfall note names the same $1,141.92 "paid early, by the deposit of" Sep 30.
   * ⚖️ Decisions 29/32 name it from the payday's side: paid early. The rows carry `payShortfall`'s `paidAhead`.
   */
  describe("the surplus note splits its surplus by where the money went", () => {
    const HIS = {
      seriesName: "It America LLC (weekly pay)",
      basis: "series-live" as const,
      impliedCents: 456_768,
      lastBankedOn: "2026-09-30",
      periodsSinceBanked: 0,
      firstPeriodOn: "2026-09-03",
      lastPeriodOn: "2026-09-24",
      checkedThrough: "2026-10-10",
      checkedPeriodsSinceBanked: 0,
    };
    const SETTLED: PayShortfall = {
      readPaydays: 4,
      firstReadOn: "2026-09-03",
      lastReadOn: "2026-09-24",
      readCents: 456_768,
      bankedInsideCents: 456_768,
      noPaydayInsideCents: 0,
      shortCents: 0,
      paidOutside: [],
      neverBankedCents: 0,
      notBankedYetCents: 0,
      notBankedYetPaydays: [],
      paidAcross: [],
      noPaydayBeyondCents: 0,
      otherBeyondCents: 0,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
      paidUnread: [],
      paidUncounted: [],
      wentBackOut: [],
      bankedCents: 456_768,
    };
    const surplus = (surplusCents: number, over: Partial<PayShortfall> = {}, row: object = {}) =>
      notes({
        ...HIS,
        bankedCents: HIS.impliedCents + surplusCents,
        unbankedCents: -surplusCents,
        shortfall: { ...SETTLED, bankedCents: HIS.impliedCents + surplusCents, ...over },
        ...row,
      }).map((n) => n.body);

    test("money that paid a later window's payday early is named so — not a backlog clearing", () => {
      const paidAhead = [{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: 114_192 }];
      expect(surplus(114_192, { paidAhead })).toEqual([
        "It America LLC (weekly pay) banked $1,141.92 more than its paydays over Sep 3 – 24, 2026 came to. $1,141.92 of " +
          "it, from the deposit of 2026-09-30, paid Oct 1's payday early.",
      ]);
    });

    test("part paid ahead, the rest earlier pay arriving late — the two add up to the surplus", () => {
      // Sep 23 – Sep 23 on his ledger: the $4,567.68 lump paid Thu Sep 24, after the window, and three weeks before it
      const body = surplus(
        456_768,
        {
          paidAhead: [{ depositOn: "2026-09-23", paydays: ["2026-09-24"], cents: 114_192 }],
          paidAcross: [
            {
              depositOn: "2026-09-23",
              paydays: ["2026-09-03", "2026-09-10", "2026-09-17"],
              cents: 3 * 114_192,
              early: false,
            },
          ],
        },
        { impliedCents: 0, bankedCents: 456_768, firstPeriodOn: null, lastPeriodOn: null },
      );
      expect(body).toEqual([
        "It America LLC (weekly pay) banked $4,567.68 in a window where none of its paydays has passed. $1,141.92 of " +
          "it, from the deposit of 2026-09-23, paid Sep 24's payday early. One deposit can bank several paydays at " +
          "once, so the other $3,425.76 is earlier pay arriving late — read it as a backlog clearing rather than as a " +
          "period that earned more.",
      ]);
    });

    test("money that paid no payday is named in the calendar's words, never as earlier pay", () => {
      // Jun 5 – Jun 5 on his ledger: the $400.00 that found Jun 4 paid and reached no other payday (§6A 55b)
      const body = surplus(
        40_000,
        { towardNoPayday: [{ depositOn: "2026-06-05", cents: 40_000 }] },
        { impliedCents: 0, bankedCents: 40_000, firstPeriodOn: null, lastPeriodOn: null },
      );
      expect(body).toEqual([
        "It America LLC (weekly pay) banked $400.00 in a window where none of its paydays has passed. $400.00 of it, " +
          "from the deposit of 2026-06-05, went toward no payday.",
      ]);
    });

    /*
     * 🔴 Review of 2a415d5: this read "banked $500.00 more than its paydays over Sep 3 – 24, 2026 came to. $500.00 of
     * it, from the deposit of 2026-09-30, paid Oct 1's payday early." — a deposit that paid $1,141.92, and the window's
     * own $641.92 short of its paydays never said. Taken out of the window's money (`paidAcross`), Sep 30's $1,141.92
     * leaves a shortfall, and the shortfall note names both.
     */
    test("a window short of its own paydays that paid a later one early: the shortfall note alone, naming it", () => {
      const paidAhead = [{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: 114_192 }];
      const out = surplus(50_000, {
        bankedInsideCents: 392_576,
        shortCents: 64_192,
        neverBankedCents: 64_192,
        paidAcross: [{ ...paidAhead[0]!, early: true }],
        paidAhead,
      });
      expect(out).toEqual([
        "It America LLC (weekly pay)'s paydays over Sep 3 – 24, 2026 came to $4,567.68, of which $3,925.76 was " +
          "banked inside the window and $641.92 never reached a bank; another $1,141.92 banked inside the window, " +
          "from the deposit of 2026-09-30, paid Oct 1's payday early.",
      ]);
    });

    test("several paydays paid ahead, by several deposits, each named", () => {
      const [body] = surplus(228_384, {
        paidAhead: [
          { depositOn: "2026-09-29", paydays: ["2026-10-01"], cents: 114_192 },
          { depositOn: "2026-09-30", paydays: ["2026-10-08"], cents: 114_192 },
        ],
      });
      expect(body).toContain(
        "$2,283.84 of it, from the deposits of 2026-09-29 and 2026-09-30, paid the paydays of Oct 1 and Oct 8 early.",
      );
    });

    test("all of it earlier pay keeps the sentence it always had", () => {
      // his September: Sep 24's deposit paid Aug 27, a payday before the window
      const late = [{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: 114_192, early: false }];
      expect(surplus(114_192, { paidAcross: late })).toEqual([
        "It America LLC (weekly pay) banked $1,141.92 more than its paydays over Sep 3 – 24, 2026 came to. One deposit " +
          "can bank several paydays at once, so the surplus is earlier pay arriving late — read it as a backlog " +
          "clearing rather than as a period that earned more.",
      ]);
    });

    /*
     * ⚖️ Default built, not asked (2026-10-21): money that paid no payday before the period is no earlier pay — change
     * over the paydays its deposits paid is said as that (`MORE_THAN_ITS_PAYDAYS`), as a period with no read payday
     * says it. 🔴 Wed Oct 7's $1,500.00 paying Oct 8: the week called its $358.08 "earlier pay arriving late" while
     * October said it "went toward no payday on or before" the checked day (review of the shortfall batch).
     */
    test("change over the paydays a deposit paid is said as that, never as earlier pay", () => {
      expect(surplus(35_808, {}, { firstPeriodOn: "2026-10-08", lastPeriodOn: "2026-10-08" })).toEqual([
        "It America LLC (weekly pay) banked $358.08 more than its payday on Oct 8, 2026 came to. $358.08 of it was " +
          "more than the paydays its deposits paid came to.",
      ]);
      // …and beside earlier pay, each part with its own words — they add up to the surplus
      const late = [{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: 114_192, early: false }];
      expect(surplus(150_000, { paidAcross: late })).toEqual([
        "It America LLC (weekly pay) banked $1,500.00 more than its paydays over Sep 3 – 24, 2026 came to. $358.08 of " +
          "it was more than the paydays its deposits paid came to. One deposit can bank several paydays at once, so " +
          "the other $1,141.92 is earlier pay arriving late — read it as a backlog clearing rather than as a period " +
          "that earned more.",
      ]);
    });
  });
});

describe("categoryCountLabel", () => {
  const leaf = (txnCount: number) => ({ txnCount, children: [] });

  test("a category holding rows itself reads as a count", () => {
    expect(categoryCountLabel(leaf(1882))).toEqual({ text: "1,882 txn", title: null });
  });

  test("a genuinely empty category reads as an em dash", () => {
    expect(categoryCountLabel(leaf(0))).toEqual({ text: "—", title: null });
  });

  /*
   * The pair that made this necessary: the note above the list says "2
   * categories hold no transactions" from SUBTREE counts, while the rows showed
   * a bare em dash from DIRECT ones. Subscriptions is the live example — zero
   * of its own, 259 across three children.
   */
  test("a parent whose children hold rows is not empty, and does not read as empty", () => {
    const label = categoryCountLabel({ txnCount: 0, children: [leaf(95), leaf(147), leaf(17)] });
    expect(label.text).toBe("none direct");
    expect(label.title).toBe("259 transactions sit in its subcategories");
  });

  test("a parent with one child transaction reads in the singular", () => {
    expect(categoryCountLabel({ txnCount: 0, children: [leaf(1)] }).title).toBe(
      "1 transaction sits in its subcategories",
    );
  });

  /* A parent that files rows of its OWN still reports them, children or not —
     the count cell is about this row, and the subcategories have their own. */
  test("a parent with both reports its own count", () => {
    expect(categoryCountLabel({ txnCount: 7, children: [leaf(16)] }).text).toBe("7 txn");
  });

  /**
   * 🔴 …AND SAYS WHICH COUNT IT IS. The cell is a DIRECT count and the row
   * links to a page that counts the SUBTREE, so `Housing · 7 txn` opened a page
   * reading "34 transactions". The zero case already carried this
   * disambiguation; the nonzero case did not, and it was invisible only because
   * the link used to land on an empty current month instead.
   */
  test("a parent with both names the population, so its link cannot surprise", () => {
    expect(categoryCountLabel({ txnCount: 7, children: [leaf(16), leaf(11)] }).title).toBe(
      "7 filed directly here; 27 more sit in its subcategories",
    );
  });

  test("one row in one child reads in the singular", () => {
    expect(categoryCountLabel({ txnCount: 2, children: [leaf(1)] }).title).toBe(
      "2 filed directly here; 1 more sits in its subcategories",
    );
  });

  test("a leaf, or a parent whose children are empty, has nothing to disambiguate", () => {
    expect(categoryCountLabel(leaf(1882)).title).toBeNull();
    expect(categoryCountLabel({ txnCount: 5, children: [leaf(0)] }).title).toBeNull();
  });
});
