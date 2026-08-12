import { formatCents } from "./money";

/**
 * A section note is AUTHORED COPY selected by a MEASURED predicate, with every
 * figure rendered by the app's own formatter.
 *
 * This is the deliberate, shippable half of "insights". No model writes any part
 * of a note, so there is no channel through which an unsourced number or an
 * invented relationship can reach the page — the predicate is the only thing that
 * can be wrong, and a predicate is unit-testable in a way prose is not.
 *
 * (The model-written variant was designed and then rejected: its validator was
 * executed against 17 adversarial strings and accepted 16, because slot-based
 * checking constrains fabricated NUMBERS and says nothing about fabricated
 * RELATIONSHIPS — "X is your largest category" when it is third passes cleanly.)
 *
 * Two rules every predicate obeys, both inherited from how /budgets already
 * behaves:
 *
 * - **Withhold rather than estimate.** Where the ledger has not caught up, a note
 *   reports the gap and never a verdict or a projection over it.
 * - **Never assert a measured zero.** A predicate whose input is zero because
 *   nothing has been imported yet emits nothing at all.
 */
export interface SectionNote {
  /** stable across renders — used as the React key and as a dismissal id later */
  id: string;
  /** already formatted; safe to render as text */
  body: string;
}

/**
 * Phrases that already carry meaning elsewhere on these screens and are matched
 * by page-level e2e locators with exact counts. A note repeating one of them
 * would break an unrelated assertion and, worse, would say the same thing twice
 * in two voices.
 */
export const RESERVED_NOTE_PHRASES = [
  "On track",
  "Off pace",
  "Over budget",
  "rolled over",
  "expected by now, not imported",
  "expected before",
  "Awaiting statements",
] as const;

export interface BudgetNoteInput {
  /** one entry per active budget in the graded set */
  rows: readonly {
    categoryPath: string;
    overdueCents: number;
    uncoveredDays: number;
    pace: "under" | "at-risk" | "over";
  }[];
}

/**
 * What the /budgets page knows but no single row can say. Both notes are
 * cross-row summaries: each row already discloses its own overdue bill and its
 * own coverage gap, and neither states how much of the page is affected.
 */
export function budgetSectionNotes(input: BudgetNoteInput): SectionNote[] {
  const notes: SectionNote[] = [];

  const overdue = input.rows.filter((r) => r.overdueCents > 0);
  if (overdue.length > 0) {
    const total = overdue.reduce((sum, r) => sum + r.overdueCents, 0);
    const names = overdue.map((r) => r.categoryPath).join(", ");
    notes.push({
      id: "budgets-overdue",
      body:
        `${overdue.length === 1 ? "One bill" : `${overdue.length} bills`} totalling ` +
        `${formatCents(total)} came due this period and no import has covered ` +
        `${overdue.length === 1 ? "it" : "them"} yet — ${names}. That money is committed, so ` +
        `the room left is smaller than it looks.`,
    });
  }

  // A row is under-measured on the SAME rule the row itself uses: `over` is
  // exempt, because already exceeding the plan is a fact more data cannot undo.
  const uncovered = input.rows.filter((r) => r.uncoveredDays > 0 && r.pace !== "over");
  if (uncovered.length > 0) {
    const worst = uncovered.reduce((a, b) => (b.uncoveredDays > a.uncoveredDays ? b : a));
    notes.push({
      id: "budgets-coverage",
      body:
        `${uncovered.length} of ${input.rows.length} budgets are grading days the ledger has not ` +
        `reached — up to ${worst.uncoveredDays} ` +
        `${worst.uncoveredDays === 1 ? "day" : "days"} on ${worst.categoryPath}. Their spend and ` +
        `percentages are lower bounds, not measurements, so no verdict is shown for them.`,
    });
  }

  return notes;
}

export interface CategoryNoteInput {
  /** every category, with the count of transactions in its OWN subtree */
  rows: readonly { name: string; subtreeTxnCount: number; isArchived: boolean; hasChildren: boolean }[];
}

/**
 * The one thing the category manager cannot show per row: how much of the
 * taxonomy is doing nothing.
 *
 * Counts are SUBTREE counts, deliberately. The per-row figure is direct-only, so
 * a parent whose children hold thousands of transactions reads zero — calling
 * that one "unused" would be advice about money that plainly exists.
 */
export function categorySectionNotes(input: CategoryNoteInput): SectionNote[] {
  const live = input.rows.filter((r) => !r.isArchived);
  if (live.length === 0) return [];

  // a leaf with nothing in it, ever: safe to say, and the only actionable case
  const empty = live.filter((r) => !r.hasChildren && r.subtreeTxnCount === 0);
  if (empty.length === 0) return [];

  return [
    {
      id: "categories-unused",
      body:
        `${empty.length} of ${live.length} live categories have never had a transaction in them. ` +
        `Archiving one keeps its id and its history intact — nothing is deleted — so the pickers ` +
        `and reports get shorter without losing anything.`,
    },
  ];
}
