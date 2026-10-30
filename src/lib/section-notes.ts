import { arrearsTail, NOT_POSTED } from "./arrears-reading";
import {
  countedDepositWords,
  MATCHED_TO_THE_CENT_BY,
  neverClauses,
  neverSplit,
  notCountedWords,
  silenceMatches,
  unattachedCents,
  unattachedRowsWords,
  type NeverSplit,
  type UnattachedMatch,
} from "@/lib/unattached-match";
import { spendIsAFloor, spendUnread, spentOnlyFromCashWallets, type BudgetCoverageInput } from "./budget-coverage";
import { lineMayRise } from "./rollover-held-back";
import { formatCategoryPath } from "./category-path";
import { isStaleClose, newestQuotedOn } from "./holding-price-age";
import { formatCents } from "./money";
import { dayWindowLabel } from "./period";
import { STALE_PERIODS, type CashEarningsBasis } from "./cash-earnings";
import { compareDates } from "./dates";
import { formatDayShortIn } from "./format-date";
import { depositsOf } from "./paid-by-another-month";
import type { PaidAcross, PaidOutside, PayShortfall } from "./pay-shortfall";
import { wentBackOutPhrase, windowOwnCents } from "./pay-window-money";
import { TOWARD_NO_PAYDAY } from "./per-payday";
import {
  ACCOUNT_NOT_READ,
  ACCOUNT_READ,
  daysToLandRunPast,
  LAST_CHECKED_DAY,
  notLookedForDeposits,
  paidEarlyAside,
  payNotBankedYet,
} from "./unbanked-income";

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
  // the row's arrears line, whichever way the ledger has read it (`BudgetRow`)
  "expected by now",
  "expected before",
  "Awaiting statements",
  // /categories row copy — owned by CategoryRow, and now sharing a page with a
  // note for the first time
  "Archived",
  "Locked",
] as const;

/**
 * How a note punctuates a list of category names. (A path is punctuated by the
 * one path printer, `formatCategoryPath` in `./category-path`.)
 *
 * Named rather than inlined because it is only unambiguous while a category
 * name cannot contain it — a note that states a COUNT and then joins names
 * with ", " contradicts its own list the moment one name has a comma in it
 * ("2 categories hold no transactions: Food, Drink, Pets" says two, lists
 * three). `FORBIDDEN_NAME_CHARS` in `services/category-edit` is what makes that
 * impossible, and `section-notes.test.ts` asserts the two agree, so changing a
 * separator here fails the build rather than silently reopening the ambiguity.
 */
export const NAME_LIST_SEPARATOR = ", ";

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
    /** of `overdueCents`, the part on days no checked statement has reached (`BudgetPaceStatus.overdueUnreadCents`) */
    overdueUnreadCents: number;
    /** of `overdueUnreadCents`, the part no statement keeps unread (`BudgetPaceStatus.overdueInGraceCents`) */
    overdueInGraceCents: number;
    /** of the read part, the due days rows sitting unattached match to the cent (`BudgetPaceStatus.overdueUnattached`) */
    overdueUnattached?: readonly UnattachedMatch[];
    uncoveredDays: number;
    pace: "under" | "at-risk" | "over";
    /** the row's accounts, so a cash-only row is told apart by the rule the row itself uses */
    spentFromAccounts: BudgetCoverageInput["spentFromAccounts"];
    spentFromWallets: BudgetCoverageInput["spentFromWallets"];
    /** ⚖️ §6A 64: whether the row prints a dash for its spend, by the row's own test (`spendUnread`) */
    noDayRead: boolean;
    txnCount: number;
    /** ⚖️ …and whether its line can still rise, by the row's own test (`lineMayRise`, 2026-10-29) */
    rolloverMayAddCents: number;
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
    /*
     * 🔴 "no import has covered them yet" OF DAYS AN IMPORT HAD COVERED. The note said it of every overdue bill, read
     * or not — the reverse of the rows beside it, which said "not imported" of both (review of a132c57, 2026-10-08).
     * ⛔ The rows' split, summed the way `total` is, said in the runway's voice (`arrearsTail`): "not posted" only of
     * what the ledger has read.
     */
    const unread = overdue.reduce((sum, r) => sum + r.overdueUnreadCents, 0);
    const inGrace = overdue.reduce((sum, r) => sum + r.overdueInGraceCents, 0);
    const said = arrearsTail(
      { owedCents: total, unreadCents: unread, inGraceCents: inGrace, unattached: overdue.flatMap((r) => r.overdueUnattached ?? []) },
      NOT_POSTED,
      bills === 1 ? "it" : "them",
    );
    /*
     * ⚖️ §6A 64: a row not one elapsed day of whose window is read prints "Left —", so there is no room left on it to
     * look smaller than it is. 🔴 On his ledger copy 2026-10-13 this said "so the room left is smaller than it looks"
     * over Housing and Utilities, both printing "Left —" (review of 6f217a7). ⛔ The rows' own test (`spendUnread`).
     */
    const dashed = overdue.filter((r) => spendUnread(r)).length;
    const committed =
      dashed === overdue.length
        ? `That money is committed out of ${overdue.length === 1 ? "its plan" : "their plans"}.`
        : `That money is committed, so the room left is smaller than it looks${dashed > 0 ? " where it is shown" : ""}.`;
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
        `${formatCents(total)} due by today${said} — ${where}. ${committed}`,
    });
  }

  // A row is under-measured on the SAME rule the row itself uses: `over` is
  // exempt, because already exceeding the plan is a fact more data cannot undo.
  // ⚖️ So is a row spent only from cash wallets (owner, 2026-09-15): no statement
  // is coming for it, so it is not grading days the ledger has yet to reach — and
  // the test is the row's own, `spentOnlyFromCashWallets`.
  // ⚖️ An over row's figures are floors all the same where its days are unread, and
  // the clause after the count says so (`overReadInPart`, default built, not asked,
  // 2026-10-29). ⚠️ The plan, that is: on a rolling budget whose closed period can
  // still bank, the LINE can still rise past the spend (`lineMayRise`, review of
  // 48475ec4) — the row stays counted here as over, and the clause says so.
  const uncovered = input.rows.filter(
    (r) => r.uncoveredDays > 0 && r.pace !== "over" && !spentOnlyFromCashWallets(r),
  );
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
     * either/or about that case, he chose to drop the name when they ALL tie
     * ("— 4 days each"; handoff 2026-09-04b §10.2).
     *
     * ⚠️ A single under-measured budget is not a tie: there is one, and it is
     * named.
     *
     * ❓ NOT DECIDED: A PARTIAL TIE. The test is `every`, so when several rows
     * share the worst gap and another sits lower, the first of them in page
     * order is still named. 🔴 This comment used to say "the test is whether
     * more than one row SHARES the worst gap", which the code has never done,
     * and that the owner chose to name a budget "only when one genuinely leads",
     * which is not what he was asked. Measured 2026-09-15: the real ledger reads
     * "9 of 12 budgets … up to 15 days on Car" — over four rows at 15 before
     * 4c43a7d (Car, Cash & ATM, Fees, Travel) and eight after it (Travel then at
     * 13), with lower rows beside them both times. The fresh e2e fixture after
     * 4c43a7d reads "up to 4 days on Food" with Subscriptions also at 4 and
     * Utilities at 3. Name a budget only when it alone holds the worst
     * gap, or keep the all-tie rule — his call, pinned in `section-notes.test.ts`.
     */
    const tied = uncovered.length > 1 && uncovered.every((r) => r.uncoveredDays === worst.uncoveredDays);
    const days = `${worst.uncoveredDays} ${worst.uncoveredDays === 1 ? "day" : "days"}`;
    /*
     * ⚖️ §6A 64 (2026-10-12): a row not one elapsed day of whose window has been read prints no spend at all, so its
     * spend is no lower bound. 🔴 On his ledger copy 2026-10-12 this read "Their spend and percentages are lower
     * bounds, not measurements" over twelve rows that print "—" for both. ⛔ The rows' own test (`spendUnread`).
     */
    const unread = uncovered.filter((r) => spendUnread(r)).length;
    /*
     * ⚖️ default built, not asked (2026-10-29): a row whose line can still rise (`lineMayRise`) has a percentage that
     * is no lower bound — its spend still is — so where one of the rows shown is such a row, the note calls only their
     * spend one; the row's own line says what can still roll over. ⛔ A dash shows neither, so it is not counted.
     */
    const pcts = uncovered.some((r) => !spendUnread(r) && lineMayRise(r))
      ? "spend is a lower bound, not a measurement"
      : "spend and percentages are lower bounds, not measurements";
    const shown =
      unread === 0
        ? `Their ${pcts}, so no verdict is shown for them.`
        : unread === uncovered.length
          ? "Not one elapsed day of their periods has been imported, so neither their spend nor a verdict is shown."
          : `No verdict is shown for any of them: ${unread} ${unread === 1 ? "has" : "have"} not had one elapsed ` +
            `day imported, so no spend is shown there either, and the others' ${pcts}.`;
    const overInPart = input.rows.filter((r) => r.pace === "over" && spendIsAFloor(r));
    notes.push({
      id: "budgets-coverage",
      body:
        `${uncovered.length} of ${input.rows.length} budgets are grading days the ledger has not ` +
        `reached — ${tied ? `${days} each` : `up to ${days} on ${worst.categoryPath}`}. ${shown}` +
        overReadInPart(overInPart.length, overInPart.filter((r) => lineMayRise(r)).length),
    });
  }

  return notes;
}

/**
 * " The 5 over their plans are grading such days too, so each is over by at least what it shows." — or "" where no
 * over row's figures are floors (`n`).
 *
 * ⚖️ default built, not asked (2026-10-29): the count above keeps counting the rows whose verdict is withheld, and
 * this keeps it from reading as "the rest are read in full". 🔴 Measured on his ledger copy 2026-10-29: "7 of 12
 * budgets are grading days the ledger has not reached — 29 days each. No verdict is shown for any of them: …" beside
 * 5 rows reading "Over budget by N%" over the same October — Health and Travel read through Oct 2, Entertainment,
 * Shopping and Subscriptions through Aug 12. ⛔ The rows' own test (`spendIsAFloor`), so the clause counts exactly
 * the over rows that print their line (`budgetCoverageLine`). Said only beside that count: with no withheld row there
 * is no count to correct, and each over row carries its own line.
 *
 * ⚖️ …and where `rises` of them have a line that can still rise (`lineMayRise`, default built, not asked,
 * 2026-10-29), how far past it is no floor: the clause says what is true of all `n` — each has spent at least what it
 * shows — and how many can still have more roll over. 🔴 Review of 48475ec4, measured on his ledger copy 2026-10-29:
 * Fees, $15.00 rolling with September held back at $0.00, and a $20.00 Oct 10 row — "The 6 over their plans are
 * grading such days too, so each is over by at least what it shows." — read $20.00 of $30.00 once Fees' accounts
 * were read through Sep 30, no spending added.
 */
function overReadInPart(n: number, rises: number): string {
  if (n === 0) return "";
  const subject = n === 1 ? "The one over its plan is" : `The ${n} over their plans are`;
  const each = n === 1 ? "it" : "each";
  if (rises === 0) return ` ${subject} grading such days too, so ${each} is over by at least what it shows.`;
  const into = n === 1 ? "it" : rises === n ? "each of them" : `${rises} of them`;
  return (
    ` ${subject} grading such days too, so ${each} has spent at least what it shows, ` +
    `though more can still roll over into ${into}.`
  );
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
  const newest = newestQuotedOn(input.rows);
  // Nothing priced at all is the holdings table's story, not this one, and an
  // empty portfolio must never produce "priced 0 days ago".
  if (newest === null) return [];

  const dates = input.rows.map((r) => r.quotedOn).filter((d): d is string => d !== null);
  const oldest = dates.reduce((a, b) => (b < a ? b : a));
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
      path: formatCategoryPath(root.name, child.name),
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
    /** the silence's paydays a deposit paid early, which `periodsSinceBanked` leaves out — absent or empty: none */
    silencePaidEarly?: readonly string[];
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
    /**
     * Of the silence, the checked paydays still inside their days to land (`silentPaydaysNotBankedYet`) —
     * schedule-wide, whatever the window: what the note for a stale schedule names "not banked yet". Absent or empty,
     * it names none.
     */
    checkedSilentNotBankedYet?: readonly string[];
    /**
     * The schedule's paydays the one rule matched to a row sitting unattached (`CashEarningsReading.unattachedPaydays`),
     * oldest first — the note takes its window's: never "none of it reached an account" of them, still unbanked.
     */
    unattachedPaydays?: readonly UnattachedMatch[];
    /**
     * The window's READ paydays against the settlement (`payShortfall`) — what the shortfall note prints. Absent
     * means the caller did not measure it, and no such note is written.
     */
    shortfall?: PayShortfall;
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
 * Whether a pay note's lead counts ONE payday, by the span `impliedSpanPhrase` names: a one-day span is one payday (a
 * series has one payday a day). ⛔ One rule for the lead's noun (`paydaysOverSpan`) and every word after it that counts
 * those paydays back (`payShortfallNote`'s "that payday" / "none of them"), so the two cannot disagree.
 */
function onePayday(firstOn: string | null, lastOn: string | null): boolean {
  return firstOn !== null && firstOn === lastOn;
}

/**
 * "its paydays over Jul 2 – 30, 2026", "its payday on Sep 24, 2026" — the paydays a pay note's lead counts
 * (`onePayday`). 🔴 "its paydays on Sep 24, 2026" was said of one (review of the shortfall batch).
 */
function paydaysOverSpan(firstOn: string | null, lastOn: string | null): string {
  return `${onePayday(firstOn, lastOn) ? "payday" : "paydays"}${impliedSpanPhrase(firstOn, lastOn)}`;
}

/**
 * The surplus note's lead: "banked $X more than its paydays over … came to." — and, in a window where none of its
 * paydays has passed, what it banked alone: there are no paydays to have come to anything. 🔴 Jun 5 – Jun 5 and Sep 23 –
 * Sep 23 on his ledger copy read "banked $400.00 more than its paydays came to" of windows holding no payday at all
 * (review of the shortfall batch).
 */
function surplusLead(seriesName: string, surplusCents: number, firstOn: string | null, lastOn: string | null): string {
  const banked = `${seriesName} banked ${formatCents(surplusCents)}`;
  if (firstOn === null) return `${banked} in a window where none of its paydays has passed.`;
  return `${banked} more than its ${paydaysOverSpan(firstOn, lastOn)} came to.`;
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
 * that at least four innocent explanations fit. So the note states them all
 * rather than picking one — the reader knows which is true and the app does not.
 *
 * Four notes, and each is deliberately narrow:
 *
 *   - a SILENT schedule is news. Banking in lumps was his ordinary rhythm, so
 *     the schedule's SILENCE is named only when `series-stale`, and
 *     `STALE_PERIODS` sets that bar at three missed periods.
 *   - a period that banked MORE than it earned is also news, in the other
 *     direction: without it, the month he clears a backlog reads as a raise.
 *     Read off the settlement, the surplus says which part was that and which
 *     paid a later payday early (`surplusSplit`).
 *   - and a period whose paydays on READ days came to more than it banked is its mirror (`payShortfallNote`) — what
 *     paid them from outside the period, and what nothing paid. 🔴 Without it every window of a schedule that is
 *     not stale was silent about its own unbanked paydays: on his ledger 2026-10-13 August read "INCOME $54.12"
 *     beside four paydays of $4,282.92 and no note, one month from September's surplus note about the same lump.
 *     ⛔ Never beside the surplus note: both read one banked figure, and the read paydays are some of those the
 *     surplus is measured against (`payGap`) — 🔴 a window paid $900.00 then $1,300.00 printed both.
 *   - and a period with NO read payday, whose money a period over it still nets — pay for its own paydays past the
 *     checked day, money gone back out — names that money in the shortfall note's place (`unreadPaydaysNote`).
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
      // phrase: "paydays have passed since nothing attributed to it has ever banked"
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
      const payday = (iso: string): string => formatDayShortIn(iso, r.lastPeriodOn ?? iso);
      /*
       * ⛔ What deposits OUTSIDE the window paid of its read paydays (`paidOutside`), in the shortfall note's words
       * (`paidOutsidePhrases`) — and the money that "reached an account" is then the window's own, "inside the window".
       * 🔴 Review of 337baa7 (MEDIUM, pre-existing): with Wed Sep 30's payroll paying Thu Oct 1 early, Wells Fargo read
       * through Oct 23 and today Oct 30, October read "implies $5,709.60 of earnings over Oct 1 – 29, 2026 and none of
       * it reached an account through Fri, Oct 23, 2026" of the Oct 1 the calendar drew paid by the deposit of Sep 30,
       * and the live schedule's shortfall note names "paid early, by the deposit of Wed, Sep 30, 2026" (his ledger copy
       * 2026-10-21, the Sep 30 row inserted).
       */
      const outside = paidOutsidePhrases(r.shortfall?.paidOutside ?? [], payday, input.formatDay);
      /*
       * ⛔ …and the mirror: money INSIDE the window that paid another window's read payday (`paidAcross`) is that
       * window's — it is not what "reached an account" of this one's earnings (`windowOwnCents`, the figure the
       * shortfall's subtraction reads), and it is named after the claim in the shortfall note's words
       * (`anotherBankedInside`). 🔴 Review of 0c9bc8d (MEDIUM): with Wed Sep 30's payroll paying Thu Oct 1, Wells Fargo
       * read through Fri Oct 23 and today Oct 30, Q3 read "implies $14,085.60 of earnings over Jul 2 – Sep 24, 2026 and
       * only $6,851.52 reached an account" — Sep 30's $1,141.92 among it — while Q4 on the same page named that deposit
       * paying Oct 1 early: one deposit on both sides, and $7,234.08 to infer short beside the card's and the live Q3
       * note's $8,376.00 (his ledger copy 2026-10-21, the Sep 30 row inserted).
       */
      const across = r.shortfall?.paidAcross ?? [];
      const another = anotherBankedInside(paidAcrossParts(across, payday, input.formatDay), "paid paydays outside it");
      const inside = outside.length === 0 && across.length === 0 ? "" : " inside the window";
      const ownCents = windowOwnCents(r.bankedCents, across);
      /*
       * ⚖️ …in the accounts the ledger reads (`ACCOUNT_READ`), as the quiet below names pay paid into one it does not
       * (`ACCOUNT_NOT_READ`) — default built, not asked (2026-10-29). 🔴 Review of cc30142: on his ledger copy
       * 2026-10-29 with a Salary-filed −$1,141.92 on Fri Sep 25 and Wells Fargo derived through Fri Oct 16, October
       * read "…none of it reached an account through Fri, Oct 16, 2026; … — that money was held as cash, spent as
       * cash, paid into an account the ledger does not read, …": money that reached no account, paid into one.
       */
      /*
       * ⛔ …and of the window's paydays, those a row matches to the cent unattached (`unattachedPaydays`, the one
       * rule's): "reached an account the ledger reads, in a deposit attached to it", and the rows named by day and
       * amount — still unbanked, never "none of it reached an account". 🔴 His ledger copy 2026-10-29 (before his
       * filing): October read "implies $4,567.68 of earnings over Oct 1 – 22, 2026 and none of it reached an account"
       * beside four +$1,141.92 payroll rows on Wells Fargo, unattached.
       * ⛔ Of the paydays its lead counts, by the shortfall note's one filter (`unattachedAmong`). 🔴 Its own inline copy
       * was held by no test (beside the review of e6ad55a): gone, September read Oct 29 named October's four rows.
       */
      const matched = unattachedAmong(r.unattachedPaydays ?? [], r.firstPeriodOn, r.lastPeriodOn);
      /*
       * ⚖️ …"and filed as income" once one of them is attached and filed nowhere (`countedDepositWords`) — said of the
       * DEPOSIT, never of the account: "in a deposit attached to it". Set off by commas where the checked day follows,
       * so "through <day>" stays the claim's. 🔴 Review of ff0bf19 (MEDIUM): the trial import of the Oct 26 statement
       * into his pre-import copy, read Oct 31, YTD said "only $7,156.60 reached an account attached to it and filed as
       * income" — the account was the thing attached and filed.
       * ⛔ …and by a comma before it always, now that `ACCOUNT_READ` ends on a verb: "an account the ledger reads in a
       * deposit attached to it" reads the deposit as where the ledger reads (the merge of batch 8b, 2026-10-30).
       */
      const deposit = (dayFollows: boolean): string => {
        if (matched.length === 0) return "";
        const words = `in ${ownCents <= 0 ? "a deposit" : "deposits"} ${countedDepositWords(matched, "it")}`;
        return dayFollows ? `, ${words},` : `, ${words}`;
      };
      const reached = (dayFollows: boolean): string =>
        `${ownCents <= 0 ? "none of it" : `only ${formatCents(ownCents)}`} reached ${ACCOUNT_READ}${inside}` +
        deposit(dayFollows);
      const rowsPart = `${MATCHED_TO_THE_CENT_BY} ${unattachedRowsWords(matched, payday)}`;
      const matchedPart = matched.length === 0 ? [] : [`${formatCents(unattachedCents(matched))} is ${rowsPart}`];
      const covered = r.periodsCovered ?? 0;
      const readCovered = r.checkedPeriodsCovered ?? 0;
      const unread = covered - readCovered;
      /*
       * ⚖️ DEFAULT (A), BUILT, NOT ASKED (2026-10-21): money out on a day of its own that the figure above leaves out is
       * named on its day (`wentBackOutPhrase`), as Earned vs banked and the shortfall note name it — never netted away
       * unnamed. 🔴 Review of 27ca437 (MEDIUM): this branch's `continue` skips the shortfall note, the only other
       * /spending path that named it, so on his ledger copy 2026-10-21 with a Salary-filed −$1,141.92 on Fri Sep 25
       * and Wells Fargo read through Oct 16, YTD read "only $7,156.60 reached an account" and no Sep 25, while the card
       * read "…; $1,141.92 went back out on Fri, Sep 25, 2026."
       */
      // the one rule's days (`moneyOutOfWindow`) — the reading's `bankedCents` above is that rule's figure
      const out = r.shortfall?.wentBackOut ?? [];
      /*
       * ⛔ All of them after the claim, last, as the card names its money out last — never between the claim and
       * "through <day>", nor between that and "the other payday falls after that". 🔴 Review of 337baa7 (MEDIUM):
       * there, on his ledger copy 2026-10-21 with the Sep 25 return and Wells Fargo read through Oct 16, YTD read
       * "…through Fri, Oct 16, 2026; $1,141.92 went back out on Fri, Sep 25, 2026; the other payday falls after that,
       * the last day …" — Sep 25 read as the checked day. 🔴 Review of ff0bf19 (MEDIUM): the matched rows sat inside
       * the claim, so the trial import of the Oct 26 statement into his pre-import copy, read Oct 31, said "…rows of
       * $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that are attached to it but not filed as income through Mon, Oct
       * 26, 2026; the other payday falls after that, …" — the checked day read as the rows'.
       */
      // …in the shortfall note's order: who paid its paydays from outside, what the rows the one rule matched answer,
      // its money that paid another's, money out
      const named = [
        ...outside,
        ...matchedPart,
        ...(another === "" ? [] : [another]),
        ...(out.length === 0 ? [] : [wentBackOutPhrase(out, input.formatDay)]),
      ];
      const after = named.map((words) => `; ${words}`).join("");
      const claim = !measuredRead || (through !== null && unread <= 0)
        ? ` and ${reached(false)}${after}.`
        : through === null
          ? ` — and the account it lands in has not been checked, so the ledger cannot say whether any of it ` +
            `arrived${after}.`
          : readCovered === 0
            ? `, all of it after ${through}, ${LAST_CHECKED_DAY} — so the ledger has not looked for it${after}.`
            : // "the other payday" of one — 🔴 "the other 1 payday falls after that" (review of 8ef2fc5)
              ` and ${reached(true)} through ${through}; ` +
              `${unread === 1 ? "the other payday falls" : `the other ${unread} paydays fall`} after that, ` +
              `${LAST_CHECKED_DAY}${after}.`;

      const readPart =
        measuredRead && through !== null && readSilence < r.periodsSinceBanked
          ? `, and ${readSilence} of them fall on days the records cover, through ${through}`
          : "";
      const silence =
        r.lastBankedOn === null
          ? `Across the whole schedule, ${r.periodsSinceBanked} expected paydays have passed and ` +
            `nothing attributed to it has ever banked${readPart}`
          : // …less the paydays a deposit paid early, named (`paidEarlyAside`), as the card names them
            `Across the whole schedule, ${r.periodsSinceBanked} expected paydays have passed since the last deposit ` +
            `on ${input.formatDay(r.lastBankedOn)}${paidEarlyAside(r.silencePaidEarly ?? [], payday)}${readPart}`;
      // a list of explanations is only complete when the ledger looked at every payday it counts
      /*
       * ⚖️ …and the one it adds says what the quiet waits for (his decision 65, 2026-10-12), in the forecast's words
       * (`notLookedForDeposits`). 🔴 It said "or it has not been imported yet" of paydays past a CHECKED day — the
       * e2e fixture's Chase Total Checking is checked through Jun 30 with rows imported to Jul 4.
       */
      const unlooked = through === null ? r.periodsSinceBanked : r.periodsSinceBanked - readSilence;
      /*
       * ⚖️ …and a payday the ledger checked on its day but not through its days to land is not banked yet
       * (`paydaysNotBankedYet`), in the words of Earned vs banked's verdict (`payNotBankedYet`). 🔴 Review of 4b98f77's
       * follow-up: weekly pay through Aug 6, Chase read through Sat Sep 5 — September listed cash, ended and not looked
       * for of Thu Sep 3, while the dashboard said Sep 3's pay is not banked yet.
       * ⛔ The SILENCE's paydays (`checkedSilentNotBankedYet`), as the sentence they finish is schedule-wide — never the
       * window's (`shortfall.notBankedYetPaydays`). 🔴 Review of c02a4b0: on the reviewer's state August, which holds no
       * Sep 3, left its reason out of the very sentence September printed with it; and with Fri Aug 14's deposit after
       * an unpaid Aug 13, a window holding Aug 13 named it where the verdict names Aug 20, Aug 27 and Sep 3.
       */
      const inGrace = r.checkedSilentNotBankedYet ?? [];
      /*
       * ⛔ The rows the one rule matched to the SILENCE's paydays (`silenceMatches`, Earned vs banked's own reading) are
       * the first place that money may be while they stay unattached — the sentence they finish is schedule-wide, so
       * they are never the window's: "the rows named above" only when the claim named exactly them, and by day and
       * amount otherwise. 🔴 Review of ff0bf19 (MEDIUM): they were the window's, so on his pre-filing and trial copies
       * read Oct 31, Q3 explained "5 expected paydays have passed since the last deposit on Thu, Sep 24, 2026" as cash,
       * an ended schedule or an unread account, while October, Q4 and YTD on the same page said "that money sits in the
       * rows named above".
       */
      const silent = silenceMatches(r.unattachedPaydays ?? [], r.lastBankedOn);
      const namedAbove =
        silent.length === matched.length && silent.every((s) => matched.some((m) => m.row.id === s.row.id));
      const sitsIn = namedAbove
        ? `the rows named above, ${notCountedWords(silent, "the schedule")}`
        : unattachedRowsWords(silent, payday);
      /*
       * ⚖️ …and payroll landing in an account the ledger does not read, in the card's caveat's order and words
       * (`ACCOUNT_NOT_READ`) — default built, not asked (2026-10-21): his pay is payroll by ACH since Aug 27 (decision
       * 55). 🔴 Review of 619ceb4 (MEDIUM): on his ledger copy 2026-10-21 with a Salary-filed −$1,141.92 on Fri Sep 25
       * and Wells Fargo derived through Fri Oct 16, on Oct 23, October, Q4 and YTD explained four payroll weeks as cash
       * or an ended schedule, while the card beside them named payroll landing in an account the ledger does not read.
       */
      const explanations = OR_LIST.format([
        ...(silent.length === 0 ? [] : [`that money sits in ${sitsIn}`]),
        silent.length === 0 ? "that money was held as cash" : "was held as cash",
        "spent as cash",
        `paid into ${ACCOUNT_NOT_READ}`,
        "the schedule has ended",
        ...(measuredRead && (through === null || readSilence < r.periodsSinceBanked)
          ? [notLookedForDeposits(unlooked)]
          : []),
        ...(inGrace.length > 0 && r.checkedThrough
          ? [payNotBankedYet(inGrace, r.checkedThrough, payday, input.formatDay)]
          : []),
      ]);
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

    // ⛔ after the stale note's `continue`: a stale series keeps the note it has, and never prints both
    const surplusSpeaks = r.unbankedCents < 0;
    const shortfall =
      r.shortfall === undefined
        ? null
        : payShortfallNote(
            r.seriesName,
            r.shortfall,
            r.checkedThrough,
            input.formatDay,
            surplusSpeaks,
            // ⛔ the paydays the one rule matched (`unattachedPaydays`): named, never "never reached a bank"
            r.unattachedPaydays ?? [],
          );

    /*
     * ⛔ The surplus note only where the shortfall note is silent. Both measure one window's money, but the shortfall
     * note measures what was left once money that paid ANOTHER window's payday is taken out — and names that money —
     * so a window whose deposits paid Aug 27 and Oct 1 while its own Sep 24 was paid from outside it banked "more than
     * its paydays came to" and "none of it" at once. 🔴 Review of 2a415d5, his ledger copy with the next Wells Fargo
     * statement simulated: Sep 24 – Sep 30 read "banked $1,141.92 more than its paydays on Sep 24, 2026 came to".
     */
    if (surplusSpeaks && shortfall === null) {
      /*
       * 🔴 "Cash is deposited in lumps" was said of weekly ACH payroll into Wells
       * Fargo (measured 2026-10-07, September: one $4,567.68 deposit on Sep 23
       * banked four weeks — settle backwards). What makes a surplus is a deposit
       * banking several paydays, which holds for cash and payroll alike, so the
       * sentence names that and not how the money travelled.
       */
      notes.push({
        id: `cash-earnings-catchup-${r.seriesName}`,
        body:
          surplusLead(r.seriesName, -r.unbankedCents, r.firstPeriodOn, r.lastPeriodOn) +
          surplusSplit(-r.unbankedCents, r.shortfall, r.lastPeriodOn, input.formatDay),
      });
    }
    if (shortfall !== null) notes.push({ id: `cash-earnings-${shortfall.kind}-${r.seriesName}`, body: shortfall.body });
  }

  return notes;
}

/** "A and B", "A, B, and C" — the platform's list, as /budgets' fourth figure joins its deposits. */
const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
/** "A, B, or C" — what a stale schedule's quiet can mean. */
const OR_LIST = new Intl.ListFormat("en", { style: "long", type: "disjunction" });

const centsOf = (parts: readonly { cents: number }[]): number => parts.reduce((sum, p) => sum + p.cents, 0);

/** Every payday the parts went into, oldest first, once each. */
const paydaysOf = (parts: readonly { paydays: readonly string[] }[]): string[] =>
  [...new Set(parts.flatMap((p) => p.paydays))].sort(compareDates);

/**
 * The shortfall note: what a period's paydays on READ days came to, what was banked inside the period, what deposits
 * outside it paid of the rest — named by day, "paid early" when before it (§6A 29) — and what no deposit made up, in
 * Earned vs banked's words ("never reached a bank"). Null when the period banked what its read paydays came to and has
 * nothing a period over it nets left to name — no money out on a day of its own, and none beyond its read paydays
 * that the surplus note is silent about.
 *
 * ⚖️ THE SHORTFALL IS THE DASHBOARD'S (`payShortfall`'s `shortCents`, `payGap`, decision 55): the read paydays less
 * EVERY deposit banked inside the period, so the sentence's figures — banked, paid from outside, never — add up to
 * what the paydays came to, and a period that banked its whole schedule, however unevenly, says nothing. Money banked
 * inside the period that paid no payday is named INSIDE the banked figure, in the calendar's words
 * (`TOWARD_NO_PAYDAY`): it reached a bank, so it is not "never". Measured on his ledger copy 2026-10-13, June:
 * "$1,447.00 was banked inside the window ($400.00 of it, from the deposit of Fri, Jun 5, 2026, went toward no payday)
 * and $2,741.00 never reached a bank" — the page's Salary $1,447.00, and the dashboard's netting. 🔴 It read "$1,047.00
 * was banked inside the window and $3,141.00 never reached a bank. $400.00 … went toward no payday.", and ALL read
 * $11,517.00 never reached a bank beside the dashboard's $11,117.00 (review of a4b0fca).
 *
 * ⛔ Of READ paydays only. A payday after `LAST_CHECKED_DAY` that no deposit settled is named as not looked for —
 * decision 65's words (`notLookedForDeposits`), never as unbanked — and a period with no read payday has no paydays to
 * say "came to" of: the forecast and /budgets name the quiet it waits on, and `unreadPaydaysNote` names its money.
 * 🔴 Review of 36f212f: on his ledger copy (checked through Thu Sep 24) with Wed Sep 30's $1,141.92 returned on Fri
 * Oct 2, October and Q4 read "It America LLC (weekly pay)'s paydays came to $0.00, and none of it reached a bank".
 *
 * ⛔ THE PERIOD'S OWN MONEY. Money banked inside it that paid a READ payday OUTSIDE it is the other period's — that
 * period's note names it paying its payday — so it neither makes up a payday here nor goes unnamed: after the split,
 * "another $X banked inside the window, from the deposit of …, paid Oct 1's payday early" (decisions 29/32's word) or
 * "paid Sep 24's payday". 🔴 Review of 2a415d5: netted here as well, September (Wed Sep 30 paying Thu Oct 1, Sep 17
 * never banked) said nothing while October named the same $1,141.92 paid early, and his Q3 stopped adding up to its
 * months — "$7,234.08 never reached a bank" beside July's $5,235.00 and August's $3,141.00. ⛔ A payday no period
 * reads — past `LAST_CHECKED_DAY` — is counted by none, so its money stays netted here, as Earned vs banked nets it
 * (review of 3dc6527: September read "$1,141.92 never reached a bank" where the year and the dashboard did not).
 *
 * ⛔ …AND NAMED WHEREVER A PERIOD OVER THIS ONE NETS IT. When nothing is short and the surplus note is silent — the
 * period's own unread paydays absorb its money in the implied figure — the money beyond its read paydays still lowers
 * the year's "never reached a bank", so the note prints for it alone. 🔴 Review of 36f212f: his ledger copy with Wed
 * Sep 30 and Wed Oct 7 imported past the Sep 24 statement read YTD $8,833.16 beside June's $2,741.00 and Q3's
 * $7,234.08, and no month or quarter named Oct 7's $1,141.92, which paid Thu Oct 8.
 *
 * ⚖️ MONEY OUT ON A DAY OF ITS OWN (his decision 75): "went back out on" its day, after the split — never netted away
 * from a payday a deposit paid, which stays banked as the calendar draws it (`payShortfall`'s `wentBackOut`, by the one
 * rule Earned vs banked reads, and in its words: `wentBackOutPhrase`). 🔴 With Sep 23's lump and $1,141.92 back out on
 * Fri Sep 25, Sep 21 – 27 read Sep 24 "none of it reached a bank".
 *
 * ⛔ EACH DEPOSIT WITH THE MONEY IT PUT IN (`pay-shortfall`'s "NO SECOND ALLOCATION"). When outside money paid more
 * than the net shortfall — money inside paid no payday, and had no unpaid payday to net — the outside deposits keep
 * their own figures and that money is named after the split, toward no payday. 🔴 Review of 2a415d5: Aug 14 – Sep 23
 * on his ledger copy read "$1,047.00 (Aug 27) was paid by the deposit of Thu, Sep 24, 2026" — Aug 27 is a $1,141.92
 * payday the Sep 24 deposit paid whole, and Aug 20's $1,047.00 that no deposit paid went unnamed.
 *
 * ⛔ …AND NEVER "NEVER" OF WHAT A ROW THE ONE RULE MATCHED ANSWERS (`unattached`, the reading's `unattachedPaydays`):
 * the card's split of the same figure (`neverSplit`, `neverClauses`) — the rows named by day and amount, still counted
 * as nothing. 🔴 Review of de31d22 (MEDIUM): on his pre-filing copy read with today 2026-10-13, October said "came to
 * $2,283.84, and none of it reached a bank" while Earned vs banked named the Oct 1 and Oct 8 rows; with Oct 1, 8 and 15
 * filed, Oct 22 unattached and today Nov 2, "…$941.92 never reached a bank" beside the card's Oct 22 row.
 */
function payShortfallNote(
  seriesName: string,
  s: PayShortfall,
  checkedThrough: string | null | undefined,
  formatDay: (iso: string) => string,
  surplusSpeaks: boolean,
  unattached: readonly UnattachedMatch[],
): PayNote | null {
  // the money beyond the read paydays a period over this one nets — the surplus note names it when it speaks
  const holds = !surplusSpeaks && s.noPaydayBeyondCents + s.otherBeyondCents > 0;
  if (s.readPaydays === 0) return unreadPaydaysNote(seriesName, s, checkedThrough, formatDay, holds);
  if (s.shortCents <= 0 && s.wentBackOut.length === 0 && !holds) return null;

  // the paydays inside the span the lead names, so the span's year is theirs
  const payday = (iso: string): string => formatDayShortIn(iso, s.lastReadOn ?? iso);
  const outside = paidOutsidePhrases(s.paidOutside, payday, formatDay);
  // ⚖️ "never" only past a payday's days to land (`unbankedSplit`); inside them, the forecast's "not banked yet"
  const notYet = s.notBankedYetCents > 0 ? [`${formatCents(s.notBankedYetCents)} is not banked yet`] : [];
  // ⛔ …and of it, what the rows the one rule matched to the window's read paydays answer (`neverSplit`)
  const neverPart = neverSplit(s.neverBankedCents, unattachedAmong(unattached, s.firstReadOn, s.lastReadOn));
  const never = neverClauses(neverPart, payday, { ofIt: false, bare: false });
  const rest = [...outside, ...notYet, ...never];

  const noPaydayFrom = depositsOf(s.towardNoPayday.map((d) => d.depositOn), formatDay);
  const noPayday =
    s.noPaydayInsideCents > 0
      ? ` (${formatCents(s.noPaydayInsideCents)} of it, from the ${noPaydayFrom}, went ${TOWARD_NO_PAYDAY})`
      : "";
  const banked = `${formatCents(s.bankedInsideCents)} was banked inside the window${noPayday}`;

  const lead = `${seriesName}'s ${paydaysOverSpan(s.firstReadOn, s.lastReadOn)} came to ${formatCents(s.readCents)}`;
  const split =
    s.bankedInsideCents > 0
      ? rest.length === 0
        ? `, and all of it was banked inside the window${noPayday}`
        : `, of which ${AND_LIST.format([banked, ...rest])}`
      : outside.length === 0 && notYet.length === 0
        ? noneBankedSplit(neverPart, rest, payday)
        : outside.length === 0 && never.length === 0
          ? ", and none of it is banked yet"
          : `, and none of it was banked inside the window: ${AND_LIST.format(rest)}`;

  // why it is not banked yet, beside the claim: the days its deposits have to land run past the checked day — the
  // stale verdict's words on Earned vs banked (`daysToLandRunPast`)
  const days = s.notBankedYetPaydays;
  const grace =
    days.length > 0 && checkedThrough ? `; ${daysToLandRunPast(days, checkedThrough, payday, formatDay)}` : "";
  // ⛔ the days the parenthesis named are named once: the rest of their money is "the same deposit's" (review of the
  // shortfall batch: "from the deposits of A and B" twice, for money no day is told apart in)
  const restFrom = noPayday === "" ? noPaydayFrom : s.towardNoPayday.length === 1 ? "same deposit" : "same deposits";
  // what the money beyond the read paydays did not pay, counted back as the lead counts them (`onePayday`). 🔴 "paid
  // none of them" of the one payday the lead names (review of batch 6): on his ledger copy 2026-10-29 with a
  // Salary-filed −$1,141.92 on Fri Sep 25 and Wells Fargo derived through Fri Oct 16, Sep 21 – 27 read "…'s payday on
  // Sep 24, 2026 came to $1,141.92, and all of it was banked inside the window; another $4,567.68 … paid none of them"
  const notTheirs = onePayday(s.firstReadOn, s.lastReadOn) ? "did not pay that payday" : "paid none of them";
  const another = anotherBankedInside(beyondParts(s, payday, restFrom, formatDay), notTheirs);
  const beyond = another === "" ? "" : `; ${another}`;
  const back = s.wentBackOut.length === 0 ? "" : `; ${wentBackOutPhrase(s.wentBackOut, formatDay)}`;
  // the checked day is named in full once: `grace` named it
  const unlooked = unlookedPhrase(s.unlookedPaydays, checkedThrough, formatDay, "more ", grace === "");

  return { kind: "shortfall", body: `${lead}${split}${grace}${beyond}${back}${unlooked}.` };
}

/**
 * A shortfall with nothing banked inside the window, nothing from outside it and nothing still inside its days to land:
 * "and none of it reached a bank" — or, where rows the one rule matched answer it (`neverSplit`), "and all of it is
 * matched to the cent by rows of …", or both parts, each named.
 */
function noneBankedSplit(never: NeverSplit, rest: readonly string[], payday: (iso: string) => string): string {
  if (never.matchedCents === 0) return ", and none of it reached a bank";
  if (never.matchedCents === never.cents) return `, and ${neverClauses(never, payday, { ofIt: false, bare: true })[0]}`;
  return `, and none of it was banked inside the window: ${AND_LIST.format(rest)}`;
}

/**
 * Of the rows the one rule matched over a schedule's life, those for paydays inside `[from, to]` — a window's read ones
 * (the shortfall note), or the ones its lead counts (the note for a stale schedule). Neither names another window's row.
 */
function unattachedAmong(
  matches: readonly UnattachedMatch[],
  from: string | null,
  to: string | null,
): readonly UnattachedMatch[] {
  if (from === null || to === null) return [];
  return matches.filter((m) => compareDates(m.date, from) >= 0 && compareDates(m.date, to) <= 0);
}

/**
 * "$1,141.92 (Oct 1) was paid early, by the deposit of Wed, Sep 30, 2026" — what each deposit day OUTSIDE a period put
 * into its read paydays (`PayShortfall.paidOutside`), "early" when it landed before the period (§6A 29). ⛔ One spelling
 * for the shortfall note and the note for a stale schedule (review of 337baa7).
 */
function paidOutsidePhrases(
  parts: readonly PaidOutside[],
  payday: (iso: string) => string,
  formatDay: (iso: string) => string,
): string[] {
  return parts.map(
    (p) =>
      `${formatCents(p.cents)} (${AND_LIST.format(p.paydays.map(payday))}) was paid ${p.early ? "early, " : ""}by ` +
      `the ${depositsOf([p.depositOn], formatDay)}`,
  );
}

/** One period's pay note beside its figures: the shortfall note, or — no payday read — the note on its money. */
interface PayNote {
  kind: "shortfall" | "unread";
  body: string;
}

/**
 * A period with NO READ payday — every one it holds is past `LAST_CHECKED_DAY` — has no paydays to say "came to" of,
 * but its money still counts in a period over it that reads paydays: Earned vs banked nets money that paid a payday no
 * period reads, and money that went back out on a day of its own. So it names that money, and nothing else — only
 * where a period over it could net it (an account the pay lands in is checked). Null when there is none to name.
 *
 * 🔴 Review of 36f212f, his ledger copy (checked through Thu Sep 24): with Wed Sep 30 and Wed Oct 7 imported past the
 * statement, the year said $8,833.16 never reached a bank, June $2,741.00 and Q3 $7,234.08, and October and Q4 said
 * nothing of Oct 7's $1,141.92; with Sep 30's returned on Fri Oct 2, they read "paydays came to $0.00, and none of it
 * reached a bank".
 */
function unreadPaydaysNote(
  seriesName: string,
  s: PayShortfall,
  checkedThrough: string | null | undefined,
  formatDay: (iso: string) => string,
  holds: boolean,
): PayNote | null {
  if (!checkedThrough || (!holds && s.wentBackOut.length === 0)) return null;
  const payday = (iso: string): string => formatDayShortIn(iso, iso);
  const noPaydayFrom = depositsOf(s.towardNoPayday.map((d) => d.depositOn), formatDay);
  const parts = [
    ...beyondParts(s, payday, noPaydayFrom, formatDay).map(
      (p) => `${formatCents(p.cents)} banked inside the window${p.words}`,
    ),
    ...(s.wentBackOut.length === 0 ? [] : [wentBackOutPhrase(s.wentBackOut, formatDay)]),
  ];
  const unlooked = unlookedPhrase(s.unlookedPaydays, checkedThrough, formatDay, "");
  return { kind: "unread", body: `Of ${seriesName}'s pay, ${AND_LIST.format(parts)}${unlooked}.` };
}

/** The period's passed paydays past the checked day that no deposit settled — decision 65's words. Empty when none. */
function unlookedPhrase(
  n: number,
  checkedThrough: string | null | undefined,
  formatDay: (iso: string) => string,
  more: "more " | "",
  namesDay = true,
): string {
  if (n <= 0 || !checkedThrough) return "";
  return (
    `; ${n} ${more}${n === 1 ? "payday in the window falls" : "paydays in the window fall"} after ` +
    `${formatDay(checkedThrough)}${namesDay ? `, ${LAST_CHECKED_DAY}` : ""} — so ${notLookedForDeposits(n)}`
  );
}

/**
 * The period's money the split does not hold: what paid another period's payday (`paidAcross`), what paid a payday no
 * period reads — one of its own past the checked day (`paidUnread`), one before it past the checked day, or one not
 * yet passed or after it, paid early (`paidUncounted`, the surplus note's words) — and what paid none of these
 * paydays — so the banked figure, with these, is every deposit inside the period, as the page's income counts it. A
 * part of the money beyond the read paydays is capped at what is left of it, so the parts add up; what no payday took
 * — change over a payday's worth — is `MORE_THAN_ITS_PAYDAYS`. Empty when there is none.
 *
 * 🔴 Review of f6da264: money for a payday no period reads that was not one of the period's own passed ones fell into
 * the rest. On his ledger copy 2026-10-21 with Wed Sep 30 and Wed Oct 7 imported past the Sep 24 statement, on Wed
 * Oct 7, October and Q4 read "Of It America LLC (weekly pay)'s pay, $1,141.92 banked inside the window went toward no
 * payday on or before Thu, Sep 24, 2026" while the week of Oct 5 – 11 said it "paid Oct 8's payday early".
 * ⛔ The rest's words are no caller's to choose: 🔴 review of 619ceb4 (MEDIUM) — the shortfall note kept its own, so on
 * his ledger copy with Wed Sep 30 +$1,141.92 and Wed Oct 7 +$1,500.00 and Wells Fargo derived through Oct 14, on Oct 14,
 * October read "another $358.08 banked inside the window went toward none of these paydays" while the week of Oct 5 –
 * 11 said the same $358.08 "was more than the paydays its deposits paid came to".
 */
function beyondParts(
  s: PayShortfall,
  payday: (iso: string) => string,
  noPaydayFrom: string,
  formatDay: (iso: string) => string,
): { cents: number; words: string }[] {
  // the money beyond the read paydays, by the paydays it paid: before the period or its own, then early
  const own = [
    { portions: [...s.paidUncounted.filter((p) => !p.early), ...s.paidUnread], early: false },
    { portions: s.paidUncounted.filter((p) => p.early), early: true },
  ].reduce(
    (acc, g) => {
      const cents = Math.min(acc.leftCents, centsOf(g.portions));
      if (cents <= 0) return acc;
      const from = depositsOf([...new Set(g.portions.map((p) => p.depositOn))].sort(compareDates), formatDay);
      const words = `, from the ${from}, paid ${paydaysNamed(paydaysOf(g.portions), payday)}${g.early ? " early" : ""}`;
      return { leftCents: acc.leftCents - cents, parts: [...acc.parts, { cents, words }] };
    },
    { leftCents: s.otherBeyondCents, parts: [] as { cents: number; words: string }[] },
  );
  return [
    ...paidAcrossParts(s.paidAcross, payday, formatDay),
    ...own.parts,
    ...(s.noPaydayBeyondCents > 0
      ? [{ cents: s.noPaydayBeyondCents, words: `, from the ${noPaydayFrom}, went ${TOWARD_NO_PAYDAY}` }]
      : []),
    ...(own.leftCents > 0 ? [{ cents: own.leftCents, words: ` ${MORE_THAN_ITS_PAYDAYS}` }] : []),
  ];
}

/**
 * ", from the deposit of Wed, Sep 30, 2026, paid Oct 1's payday early" — what each deposit day inside a period put into
 * ANOTHER period's read payday (`PayShortfall.paidAcross`), "early" when that payday is after the period (§6A 29). ⛔ One
 * spelling for the shortfall note and the note for a stale schedule (review of 0c9bc8d).
 */
function paidAcrossParts(
  parts: readonly PaidAcross[],
  payday: (iso: string) => string,
  formatDay: (iso: string) => string,
): { cents: number; words: string }[] {
  return parts.map((p) => ({
    cents: p.cents,
    words:
      `, from the ${depositsOf([p.depositOn], formatDay)}, paid ${paydaysNamed(p.paydays, payday)}` +
      (p.early ? " early" : ""),
  }));
}

/**
 * "another $1,141.92 banked inside the window, from the deposit of …, paid Oct 1's payday early" — or, of several,
 * "another $X banked inside the window <several>: $A, from … and $B, from …" — the period's money its figures before it
 * do not hold, each part with what it paid. Empty when there is none. ⛔ One sentence for the shortfall note and the note
 * for a stale schedule (review of 0c9bc8d); `several` is what the parts did, in the words of the note it closes.
 */
function anotherBankedInside(parts: readonly { cents: number; words: string }[], several: string): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return `another ${formatCents(parts[0]!.cents)} banked inside the window${parts[0]!.words}`;
  return (
    `another ${formatCents(centsOf(parts))} banked inside the window ${several}: ` +
    AND_LIST.format(parts.map((p) => `${formatCents(p.cents)}${p.words}`))
  );
}

/** "Oct 1's payday", "the paydays of Oct 1 and Oct 8" — one spelling for the surplus note and the shortfall note. */
const paydaysNamed = (days: readonly string[], payday: (iso: string) => string): string =>
  days.length === 1 ? `${payday(days[0]!)}'s payday` : `the paydays of ${AND_LIST.format(days.map(payday))}`;

/**
 * What a period's surplus was, read off the settlement (`payShortfall`), as the sentences after the surplus note's
 * lead: pay for a LATER payday banked early — decisions 29/32's words, the money /budgets' next month names "paid
 * early" and the next period's shortfall note "was paid early, by the deposit of" the same day — money that paid no
 * payday, in the calendar's words (`TOWARD_NO_PAYDAY`), and the rest, earlier pay arriving late. Each part is capped at
 * what is left of the surplus, so the parts add up to it; a reading taken without the settlement keeps the one
 * sentence it always had.
 *
 * 🔴 It called ALL of a surplus "earlier pay arriving late — … a backlog clearing" (review of a4b0fca). With payroll
 * landing the Wednesday before the Thursday it pays (his §6A 29 shape), September's Wed Sep 30 pays Thu Oct 1:
 * September called that week of October's pay a backlog clearing while October named the same $1,141.92 paid early,
 * by the deposit of Sep 30. And Jun 5 – Jun 5, holding only the $400.00 that paid no payday, read it as earlier pay.
 */
function surplusSplit(
  surplusCents: number,
  s: PayShortfall | undefined,
  lastPeriodOn: string | null,
  formatDay: (iso: string) => string,
): string {
  const backlog = (cents: number): string =>
    ` One deposit can bank several paydays at once, so ` +
    `${cents === surplusCents ? "the surplus" : `the other ${formatCents(cents)}`} is earlier pay arriving late — ` +
    `read it as a backlog clearing rather than as a period that earned more.`;
  if (s === undefined) return backlog(surplusCents);

  const aheadCents = Math.min(surplusCents, centsOf(s.paidAhead));
  const noPaydayCents = Math.min(surplusCents - aheadCents, centsOf(s.towardNoPayday));
  // ⚖️ of the rest, only money that paid a payday BEFORE the period is earlier pay arriving late — read or not
  // (`paidAcross`, `paidUncounted`); what is left is change over the paydays its deposits paid (default built, not
  // asked, 2026-10-21)
  const lateCents = Math.min(
    surplusCents - aheadCents - noPaydayCents,
    centsOf([...s.paidAcross, ...s.paidUncounted].filter((p) => !p.early)),
  );
  const restCents = surplusCents - aheadCents - noPaydayCents - lateCents;

  // named as the shortfall note names a payday, in the year of the period's own paydays
  const payday = (iso: string): string => formatDayShortIn(iso, lastPeriodOn ?? iso);
  const paydays = paydaysNamed(paydaysOf(s.paidAhead), payday);
  const aheadFrom = depositsOf(s.paidAhead.map((p) => p.depositOn), formatDay);
  const noPaydayFrom = depositsOf(s.towardNoPayday.map((d) => d.depositOn), formatDay);
  const ahead =
    aheadCents > 0 ? ` ${formatCents(aheadCents)} of it, from the ${aheadFrom}, paid ${paydays} early.` : "";
  const noPayday =
    noPaydayCents > 0
      ? ` ${formatCents(noPaydayCents)} of it, from the ${noPaydayFrom}, went ${TOWARD_NO_PAYDAY}.`
      : "";
  const over = restCents > 0 ? ` ${formatCents(restCents)} of it ${MORE_THAN_ITS_PAYDAYS}.` : "";
  return `${ahead}${noPayday}${over}${lateCents > 0 ? backlog(lateCents) : ""}`;
}

/**
 * ⚖️ CHANGE OVER A PAYDAY'S WORTH — money a deposit that paid paydays brought beyond them (`PayShortfall`'s
 * `otherBeyondCents` once the paydays it paid are named) — in one sentence on every period: the surplus note's, the
 * shortfall note's and the note of a period with no read payday (`beyondParts`). Default built, not asked (2026-10-21).
 * 🔴 On his ledger copy with Wed Oct 7 +$1,500.00 imported, on Oct 14, October said its $358.08 "went toward no payday
 * on or before Thu, Sep 24, 2026" — the calendar's words for a deposit that paid no payday, of one the calendar draws
 * paying Oct 8 — and the week of Oct 5 – 11 called the same $358.08 "earlier pay arriving late — … a backlog
 * clearing", though it paid no earlier payday (review of the shortfall batch); read through Oct 14 with Wed Sep 30 in
 * too, October's shortfall note said it "went toward none of these paydays" (review of 619ceb4).
 */
const MORE_THAN_ITS_PAYDAYS = "was more than the paydays its deposits paid came to";
