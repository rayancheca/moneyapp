import { describe, expect, test } from "vitest";
import { TAXONOMY } from "@/db/seed";
import { FORBIDDEN_NAME_CHARS } from "@/services/category-edit";
import {
  budgetSectionNotes,
  cashEarningsSectionNotes,
  categoryNoteRows,
  type CashEarningsNoteInput,
  categorySectionNotes,
  holdingPriceSectionNotes,
  NAME_LIST_SEPARATOR,
  PATH_SEPARATOR,
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
    ...over,
  });
  const notes = (over: Partial<CashEarningsNoteInput["rows"][number]> = {}) =>
    cashEarningsSectionNotes({ rows: [row(over)], formatDay });

  test("a silent schedule names the gap, the silence, and all three readings", () => {
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
    // all three explanations, because the module genuinely cannot choose
    expect(note!.body).toContain("held as cash");
    expect(note!.body).toContain("spent as cash");
    expect(note!.body).toContain("ended");
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
    expect(note!.body).toContain("no deposit has ever");
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

  test("banking MORE than the period earned reads as catching up, not as a windfall", () => {
    // June banked $1,447.00 in two deposits; a month that clears a backlog will
    // bank more than it earned, and without this the page looks like a raise.
    const [note] = notes({ basis: "series-live", bankedCents: 900_000, unbankedCents: -376_000 });
    expect(note!.id).toMatch(/^cash-earnings-catchup-/);
    expect(note!.body).toContain("$3,760.00");
    expect(note!.body).toContain("earlier");
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
});
