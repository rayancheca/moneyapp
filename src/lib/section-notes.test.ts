import { describe, expect, test } from "vitest";
import {
  budgetSectionNotes,
  categorySectionNotes,
  holdingPriceSectionNotes,
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

  test("says nothing when every category is archived", () => {
    // the live set is empty, so there is no denominator to speak of
    expect(categorySectionNotes({ rows: [cat({ isArchived: true }), cat({ isArchived: true })] })).toEqual([]);
  });

  test("says nothing when every category is in use", () => {
    expect(categorySectionNotes({ rows: [cat(), cat({ name: "Housing" })] })).toEqual([]);
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
      ],
    }),
    ...categorySectionNotes({ rows: [{ name: "Gifts", subtreeTxnCount: 0, isArchived: false, hasChildren: false }] }),
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
