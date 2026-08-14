import { isStaleClose } from "./holding-price-age";
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
  // /categories row copy — owned by CategoryRow, and now sharing a page with a
  // note for the first time
  "Archived",
  "Locked",
] as const;

/**
 * How a note punctuates a list of category names, and how it punctuates a path.
 *
 * Named rather than inlined because both are only unambiguous while a category
 * name cannot contain them — a note that states a COUNT and then joins names
 * with ", " contradicts its own list the moment one name has a comma in it
 * ("2 categories hold no transactions: Food, Drink, Pets" says two, lists
 * three). `FORBIDDEN_NAME_CHARS` in `services/category-edit` is what makes that
 * impossible, and `section-notes.test.ts` asserts the two agree, so changing a
 * separator here fails the build rather than silently reopening the ambiguity.
 */
export const NAME_LIST_SEPARATOR = ", ";
export const PATH_SEPARATOR = " > ";

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
    const names = overdue.map((r) => r.categoryPath).join(NAME_LIST_SEPARATOR);
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

export interface HoldingPriceNoteInput {
  /** one entry per ACTIVE holding with a live quantity */
  rows: readonly { quotedOn: string | null }[];
  /** today, so staleness is a subtraction and never a projection */
  today: string;
  /** inclusive day count between two ISO dates */
  daysBetween: (from: string, to: string) => number;
  formatDay: (iso: string) => string;
}

/**
 * How old the closes behind this page's market value are.
 *
 * This is the one thing /investments knows and never says. Its own staleness
 * disclosures cover a different question: `SessionNote` describes today's
 * intraday session and is mounted only on the 1D range, and the holdings table
 * discloses holdings with NO price. A holding priced a week ago is neither —
 * it is priced, and the number is simply old.
 *
 * ⚠️ The wording turns on min vs max deliberately. Saying "every position" over
 * a `max()` would be a FALSE statement about the stalest rows the moment one
 * symbol lags (a delisting, a partial backfill, a provider gap). When the dates
 * disagree the note anchors on the OLDEST and says so.
 */
export function holdingPriceSectionNotes(input: HoldingPriceNoteInput): SectionNote[] {
  const dates = input.rows.map((r) => r.quotedOn).filter((d): d is string => d !== null);
  // Nothing priced at all is the holdings table's story, not this one, and an
  // empty portfolio must never produce "priced 0 days ago".
  if (dates.length === 0) return [];

  const oldest = dates.reduce((a, b) => (b < a ? b : a));
  const newest = dates.reduce((a, b) => (b > a ? b : a));
  // Priced through today: there is no gap, so there is nothing to report.
  //
  // Gated on the NEWEST close, which means ONE freshly-priced symbol silences
  // this whole note while other rows are still stale. That is deliberate for a
  // one-sentence page summary — and it is why each row also prints its own
  // date (see ./holding-price-age.ts). `isStaleClose` is shared with those rows
  // so the two can never disagree about where the boundary is.
  if (!isStaleClose(newest, input.today, input.daysBetween)) return [];

  const age = input.daysBetween(oldest, input.today);
  const uniform = oldest === newest;
  return [
    {
      id: "investments-price-age",
      body:
        (uniform
          ? `Every position on this page still carries its close from ${input.formatDay(oldest)}`
          : `The oldest close behind these figures is from ${input.formatDay(oldest)}`) +
        ` — ${age} ${age === 1 ? "day" : "days"} ago. Market value and allocation are computed from ` +
        `stored closes, not from a live quote, so use Refresh prices before reading them as current.`,
    },
  ];
}

export interface CategoryNoteInput {
  /** every category, with the count of transactions in its OWN subtree */
  rows: readonly {
    /** display path — "Fees > Card Annual Fees", so a leaf is never confused with a root */
    path: string;
    subtreeTxnCount: number;
    isArchived: boolean;
    /**
     * LIVE children only. A parent whose only children are archived IS a leaf —
     * counting archived children would hide it from this note forever.
     */
    hasLiveChildren: boolean;
    /** false for transfer/system/import-hint rows: the archive guard refuses them */
    isEditable: boolean;
    /** a recurring series points here via `user_category_id` */
    hasScheduledSeries: boolean;
  }[];
}

/** Named individually up to here; beyond it the note gives a count and examples. */
const MAX_NAMED_CATEGORIES = 4;

/**
 * Flatten the category manager's roots-with-children into the rows this note
 * reads. Generic over the node shape so it stays testable without reaching for
 * the service layer.
 *
 * Three things here are each a place a bug hides, which is why this is not left
 * inline in the page:
 * - a root's subtree count is its own plus its children's; the per-row count is
 *   direct-only, so summing is what stops `Investments` (0 of its own, 2,066
 *   below it) from reading as empty;
 * - `hasLiveChildren` ignores ARCHIVED children, because `listCategoryTree`
 *   filters children by parentId alone — a root whose only child is archived is
 *   a leaf in every sense the reader cares about, and counting the archived one
 *   would hide it from this note permanently;
 * - the path is what the note prints, and a bare leaf name ("Interest Charges")
 *   is not something the reader can find in a two-level manager.
 *
 * The schema nests exactly one level (enforced in createCategory/moveCategory),
 * so a child is always a leaf.
 */
export function categoryNoteRows<T extends { id: string; name: string; isArchived: boolean; isEditable: boolean }>(
  roots: readonly (T & { children: readonly T[] })[],
  scheduledIds: ReadonlySet<string>,
  /**
   * Rows touching a category. Passed in rather than read off the tree node: the
   * manager's own `txnCount` counts ACTIVE PARENT rows only, which misses
   * `excluded` rows (money still moved) and split parts (attributed through
   * `transaction_splits`, so a category holding only a minor split leg reads
   * zero while /spending shows spend for it). See `categoryTouchCounts`.
   */
  txnCountOf: (categoryId: string) => number,
): CategoryNoteInput["rows"] {
  return roots.flatMap((root) => [
    {
      path: root.name,
      subtreeTxnCount: txnCountOf(root.id) + root.children.reduce((sum, c) => sum + txnCountOf(c.id), 0),
      isArchived: root.isArchived,
      hasLiveChildren: root.children.some((c) => !c.isArchived),
      isEditable: root.isEditable,
      hasScheduledSeries: scheduledIds.has(root.id),
    },
    ...root.children.map((child) => ({
      path: `${root.name}${PATH_SEPARATOR}${child.name}`,
      subtreeTxnCount: txnCountOf(child.id),
      isArchived: child.isArchived,
      hasLiveChildren: false,
      isEditable: child.isEditable,
      hasScheduledSeries: scheduledIds.has(child.id),
    })),
  ]);
}

/**
 * The one thing the category manager cannot show per row: which categories are
 * holding nothing.
 *
 * Counts are SUBTREE counts, deliberately. The per-row figure is direct-only, so
 * a parent whose children hold thousands of transactions reads zero — calling
 * that one empty would be a claim about money that plainly exists.
 *
 * ⚠️ This note NAMES the categories and refuses to conclude anything about them,
 * and both halves of that were forced by measurement rather than chosen. On the
 * real ledger the ungated version flagged four, and the reasons they were empty
 * were not the same reason:
 *
 * - `Car > Car Insurance` carried a CONFIRMED −$361.49 monthly bill that had not
 *   charged yet. Scheduled, not idle — excluded here by `hasScheduledSeries`.
 * - `Fees > Card Annual Fees` was empty while a −$95.00 ANNUAL MEMBERSHIP FEE
 *   posted every March, filed on the PARENT `Fees`. Empty because of a
 *   categorisation gap, not disuse — and no predicate available here can tell
 *   that apart from genuine disuse, because the evidence lives in rows that
 *   point somewhere else entirely.
 * - `Fees > Interest Charges` and `Utilities > Water/Gas` really were unused.
 *
 * Three explanations, one observable state. So the note reports the state, names
 * the rows so the reader can apply the knowledge it does not have, and states
 * the ambiguity instead of resolving it. It deliberately does NOT say archiving
 * is safe — the page header already says that, and a note repeating its own
 * page says the same thing twice in two voices.
 */
export function categorySectionNotes(input: CategoryNoteInput): SectionNote[] {
  // The population is the set where archiving is even the right question, and
  // numerator and denominator are drawn from it alike — a count gated one way
  // and framed against a differently-gated total is how a true sentence becomes
  // a false one.
  // Never assert a measured zero (the rule at the top of this file). On a ledger
  // with nothing imported yet EVERY category holds nothing, and the note would
  // greet a first-run install by listing its own seeded taxonomy back at it and
  // offering a two-way explanation where neither branch is the reason.
  if (input.rows.every((r) => r.subtreeTxnCount === 0)) return [];

  const candidates = input.rows.filter(
    (r) => !r.isArchived && !r.hasLiveChildren && r.isEditable && !r.hasScheduledSeries,
  );
  const empty = candidates.filter((r) => r.subtreeTxnCount === 0);
  if (empty.length === 0) return [];

  const named = empty
    .slice(0, MAX_NAMED_CATEGORIES)
    .map((r) => r.path)
    .join(NAME_LIST_SEPARATOR);
  const one = empty.length === 1;
  const lead = one
    ? `${named} holds no transactions.`
    : empty.length <= MAX_NAMED_CATEGORIES
      ? `${empty.length} categories hold no transactions: ${named}.`
      : `${empty.length} categories hold no transactions, including ${named}.`;

  return [
    {
      id: "categories-unused",
      body:
        `${lead} That can mean you do not use ${one ? "it" : "them"} — or that ` +
        `${one ? "its" : "their"} transactions are landing on another category, which is worth ` +
        `checking before archiving ${one ? "it" : "one"}.`,
    },
  ];
}
