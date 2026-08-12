import { describe, expect, test } from "vitest";
import {
  budgetSectionNotes,
  categorySectionNotes,
  RESERVED_NOTE_PHRASES,
  type SectionNote,
} from "./section-notes";

const row = (over: Partial<Parameters<typeof budgetSectionNotes>[0]["rows"][number]> = {}) => ({
  categoryPath: "Food",
  overdueCents: 0,
  uncoveredDays: 0,
  pace: "under" as const,
  ...over,
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
        row({ categoryPath: "Housing", overdueCents: 228_570 }),
        row({ categoryPath: "Subscriptions", overdueCents: 499 }),
        row({ categoryPath: "Food" }),
      ],
    });
    const overdue = notes.find((n) => n.id === "budgets-overdue")!;
    expect(overdue.body).toContain("2 bills");
    expect(overdue.body).toContain("$2,290.69");
    expect(overdue.body).toContain("Housing, Subscriptions");
  });

  test("reads singular for one overdue bill", () => {
    const notes = budgetSectionNotes({ rows: [row({ overdueCents: 1_000 })] });
    expect(notes[0]!.body).toContain("One bill");
    expect(notes[0]!.body).toContain("it yet");
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

  test("never states a projection or a verdict over an uncovered window", () => {
    const notes = budgetSectionNotes({ rows: [row({ uncoveredDays: 11 })] });
    const body = notes.map((n) => n.body).join(" ");
    expect(body).toMatch(/lower bounds/);
    expect(body).not.toMatch(/projected|on track|will be/i);
  });
});

describe("categorySectionNotes", () => {
  const cat = (over: Partial<Parameters<typeof categorySectionNotes>[0]["rows"][number]> = {}) => ({
    name: "Food",
    subtreeTxnCount: 10,
    isArchived: false,
    hasChildren: false,
    ...over,
  });

  test("a parent whose CHILDREN hold the transactions is never called unused", () => {
    // the defect this exists to prevent: the per-row count is direct-only, so
    // Investments reads 0 while its children hold thousands
    const notes = categorySectionNotes({
      rows: [
        cat({ name: "Investments", subtreeTxnCount: 0, hasChildren: true }),
        cat({ name: "Buys", subtreeTxnCount: 2_066 }),
      ],
    });
    expect(notes).toEqual([]);
  });

  test("counts only live, childless, never-used categories", () => {
    const notes = categorySectionNotes({
      rows: [
        cat({ name: "Gifts", subtreeTxnCount: 0 }),
        cat({ name: "Education", subtreeTxnCount: 0 }),
        cat({ name: "Old", subtreeTxnCount: 0, isArchived: true }),
        cat({ name: "Food", subtreeTxnCount: 500 }),
      ],
    });
    expect(notes[0]!.body).toContain("2 of 3 live categories");
  });

  test("says nothing when every category is in use", () => {
    expect(categorySectionNotes({ rows: [cat(), cat({ name: "Housing" })] })).toEqual([]);
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
      ],
    }),
    ...categorySectionNotes({ rows: [{ name: "Gifts", subtreeTxnCount: 0, isArchived: false, hasChildren: false }] }),
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
