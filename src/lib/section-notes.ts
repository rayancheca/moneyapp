import { isStaleClose } from "./holding-price-age";
import { formatCents } from "./money";
import { dayWindowLabel } from "./period";
import { STALE_PERIODS, type CashEarningsBasis } from "./cash-earnings";
import { LAST_CHECKED_DAY } from "./unbanked-income";

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
    /**
     * How many BILLS make up `overdueCents` in this row — `BudgetTailSeries`
     * occurrences, not series, because a quarterly bill can be twice overdue.
     *
     * 🔴 Without this the note counted ROWS and called them bills. Measured on
     * the real ledger at today = 2026-09-16 it read "4 bills totalling
     * $3,467.60" over EIGHT: Car, Housing, Subscriptions and Utilities each
     * held two. The type could not express the difference, so no fixture over
     * it could catch it.
     */
    overdueBills: number;
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
    // Summed the same way `total` is — per row, not deduplicated. If a parent
    // and a child budget ever both claim one series, the money is double-counted
    // in the total already; a bill count that disagreed with it would be worse
    // than one that shares its arithmetic.
    const bills = overdue.reduce((sum, r) => sum + r.overdueBills, 0);
    const names = overdue.map((r) => r.categoryPath).join(NAME_LIST_SEPARATOR);
    /*
     * ⛔ The count and the LIST must be readable as the same claim. `names` has
     * one entry per BUDGET, and the bill count is routinely larger, so the
     * budget count is said out loud beside the names: every number in the
     * sentence can then be checked against something the reader can see. A bare
     * "8 bills — Car, Housing, Subscriptions, Utilities" invites the reader to
     * count four, which is the mis-read this module's header already names.
     */
    const where = bills === overdue.length ? names : `${overdue.length} budget${overdue.length === 1 ? "" : "s"}: ${names}`;
    notes.push({
      id: "budgets-overdue",
      body:
        `${bills === 1 ? "One bill" : `${bills} bills`} totalling ` +
        /*
         * ⛔ "DUE BY TODAY", not "came due". The overdue leg here closes on
         * `today` INCLUSIVE — deliberately, because it is the only leg that
         * checks postings, so a bill due today has to sit in it or `budgetTail`
         * would count it twice against `spentCents`. But that makes the past
         * tense false on the morning a bill falls due, and it read as a
         * contradiction of the runway card, which on the same day reports no
         * arrears at all. Both boundaries are right; only this sentence was
         * wrong. See `services/budgets.ts::budgetTail`.
         */
        `${formatCents(total)} due by today and no import has covered ` +
        `${bills === 1 ? "it" : "them"} yet — ${where}. That money is committed, so ` +
        `the room left is smaller than it looks.`,
    });
  }

  // A row is under-measured on the SAME rule the row itself uses: `over` is
  // exempt, because already exceeding the plan is a fact more data cannot undo.
  const uncovered = input.rows.filter((r) => r.uncoveredDays > 0 && r.pace !== "over");
  if (uncovered.length > 0) {
    const worst = uncovered.reduce((a, b) => (b.uncoveredDays > a.uncoveredDays ? b : a));
    /*
     * ❓ OWNER DECISION, 2026-09-04: DROP THE NAME WHEN THEY ALL TIE.
     *
     * `/budgets` read "12 of 12 budgets are grading days the ledger has not
     * reached — up to 4 days on Car." Every one of the twelve was at 4 (Sep 1–4
     * elapsed, none imported), and the `reduce` above, with a strict `>`, keeps
     * whichever came first — alphabetically, Car. Naming one of twelve equals
     * says it is distinctive when nothing distinguishes it. Asked as a concrete
     * either/or, he chose to name a budget only when one genuinely leads.
     *
     * ⚠️ A single under-measured budget is not a tie: there is one, and it is
     * named. The test is whether more than one row SHARES the worst gap.
     */
    const tied = uncovered.length > 1 && uncovered.every((r) => r.uncoveredDays === worst.uncoveredDays);
    const days = `${worst.uncoveredDays} ${worst.uncoveredDays === 1 ? "day" : "days"}`;
    notes.push({
      id: "budgets-coverage",
      body:
        `${uncovered.length} of ${input.rows.length} budgets are grading days the ledger has not ` +
        `reached — ${tied ? `${days} each` : `up to ${days} on ${worst.categoryPath}`}. Their spend and ` +
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
 * What a category row's count cell says — and, when it is zero, WHICH zero.
 *
 * 🔴 The manager printed a bare em dash for every row whose own `txnCount` is
 * zero, and the note above the list counts SUBTREES. On the real ledger that
 * put "2 categories hold no transactions" directly over a list showing eight em
 * dashes: `Subscriptions` reads zero directly while Streaming, Software and
 * Memberships hold 259 rows between them. Both figures were right and the pair
 * was not — one screen, two meanings of "holds transactions", three centimetres
 * apart.
 *
 * The note cannot move to direct counts (that would call a parent holding
 * thousands empty), so the ROW says which zero it is. A parent whose
 * subcategories hold rows is not empty; it is unused as a filing destination,
 * which is a different fact and worth a different word.
 *
 * ⛔ …AND WHICH NONZERO. The count is DIRECT and the row links to a page that
 * counts the SUBTREE, so on 2026-09-11 `Housing · 7 txn` opened a page reading
 * "34 transactions" — two true numbers over two populations, three centimetres
 * and one click apart. The zero case already carried that disambiguation; the
 * nonzero case did not, and it was invisible only because the link used to open
 * an empty September page instead.
 */
export function categoryCountLabel(node: {
  txnCount: number;
  children: readonly { txnCount: number }[];
}): { text: string; title: string | null } {
  // categories nest one level deep, which the page says in its own header — so
  // a child's own count IS its subtree
  const inChildren = node.children.reduce((sum, c) => sum + c.txnCount, 0);
  if (node.txnCount > 0) {
    const text = `${node.txnCount.toLocaleString("en-US")} txn`;
    return {
      text,
      title:
        inChildren === 0
          ? null
          : `${node.txnCount.toLocaleString("en-US")} filed directly here; ` +
            `${inChildren.toLocaleString("en-US")} more ${inChildren === 1 ? "sits" : "sit"} in its subcategories`,
    };
  }
  if (inChildren === 0) return { text: "—", title: null };
  return {
    text: "none direct",
    title: `${inChildren.toLocaleString("en-US")} ${inChildren === 1 ? "transaction sits" : "transactions sit"} in its subcategories`,
  };
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

export interface CashEarningsNoteInput {
  /** one entry per confirmed income schedule the window could measure */
  rows: readonly {
    seriesName: string;
    basis: CashEarningsBasis;
    impliedCents: number;
    bankedCents: number;
    unbankedCents: number;
    periodsSinceBanked: number;
    lastBankedOn: string | null;
    /**
     * The first and last payday the implied figure actually counted —
     * `cashEarnings`' own `firstPeriodOn`/`lastPeriodOn`, which exist to be
     * named. See `impliedSpanPhrase`.
     */
    firstPeriodOn: string | null;
    lastPeriodOn: string | null;
    /**
     * How far the account this pay lands in has been READ — the service's
     * `withChecked` fields. Absent means the caller measured only against the
     * calendar, and the note says what it always said.
     */
    periodsCovered?: number;
    checkedThrough?: string | null;
    checkedPeriodsCovered?: number;
    checkedPeriodsSinceBanked?: number;
  }[];
  formatDay: (iso: string) => string;
}

/**
 * The span the implied figure was MEASURED over, as a clause — its own covered
 * paydays, never the period around them.
 *
 * 🔴 Both notes below said "in this period" of a figure `cashEarnings` bounds
 * at `today`, so every period still running was captioned with the whole
 * container. Measured on the owner's ledger 2026-09-10, one confirmed schedule
 * (`Cash job (weekly pay)`, $1,047.00 weekly):
 *
 *     /spending?period=2026-09       "implies $1,047.00 … in this period"
 *                                    September's own schedule is $4,188.00 (4×)
 *     /spending?period=2026-Q3       "$10,470.00 … in this period"
 *                                    the quarter's own is $13,611.00
 *     /spending?from=2026-09-01&to=2026-12-31
 *                                    "$1,047.00 … in this period" over a window
 *                                    holding seventeen paydays
 *
 * `/budgets` says "4 paydays fall in this month, scheduled at $4,188.00" about
 * the same month, so the two surfaces were four times apart on one figure.
 *
 * ⛔ The figure is right — a payday that has not come round yet cannot have
 * failed to reach an account. The LABEL is the defect, and `cashEarnings`
 * already publishes what it should say: "The span `periodsCovered` actually
 * covers … NOT the window: a line that names the window over a count bounded by
 * the series says something false about both." `income-card`'s
 * `paydaysLabelFor` was the only reader of that pair, and the dashboard row it
 * builds — "14 paydays, Jun 4 – Sep 3" — is what this now matches.
 *
 * Empty when there is no covered payday to name: an unnamed span beats an
 * invented one, and both sentences stay grammatical without the clause.
 */
function impliedSpanPhrase(firstOn: string | null, lastOn: string | null): string {
  if (firstOn === null || lastOn === null) return "";
  // the `on` / `over` choice is `merchant-insights`', for the same reason: one
  // day is a day, and calling it a range reads as a stretch of time
  return firstOn === lastOn ? ` on ${dayWindowLabel(firstOn, lastOn)}` : ` over ${dayWindowLabel(firstOn, lastOn)}`;
}

/**
 * What an income figure on this page cannot see, when the pay arrives as cash.
 *
 * The page's income total is a record of DEPOSITS. For a cash job that makes it
 * a record of ATM trips instead of earnings — measured on the live ledger, July
 * 2026 reported $52.95 of income while a confirmed $1,046-a-week schedule ran
 * the whole month. This note is the difference, said out loud.
 *
 * ⛔ It never adds the gap to anything. The figure it names is not money the
 * ledger has found; it is the arithmetic distance between a confirmed schedule
 * and the deposits that actually landed, and `lib/cash-earnings` is explicit
 * that at least three innocent explanations fit. So the note states all three
 * rather than picking one — the reader knows which is true and the app does not.
 *
 * Two notes, and both are deliberately narrow:
 *
 *   - a SILENT schedule is news. Banking in lumps is his ordinary rhythm, so a
 *     live schedule one week behind says nothing at all; only `series-stale`
 *     speaks, and `STALE_PERIODS` sets that bar at three missed periods.
 *   - a period that banked MORE than it earned is also news, in the other
 *     direction: without it, the month he clears a backlog reads as a raise.
 */
export function cashEarningsSectionNotes(input: CashEarningsNoteInput): SectionNote[] {
  const notes: SectionNote[] = [];

  for (const r of input.rows) {
    // Nothing is confirmed, so nothing was measured — and a note about an
    // unmeasured thing is the one shape this module refuses.
    if (r.basis === "no-series") continue;

    /*
     * 🔴 THE CALENDAR IS NOT THE RECORD. "None of it reached an account" was
     * said of September's paydays while the account that pay lands in had been
     * read through Aug 12 — 11 of 14 /spending windows printed at least one
     * false sentence (measured 2026-09-14). With the frontier in hand the note
     * speaks only when three missed paydays fall on READ days (the dashboard's
     * bar), scopes "reached an account" to those days, and names the rest as
     * unchecked rather than unpaid — past `LAST_CHECKED_DAY`, never "nothing
     * imported", which was false of the e2e fixture's own Jun 30.
     */
    const measuredRead = r.checkedThrough !== undefined;
    const readSilence = r.checkedPeriodsSinceBanked ?? 0;
    const silentEnough = !measuredRead || r.checkedThrough === null || readSilence >= STALE_PERIODS;

    if (r.basis === "series-stale" && r.unbankedCents > 0 && silentEnough) {
      // The never-paid branch is a different SENTENCE, not a different noun
      // phrase: "paydays have passed since no deposit has ever been attributed"
      // is what slotting it into the same template produced, and it is not
      // English. A schedule with no evidence at all has no "since" to name.
      /*
       * "Across the whole schedule" is load-bearing, not filler. The sentence
       * before it states a COVERED-PAYDAY figure (what the paydays it named came
       * to) and this one states a SCHEDULE figure (silence measured from the last
       * deposit, which may sit outside the window entirely). Without the marker
       * the June note reads "$4,184.00 over Jun 4 – Jun 25, 2026 … 11 expected
       * paydays", and a reader reasonably takes eleven paydays to be that span's
       * — it holds four.
       */
      const through = r.checkedThrough ? input.formatDay(r.checkedThrough) : null;
      const reached = r.bankedCents === 0 ? "none of it reached an account" : `only ${formatCents(r.bankedCents)} reached an account`;
      const covered = r.periodsCovered ?? 0;
      const readCovered = r.checkedPeriodsCovered ?? 0;
      const unread = covered - readCovered;
      const claim = !measuredRead || (through !== null && unread <= 0)
        ? ` and ${reached}.`
        : through === null
          ? ` — and the account it lands in has not been checked, so the ledger cannot say whether any of it arrived.`
          : readCovered === 0
            ? `, all of it after ${through}, ${LAST_CHECKED_DAY} — so the ledger has not looked for it.`
            : ` and ${reached} through ${through}; the other ${unread} ${unread === 1 ? "payday falls" : "paydays fall"} after that, ${LAST_CHECKED_DAY}.`;

      const readPart =
        measuredRead && through !== null && readSilence < r.periodsSinceBanked
          ? `, and ${readSilence} of them fall on days the records cover, through ${through}`
          : "";
      const silence =
        r.lastBankedOn === null
          ? `Across the whole schedule, ${r.periodsSinceBanked} expected paydays have passed and ` +
            `no deposit has ever been attributed to it${readPart}`
          : `Across the whole schedule, ${r.periodsSinceBanked} expected paydays have passed ` +
            `since the last deposit on ${input.formatDay(r.lastBankedOn)}${readPart}`;
      // a list of explanations is only complete when the ledger looked at every payday it counts
      const explanations =
        measuredRead && (through === null || readSilence < r.periodsSinceBanked)
          ? "that money was held as cash, spent as cash, the schedule has ended, or it has not been imported yet"
          : "that money was held as cash, spent as cash, or the schedule has ended";
      notes.push({
        id: `cash-earnings-unbanked-${r.seriesName}`,
        body:
          `${r.seriesName} implies ${formatCents(r.impliedCents)} of earnings` +
          `${impliedSpanPhrase(r.firstPeriodOn, r.lastPeriodOn)}${claim} ` +
          `${silence} — ${explanations}. ` +
          `The income figures on this page count deposits, so they cannot tell you which.`,
      });
      continue;
    }

    if (r.unbankedCents < 0) {
      notes.push({
        id: `cash-earnings-catchup-${r.seriesName}`,
        body:
          `${r.seriesName} banked ${formatCents(-r.unbankedCents)} more than its paydays` +
          `${impliedSpanPhrase(r.firstPeriodOn, r.lastPeriodOn)} came to. ` +
          `Cash is deposited in lumps, so the surplus is earlier pay arriving late — read it as a ` +
          `backlog clearing rather than as a period that earned more.`,
      });
    }
  }

  return notes;
}
