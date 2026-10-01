import { and, asc, count, desc, eq, inArray, lte, gte, ne, sum } from "drizzle-orm";
import { unverifiedDetail } from "@/lib/coverage-detail";
import { formatDayFull } from "@/lib/format-date";
import type { AppDatabase } from "@/db/client";
import { accounts, type AccountType } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { KEPT_OPENING_SOURCE, balanceAnchors, dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { budgets, type BudgetPeriodKind } from "@/db/schema/budgets";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, type AssetType } from "@/db/schema/holdings";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { diffDays, todayIso } from "@/lib/dates";
import { isStaleClose } from "@/lib/holding-price-age";
import { formatCents } from "@/lib/money";
import { emptyPeriodReason } from "@/lib/empty-period";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { outsidePortfolioCashAccountIds, ownPortfolioAccountIds } from "./accounts";
import { activeTxnsInRange, loadCategoryIndex, offAgentsCash, spendingBucket, uncategorizedWhere } from "./analytics";
import { handTypedDays, keptOpeningOf } from "./anchor-winners";
import { accountCoverage, chainFooting, footingThrough, type AccountCoverage, type CoverageGrade } from "./coverage";
import {
  derivesFromHoldings,
  heldBalanceAnchor,
  loadReplayAnchors,
  loadReplayInputs,
  pickWinners,
  selectEndpoints,
  type ReplayAnchor,
} from "./derivation";
import { VERDICT_PRESENTATION } from "@/lib/provenance-verdict";
import { MIN_OCCURRENCES } from "./recurring";

/**
 * "Prove it" — given a figure the app has rendered, what is it standing on?
 *
 * Sixty passes bought a ledger where every number is checkable and no UI
 * anywhere shows the check. Four tables already hold the whole chain and
 * nothing joins them for a reader:
 *
 *   `import_files`      the document, its parser and when it was read
 *   `statement_periods` the arithmetic gate and its verdict
 *   `balance_anchors`   the observation a day's balance rests on, and which
 *                       document it came from (`import_file_id`)
 *   `daily_balances`    what the replay concluded about each day (`basis`)
 *
 * ## The honest answer is often "derived", and that is the point
 *
 * This service exists as much to say *"nothing checks this"* as to say *"a
 * statement says so"*. `derived_unverified` is the app's own admission that it
 * replayed past its last anchor with nothing to land on, and surfacing that is
 * worth more than another confident-looking number. A figure with no proof must
 * come back {@link ProvenanceVerdict} `unverified`, never a shrug.
 *
 * ## Two arbiters, not one
 *
 * ⛔ Counting coverage by `statement_periods` alone overstates the hole roughly
 * threefold, and two agents in one pass disagreed by exactly that. There are
 * TWO independent gates and an account needs only one of them:
 *
 *  1. **Statement reconciliation** — `previous + activity = new`, per period.
 *  2. **The anchor chain** — a day is `derived` only if replaying every
 *     transaction forward from one anchor lands EXACTLY on the next.
 *
 * Chase Checking has a 22-month stretch with no statement and not one `gap`
 * day: its CSV closes the chain, so the money is checked, coarsely. Reporting
 * it as unproven because a PDF is missing would be false.
 *
 * ⚠️ And the reverse: for an INVESTMENT account `derived` is written by the
 * price walk, not by a transaction replay, and reconciliation stamps
 * `value_anchor` unconditionally — it cannot fail. Those figures are marked to
 * market, so they get their own verdict rather than borrowing a word that means
 * something stronger elsewhere.
 */

export type ProvenanceVerdict =
  /** a source document states this number */
  | "sourced"
  /** computed, and the arithmetic closes against a source document */
  | "derived"
  /** priced from holdings — a value, not an arithmetic result */
  | "market_value"
  /** computed, and nothing checks it */
  | "unverified"
  /** the owner entered this by hand; he is the source */
  | "manual"
  /** computed, and the arithmetic provably does NOT close */
  | "broken"
  /** nothing to stand on yet */
  | "unknown";

/** Ordered worst-first: a total is only as proven as its weakest input. */
const VERDICT_RANK: Record<ProvenanceVerdict, number> = {
  broken: 0,
  unknown: 1,
  unverified: 2,
  market_value: 3,
  manual: 4,
  derived: 5,
  sourced: 6,
};

export function weakestVerdict(verdicts: readonly ProvenanceVerdict[]): ProvenanceVerdict {
  if (verdicts.length === 0) return "unknown";
  return verdicts.reduce((worst, v) => (VERDICT_RANK[v] < VERDICT_RANK[worst] ? v : worst));
}

export interface ProvenanceSource {
  kind: "document" | "period" | "anchor" | "hand-entered";
  /** the document's own name, or what the owner did */
  label: string;
  /** what this source contributes — a verdict, a balance, a date */
  detail?: string;
  /** the day this source speaks about */
  on?: string;
}

/** One contributing figure, for totals assembled out of other numbers. */
export interface ProvenanceInput {
  label: string;
  verdict: ProvenanceVerdict;
  detail?: string;
  /**
   * Stable identity of the contributor — an account id for `netWorth`.
   *
   * ⚠️ Present so a caller can JOIN to this list instead of guessing at it. The
   * dashboard's trust card first matched by array index with a label fallback,
   * which is an invariant across a service boundary rather than a contract:
   * it holds only because `netWorthProvenance` happens to build `inputs` as
   * `coverage.map(...)`, and nothing stops a future reorder or filter here from
   * silently mispairing every row.
   */
  id?: string;
  /**
   * Contributes NOTHING and is missing nothing — no rows and no balance.
   *
   * ⛔ Published as data because it is a real distinction that was otherwise
   * expressible only as PROSE ("empty — no rows, no balance" versus "N rows but
   * no recorded balance"), and a caller that needs it was left parsing that
   * sentence or re-deriving the predicate. Two definitions of one idea is a
   * defect; this is the one definition.
   *
   * An empty account is excluded from the verdict and counted separately in the
   * headline — see the five-bucket note in `netWorthProvenance`.
   */
  isEmpty?: boolean;
}

export interface Provenance {
  verdict: ProvenanceVerdict;
  /**
   * One sentence, written for a reader rather than a developer.
   *
   * ⚠️ Figures ARE allowed here, unlike in `InfoTip`. That rule exists because
   * a Tooltip's body is live DOM even while closed, so its text collides with
   * page-level assertions; `Popover` gates its children on `open` and mounts
   * nothing until then. The distinction is why this ships on Popover.
   */
  headline: string;
  sources: ProvenanceSource[];
  /** the last day the money behind this figure provably added up */
  checkedThrough: string | null;
  /** for a total: what it was assembled from, each carrying its own verdict */
  inputs: ProvenanceInput[];
  /**
   * Overrides the badge's word for a COMPOSITE figure.
   *
   * ⛔ The weakest-verdict rule is right about correctness and wrong about
   * vocabulary. Net worth takes `unknown` from one empty-balance account, and
   * a badge reading "no basis yet" beside a figure where 6 of 12 accounts add
   * up is simply false — it was on screen before a screenshot caught it. The
   * TONE still comes from the verdict, because a hole really is a weakness;
   * only the word changes, to one that describes the mixture.
   */
  badgeWord?: string;
}

export type FigureRef =
  | { kind: "transaction"; id: string }
  | { kind: "accountBalance"; accountId: string; day?: string }
  | { kind: "statementPeriod"; id: string }
  | { kind: "netWorth"; day?: string }
  /**
   * Any total assembled by summing transactions in a category over a window —
   * a category page's spend, a budget's actual, a month's line on /spending.
   * They are ONE figure kind because they are one question: which documents is
   * this sum standing on, and is any of it unchecked?
   */
  | { kind: "categorySpend"; categoryId: string; from: string; to: string; label?: string }
  /**
   * One merchant's spend over a window. Same shape and same grading as
   * `categorySpend` — a different set of rows, and therefore a different answer
   * to "how many rows is this, and which documents carry them?"
   */
  | { kind: "merchantSpend"; merchantId: string; from: string; to: string; label?: string }
  /**
   * Every ACTIVE row on one account — the figure behind "N transactions landed
   * in X since it opened". Same grading as `categorySpend` and `merchantSpend`,
   * over the rows that count was taken of.
   */
  | { kind: "accountRows"; accountId: string; label?: string }
  /**
   * A position's market value, aggregated across accounts by `(symbol,
   * assetType)` exactly as `holdingDetail` reports it. NOT `categorySpend`: a
   * holding's value is a share count times a price, and the two halves are
   * proven — or not — in completely different ways.
   */
  | { kind: "holding"; symbol: string; assetType: AssetType; day?: string }
  /** A recurring series' expected amount — a forecast, graded by its evidence. */
  | { kind: "recurringSeries"; id: string }
  /**
   * ALL spending in a window — no category and no merchant filter. The figure
   * `/spending` puts on its "Spent" card and states under its relief.
   *
   * ⛔ NOT `categorySpend` over some root, because there is no root: the app's
   * spending total is the union of every top-level `expense` category AND every
   * uncategorized outflow, and no category id names that set.
   */
  | {
      kind: "allSpend";
      from: string;
      to: string;
      label?: string;
      /**
       * A second window this figure is COMPARED against — a year-over-year
       * line, where the claim rests on both halves equally.
       *
       * ⛔ Present because proving one half of a comparison is proving half the
       * claim. `spending-insights` already renders a `rose_between` delta and
       * proves only its current window, which is a looseness this deliberately
       * does not extend to a sentence about a whole year: "spending rose by
       * $34,849.14 between the same days of 2025 and 2026" stands on 2025's
       * documents exactly as much as on 2026's, and a proof that named only one
       * year would be quietly answering a different question than the one the
       * badge is attached to.
       */
      against?: { from: string; to: string; label?: string };
    }
  /**
   * A budget's PLAN amount — the one figure in this app that is a decision
   * rather than a measurement.
   *
   * ⛔ Deliberately not `categorySpend` over the budget's window, which is what
   * `/budgets` already mounts beside the ACTUAL. The two numbers on a budget row
   * are proven in completely different ways: the actual is a sum of documented
   * rows, the plan is a thing he chose, and one proof cannot cover both.
   */
  | { kind: "budgetPlan"; id: string; label?: string };

/**
 * Cash accounts only: what a day's `basis` proves about its balance.
 *
 * ⛔ `carried` is NOT a weak basis, and reading it as one is the first thing
 * this service got wrong. `deriveForward` (derivation.ts) writes
 * `sawTxn ? "derived_unverified" : "carried"` — so `carried` means **no
 * transaction has happened since the last recorded balance**, and the number is
 * therefore exactly as proven as the anchor it came from. Between two anchors
 * it is written only when the two AGREE (`a.balanceCents === b.balanceCents`);
 * when they disagree the day is `gap`.
 *
 * Today is almost always after the newest statement with nothing posted since,
 * so most accounts read `carried` on most days. Grading that "unverified" made
 * the first draft of this service announce "0 of 12 accounts add up against a
 * document" on a ledger with **zero** gap days — false, and the kind of false
 * that teaches a reader to ignore the badge.
 */
const BASIS_VERDICT: Record<BalanceBasis, ProvenanceVerdict> = {
  anchored: "sourced",
  derived: "derived",
  carried: "derived",
  derived_unverified: "unverified",
  gap: "broken",
};

/** `accountCoverage`'s per-account grade, in this service's vocabulary. */
const GRADE_VERDICT: Record<CoverageGrade, ProvenanceVerdict> = {
  verified: "derived",
  unverified: "unverified",
  broken: "broken",
  market_value: "market_value",
  manual: "manual",
  unknown: "unknown",
};

function isInvestment(type: string): boolean {
  return type === "investment" || type === "crypto";
}

/**
 * The badge word a `market_value` figure wears when a holding does NOT price
 * all of it, so the trigger's accessible name stops saying one does.
 *
 * ⛔ With no badge word, `provenanceTriggerName` completes the name with
 * `VERDICT_PRESENTATION.market_value.ariaSuffix` — "is priced from holdings,
 * not checked by arithmetic". `market_value` is every investment account;
 * `derivesFromHoldings` decides which of them a holding prices. The word is the
 * verdict's own, so the visible badge reads exactly as it did.
 *
 * ⚠️ Not for a holding's own proof: that figure IS a count × a price, whatever
 * the account's curve is built from.
 */
function marketValueBadgeWord(pricedFromHoldings: boolean): string | undefined {
  return pricedFromHoldings ? undefined : VERDICT_PRESENTATION.market_value.word;
}

/**
 * One account's stored chain, read the way `accountCoverage` grades it: which
 * days close, the newest that does, and which recorded balance a day stands on.
 *
 * ⛔ `chainFooting` is the rule, so a balance proof and a row's sheet cannot
 * call a day checked that /imports and every total call unchecked. The anchors
 * are the replay's own (`loadReplayAnchors`), so the balance a day is said to
 * stand on is the one the rebuild used.
 */
interface ChainFacts {
  winners: ReplayAnchor[];
  closed: ReadonlySet<string>;
  /** days that stand on a count of his and nothing else — `chainFooting` */
  counted: ReadonlySet<string>;
  /** the newest day on a closed chain — what "checked through" may name */
  lastClosed: string | null;
}

function chainFacts(db: AppDatabase, accountId: string): ChainFacts {
  const winners = pickWinners(loadReplayAnchors(db, accountId));
  const balances = db
    .select({ day: dailyBalances.day, basis: dailyBalances.basis })
    .from(dailyBalances)
    .where(eq(dailyBalances.accountId, accountId))
    .orderBy(asc(dailyBalances.day))
    .all();
  const { closed, counted } = chainFooting(balances, handTypedDays(winners));
  return { winners, closed, counted, lastClosed: [...closed].at(-1) ?? null };
}

/** The source of the balance recorded ON a day, when one was — the day's winner. */
function recordedOn(chain: ChainFacts, day: string): string | null {
  return chain.winners.find((w) => w.anchoredOn === day)?.source ?? null;
}

/**
 * The recorded balance a cash day stands on: the newest replay endpoint on or
 * before it. A bank export or a live reading is a moment the replay never
 * carries while a statement or a balance he typed exists (`selectEndpoints`).
 */
function restingOn(chain: ChainFacts, day: string): Pick<ReplayAnchor, "anchoredOn" | "source"> | null {
  return selectEndpoints(chain.winners).endpoints.filter((e) => e.anchoredOn <= day).at(-1) ?? null;
}

/** The replay endpoint after a day — where a replay across it lands. */
function nextEndpoint(chain: ChainFacts, day: string): Pick<ReplayAnchor, "anchoredOn" | "source"> | null {
  return selectEndpoints(chain.winners).endpoints.find((e) => e.anchoredOn > day) ?? null;
}

/**
 * A cash day's balance in this service's vocabulary — ONE rule for an
 * account's balance proof and the day line on a row's sheet.
 *
 * ⛔ A balance he typed is `manual`, and so is a day carried from it that no
 * closed chain reaches: carried is "as proven as the balance it came from", and
 * that balance is his count. Carried from a statement, or from a count the
 * replay landed on, it still adds up.
 *
 * 🔴 …and so is a replay from one of his counts onto another. It read "adds up"
 * under "Every transaction was replayed forward from a recorded balance and
 * landed exactly on the next one" when both balances were his (real ledger
 * copy with a second Cash on Hand count, 2026-09-16).
 */
function cashDayVerdict(chain: ChainFacts, day: string, basis: BalanceBasis): ProvenanceVerdict {
  if (basis === "anchored" && recordedOn(chain, day) === "manual") return "manual";
  if (chain.counted.has(day)) return "manual";
  if (basis === "carried") {
    const from = restingOn(chain, day);
    if (from?.source === "manual" && !chain.closed.has(from.anchoredOn)) return "manual";
  }
  return BASIS_VERDICT[basis];
}

/** `2026-08-24` → `Aug 24, 2026`, for a sentence rather than a table cell. */
function readableDay(day: string): string {
  return formatDayFull(day);
}

/**
 * `2365` → `2,365`, for a count inside a sentence or a badge.
 *
 * 🔴 `/accounts/<Robinhood Cash>` read "2,365 transactions landed in Robinhood
 * Cash since it opened" beside a badge reading "2364 of 2365 checked" on
 * 2026-09-14 — one count spelled two ways on one line. The insight grammar
 * (`lib/insight-facts` count display) has always grouped with this call; every
 * count this service prints goes through it so the two cannot disagree.
 */
function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

const PERIOD_VERDICT_TEXT: Record<string, string> = {
  reconciled: "reconciled to the cent",
  value_anchor: "value recorded — an investment statement sets a value, it never proves the rows add up",
  not_applicable: "coverage declared, but this file carries no balances to check against",
};

/* ── transaction ──────────────────────────────────────────────────────── */

function transactionProvenance(db: AppDatabase, id: string): Provenance | null {
  const txn = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!txn) return null;

  const account = db.select().from(accounts).where(eq(accounts.id, txn.accountId)).get();
  const day = db
    .select({ basis: dailyBalances.basis })
    .from(dailyBalances)
    .where(and(eq(dailyBalances.accountId, txn.accountId), eq(dailyBalances.day, txn.postedOn)))
    .get();

  if (txn.importFileId === null) {
    return {
      verdict: "manual",
      headline: "You entered this row by hand. No statement carries it, so nothing else can confirm it.",
      sources: [{ kind: "hand-entered", label: "entered by hand", on: txn.postedOn }],
      checkedThrough: null,
      inputs: [],
    };
  }

  const file = db.select().from(importFiles).where(eq(importFiles.id, txn.importFileId)).get();
  // the file's period FOR THIS ACCOUNT — a single file can carry several
  const period = db
    .select()
    .from(statementPeriods)
    .where(and(eq(statementPeriods.importFileId, txn.importFileId), eq(statementPeriods.accountId, txn.accountId)))
    .get();

  const sources: ProvenanceSource[] = [];
  if (file) {
    sources.push({
      kind: "document",
      label: file.fileName,
      detail: `read by ${file.parserProfile ?? "an unnamed parser"}`,
      on: file.importedAt.slice(0, 10),
    });
  }
  if (period) sources.push(periodSource(period));

  /**
   * ⛔ A row is NOT proven merely because a file carried it, and treating it
   * that way put a green "on a statement" badge on a row from the Rocket Money
   * export — a third-party re-export that carries no balances and is the least
   * trustworthy source in the app. Caught by opening the sheet and reading it.
   *
   * Both arbiters count, exactly as `accountCoverage` has them:
   *
   *  1. **The period reconciled** — opening + rows = closing, to the cent. That
   *     is a document proving this row's neighbourhood adds up.
   *  2. **The anchor chain** — the day's `basis`. A CSV import supplies a
   *     running balance as an ANCHOR and creates no period at all, so judging
   *     by periods alone would call every CSV-imported row unchecked when the
   *     chain closes on it exactly.
   *
   * With neither, the honest answer is the day's own verdict — `unknown` for
   * the Wells Fargo rows, which have no derived balance because the app refuses
   * to invent one.
   */
  const reconciled = period?.reconciliation === "reconciled";
  /*
   * 🔴 "carries no balances" was read off `reconciled` alone. An INVESTMENT
   * statement sets a value and is never reconciled by arithmetic, so its rows
   * took the "no balances" branch — while this same call's own `sources` entry
   * says the opposite: "value recorded — an investment statement sets a value,
   * it never proves the rows add up". Measured 2026-09-10 on a Robinhood
   * transaction: the period it names holds beginning_balance 150500 and
   * ending_balance 348049.
   *
   * ⛔ For the "records a value" branch the question is what the PERIOD
   * carries, so ask the period's balances — a Robinhood statement PDF also owns
   * an `ofx_ledger` anchor, and must keep reading "records a value".
   */
  const periodBalance = period?.endingBalanceCents !== null && period?.endingBalanceCents !== undefined;
  /*
   * 🔴 S31: …AND A FILE CAN RECORD A BALANCE WITH NO PERIOD AT ALL. A bank CSV
   * creates no statement period; its running balance lands in
   * `balance_anchors` as an `ofx_ledger` row (import/service.ts
   * `upsertAnchor(…, "ofx_ledger", fileRow.id, …)`). Reading "carries no
   * balances" off the period alone told 1,078 rows from
   * `Chase3522_Activity_20260710.CSV` "That file carries no balances of its
   * own" — of the file whose 2026-07-08 balance of $1,120.90
   * `/accounts/<Chase Checking>` lists under Recorded balances as "bank
   * export". Measured 2026-09-14. The other derived-day files (the Spending
   * Report PDFs, the Discover and Robinhood CSVs) own no anchor, and keep their
   * sentence.
   */
  const fileAnchor = db
    .select({ anchoredOn: balanceAnchors.anchoredOn })
    .from(balanceAnchors)
    .where(
      and(
        eq(balanceAnchors.importFileId, txn.importFileId),
        eq(balanceAnchors.accountId, txn.accountId),
        // ⛔ the file that keeps an opening from a statement he un-imported never printed that balance (`kept-openings`)
        ne(balanceAnchors.source, KEPT_OPENING_SOURCE),
      ),
    )
    .orderBy(desc(balanceAnchors.anchoredOn))
    .get();
  const dayVerdict: ProvenanceVerdict =
    day && account ? (isInvestment(account.type) ? "market_value" : BASIS_VERDICT[day.basis]) : "unknown";

  /*
   * 🔴 S19: AN ANCHORED DAY HAD NO BRANCH. A row whose own file reconciles
   * nothing, on a day ANOTHER document anchors, fell through to "which carries
   * no balances, so nothing checks the total it sits in" — under a green "on a
   * statement" badge, because the day's basis graded it `sourced`. Measured
   * 2026-09-14 on 177 rows, none of them on their own file's anchor day; the
   * FPL row from `Chase3522_Activity_20260710.CSV` (Jul 10, 2026) read exactly
   * that.
   *
   * ⛔ The badge is the owner's decision (2026-09-14, S19 option a): the grade
   * `rowGrade` gives this same row inside every category, merchant and spending
   * total — "adds up" wherever the account's chain is checked across the day.
   * The DAY keeps its own verdict in `inputs`, and only a reconciled period
   * covering the day earns a "checked through" date.
   */
  const dayAnchor = !reconciled && dayVerdict === "sourced" ? anchorOnOrBefore(db, txn.accountId, txn.postedOn) : null;
  const anchorOfDay = dayAnchor !== null && dayAnchor.anchor.anchoredOn === txn.postedOn ? dayAnchor : null;
  const checkingPeriod =
    dayAnchor === null
      ? undefined
      : periodsCovering(db, txn.accountId, txn.postedOn)
          .filter((p) => p.reconciliation === "reconciled")
          .at(-1);
  if (anchorOfDay) sources.push(anchorOfDay.source);
  if (checkingPeriod) sources.push(periodSource(checkingPeriod));

  /*
   * 🔴 S19 WAS SHIPPED AS A COPY OF THE RULE. This line read `dayVerdict ===
   * "sourced" ? "derived" : dayVerdict`, and the headline always ended "so the
   * total it sits in is checked", on the premise that a total grades the row
   * `derived`. A total grades it from the ACCOUNT's chain, not the day's basis:
   * on an anchored day after a gap the sheet read "adds up · checked through Jul
   * 10" while a total over that one row read "broken · 0 of 1 checked", and
   * after a run nothing checked, "unverified" (review of this branch,
   * 2026-09-15). The derived-day branch had the same split: a row after a gap
   * read "adds up" here and "nothing checking it" in every total.
   *
   * ⛔ `rowGrade` IS the rule. A statement that reconciles the row's own period
   * still says `sourced` — that is a document about this row, not a grade. An
   * investment row keeps the day's `market_value`, and an account
   * `accountCoverage` does not hold (a deactivated one) keeps the day's own
   * verdict rather than borrowing a total's `unknown`.
   *
   * Not live on the real ledger 2026-09-15: no account has a gap day, and the
   * only rows the day and the rule disagree about are Robinhood Cash's two
   * prehistory rows, which read `unverified` either way.
   */
  const coverage =
    account && !isInvestment(account.type) ? accountCoverage(db).find((c) => c.accountId === txn.accountId) : undefined;
  const verdict: ProvenanceVerdict = reconciled
    ? "sourced"
    : coverage
      ? rowGrade(coverage, txn.postedOn)
      : dayVerdict === "sourced"
        ? "derived"
        : dayVerdict;

  const headline = rowHeadline({
    fileName: file?.fileName,
    accountName: account?.name ?? "the account",
    reconciled,
    grade: verdict,
    dayVerdict,
    brokenSince: coverage?.brokenSince ?? null,
    periodBalance,
    fileAnchorOn: fileAnchor?.anchoredOn,
    anchorOfDay,
    rowFileId: txn.importFileId,
  });

  return {
    verdict,
    // 🔴 a row on an investment account no holding prices was named "priced from holdings"
    badgeWord: verdict === "market_value" && account ? marketValueBadgeWord(derivesFromHoldings(db, account)) : undefined,
    headline,
    sources,
    // a checked-through date only where the grade says the row is checked
    checkedThrough: reconciled ? period.periodEnd : verdict === "derived" ? (checkingPeriod?.periodEnd ?? null) : null,
    inputs:
      day && account
        ? [
            {
              label: `${account.name} on ${readableDay(txn.postedOn)}`,
              /*
               * 🔴 The day's own line read "on a statement" (`BASIS_VERDICT`) of a
               * balance he typed — the rule `accountBalanceProvenance` already
               * refused. One rule for both: `cashDayVerdict`.
               */
              verdict: isInvestment(account.type)
                ? dayVerdict
                : cashDayVerdict(chainFacts(db, txn.accountId), txn.postedOn, day.basis),
              detail: `the day's balance is ${day.basis.replace(/_/g, " ")}`,
            },
          ]
        : [],
  };
}

/** What a transaction's headline is built from — every fact already measured by the caller. */
interface RowHeadlineFacts {
  fileName: string | undefined;
  accountName: string;
  reconciled: boolean;
  /** the row's verdict — `rowGrade`'s, which decides whether "checked" may be said at all */
  grade: ProvenanceVerdict;
  /** the day's own basis, which decides how a checked row's check is described */
  dayVerdict: ProvenanceVerdict;
  /** the first day the account's chain missed a balance, when it has */
  brokenSince: string | null;
  /** the row's own period states an ending balance */
  periodBalance: boolean;
  /** the newest balance the row's own file recorded for this account */
  fileAnchorOn: string | undefined;
  /** the anchor ON the row's day, when the day is anchored */
  anchorOfDay: DayAnchor | null;
  rowFileId: string;
}

/**
 * One sentence per world a transaction's proof can be in. Each branch names
 * the document that actually carries the claim — see S19 and S31 above.
 */
function rowHeadline(f: RowHeadlineFacts): string {
  if (f.reconciled) {
    return `This row came from ${f.fileName ?? "a statement"}, and that statement's balances reconcile to the cent.`;
  }
  const from = `This row came from ${f.fileName ?? "an imported file"}`;
  const ownBalance = f.fileAnchorOn ? `, which recorded ${f.accountName}'s balance on ${readableDay(f.fileAnchorOn)}` : null;
  // ⛔ "checked" is said only of a row the grade calls checked — see S19 above
  if (f.grade === "derived") {
    if (f.dayVerdict === "sourced") {
      if (f.anchorOfDay?.anchor.importFileId === f.rowFileId) {
        return `${from}, which recorded ${f.accountName}'s balance on this very day, so the total it sits in is checked.`;
      }
      const own = ownBalance ? `${ownBalance} — and` : ", which carries no balances of its own — but";
      const by = f.anchorOfDay
        ? `was recorded by ${f.anchorOfDay.anchor.source === "manual" ? "you" : f.anchorOfDay.source.label}`
        : "is anchored";
      return `${from}${own} ${f.accountName}'s balance on this day ${by}, so the total it sits in is checked.`;
    }
    return ownBalance
      ? `${from}${ownBalance}, and ${f.accountName}'s chain closes across this day.`
      : `${from}. That file carries no balances of its own, but ${f.accountName}'s chain closes across this day.`;
  }
  if (f.grade === "broken" && f.brokenSince !== null) {
    return `${from}${ownBalance ?? ", which carries no balances of its own"} — but ${f.accountName}'s balance stopped adding up on ${readableDay(f.brokenSince)}, so nothing checks the total it sits in.`;
  }
  /*
   * 🔴 A day only his typed balance anchors was "checked" — "…was recorded by
   * you, so the total it sits in is checked" — with nothing replayed onto the
   * count. It is his word, and the sentence says so (see `closedChainDays`).
   */
  if (f.anchorOfDay?.anchor.source === "manual") {
    return `${from}${ownBalance ?? ", which carries no balances of its own"} — ${f.accountName}'s balance on this day was recorded by you, and nothing else confirms it, so nothing checks the total it sits in.`;
  }
  if (f.periodBalance) {
    return `${from}, which records a value for ${f.accountName} rather than proving the rows add up.`;
  }
  /*
   * 🔴 S31 AT THE OTHER END: this sentence told a row from a file that DID
   * record a balance — `Chase3522_Activity_20260710.CSV`, Chase Checking on Jul
   * 8 — that its file "carries no balances", whenever the row's own day was not
   * checked. The two branches above had been fixed and this one had not.
   */
  if (ownBalance && f.grade !== "market_value") {
    return `${from}${ownBalance} — but ${f.accountName}'s chain does not close across this day, so nothing checks the total it sits in.`;
  }
  return `${from} — which carries no balances, so nothing checks the total it sits in.`;
}

/** The balance a day rests on, and how a reader should hear its source named. */
interface DayAnchor {
  anchor: typeof balanceAnchors.$inferSelect;
  source: ProvenanceSource;
}

/**
 * The anchor a day rests on: the newest recorded balance at or before it — and,
 * among several recorded that same day, the one the replay itself uses.
 *
 * ⛔ ONE lookup for both proofs that name it. `accountBalanceProvenance` lists
 * it under "Standing on"; `transactionProvenance` names it in the headline of a
 * row whose day it anchors. Two queries would be two opinions about which
 * document pins a day.
 *
 * ⚠️ Ties go through `pickWinners` (statement → ofx_ledger → manual → live).
 * Ordered by day alone, SQLite returned whichever row came first — the trap
 * `removalEffect` documents for Discover's two anchors on 2024-08-18.
 */
function anchorOnOrBefore(db: AppDatabase, accountId: string, day: string): DayAnchor | null {
  const newest = db
    .select({ anchoredOn: balanceAnchors.anchoredOn })
    .from(balanceAnchors)
    .where(and(eq(balanceAnchors.accountId, accountId), lte(balanceAnchors.anchoredOn, day)))
    .orderBy(desc(balanceAnchors.anchoredOn))
    .limit(1)
    .get();
  if (!newest) return null;
  const [anchor] = pickWinners(
    db
      .select()
      .from(balanceAnchors)
      .where(and(eq(balanceAnchors.accountId, accountId), eq(balanceAnchors.anchoredOn, newest.anchoredOn)))
      .all(),
  );
  if (!anchor) return null;
  /*
   * ⚖️ An opening kept from a statement he un-imported (owner decision 20) is owned by the file that keeps the rows,
   * which never printed it: naming that file would put the balance in the mouth of an export that carries none.
   */
  if (anchor.source === KEPT_OPENING_SOURCE) {
    return {
      anchor,
      source: {
        kind: "anchor",
        label: "a statement you un-imported",
        detail: `the opening balance it printed for ${readableDay(anchor.anchoredOn)} — kept when you un-imported it, and nothing checks it`,
        on: anchor.anchoredOn,
      },
    };
  }
  const file = anchor.importFileId
    ? db.select().from(importFiles).where(eq(importFiles.id, anchor.importFileId)).get()
    : undefined;
  return {
    anchor,
    source: {
      kind: "anchor",
      label:
        anchor.source === "manual"
          ? "a balance you entered"
          : anchor.source === "live"
            ? "a live price reading"
            : file?.fileName ?? `a ${anchor.source.replace(/_/g, " ")} observation`,
      detail: `balance recorded on ${readableDay(anchor.anchoredOn)}`,
      on: anchor.anchoredOn,
    },
  };
}

/** Every statement period of an account that covers a day, oldest-closing first. */
function periodsCovering(db: AppDatabase, accountId: string, day: string) {
  return db
    .select()
    .from(statementPeriods)
    .where(
      and(
        eq(statementPeriods.accountId, accountId),
        lte(statementPeriods.periodStart, day),
        gte(statementPeriods.periodEnd, day),
      ),
    )
    .orderBy(asc(statementPeriods.periodEnd))
    .all();
}

function periodSource(p: { periodStart: string; periodEnd: string; reconciliation: string }): ProvenanceSource {
  return {
    kind: "period",
    label: `${p.periodStart} → ${p.periodEnd}`,
    detail: PERIOD_VERDICT_TEXT[p.reconciliation] ?? p.reconciliation,
  };
}

/* ── account balance ──────────────────────────────────────────────────── */

function accountBalanceProvenance(db: AppDatabase, accountId: string, day: string | undefined): Provenance | null {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return null;

  const row = day
    ? db
        .select()
        .from(dailyBalances)
        .where(and(eq(dailyBalances.accountId, accountId), eq(dailyBalances.day, day)))
        .get()
    : db
        .select()
        .from(dailyBalances)
        .where(eq(dailyBalances.accountId, accountId))
        .orderBy(desc(dailyBalances.day))
        .get();

  if (!row) {
    return {
      verdict: "unknown",
      headline: `Nothing is derived for ${account.name} yet — import a statement to start its chain.`,
      sources: [],
      checkedThrough: null,
      inputs: [],
    };
  }

  // the anchor this day rests on — the same lookup a transaction's proof names
  const anchor = anchorOnOrBefore(db, accountId, row.day);
  /*
   * 🔴 A BALANCE TYPED BY HAND READ "ON A STATEMENT". Every `anchored` day was
   * badged `sourced` and told "A statement records <acct>'s balance on <day>
   * directly. This is the number the bank printed." — whichever document, or
   * none, recorded it. Unreachable in practice while surfaces dated a balance by
   * the rebuild day; once an account observed only by recorded balances is dated
   * by the day one was recorded (S24), a checking account with one balance typed
   * in on Sep 11 read exactly that on its /accounts/[id] header (scratch
   * measurement, 2026-09-16). Not live on the real ledger: its one hand-typed
   * balance (Cash on Hand, Aug 3, 2026) is not the day any surface asks about.
   *
   * ⛔ The winning anchor ON the day decides — `pickWinners`, so a statement and a
   * hand-typed balance on one day read as the statement the replay uses. The
   * badge and the sentence move together: "you entered it" is the app's word for
   * the owner's own evidence (owner decision S33).
   */
  const recordedBy = row.basis === "anchored" && anchor?.anchor.anchoredOn === row.day ? anchor.anchor.source : null;
  /*
   * 🔴 …AND "CHECKED THROUGH" ONE. The last closed day was the newest `anchored`
   * or `derived` row, so a balance he typed was a day the chain closed on.
   * Measured 2026-09-16 on a copy of the real ledger: Cash on Hand's header asks
   * about Aug 11, 2026, and its popover read "nothing checks it" over "Checked
   * through 2026-08-03." — Aug 3 is his $5,000.00 count and nothing was replayed
   * onto it. A day carried from that count read "adds up".
   *
   * ⛔ `chainFacts` reads the rule `accountCoverage` grades by, and the headline
   * names the count for what it is: "the balance you recorded on Aug 3, 2026".
   */
  const chain = isInvestment(account.type) ? null : chainFacts(db, accountId);
  const verdict: ProvenanceVerdict = chain === null ? "market_value" : cashDayVerdict(chain, row.day, row.basis);
  const resting = chain === null ? null : restingOn(chain, row.day);
  // a replay that stands on his counts alone names both of them
  const countedReplay =
    chain !== null && row.basis === "derived" && chain.counted.has(row.day) && resting !== null
      ? { from: resting.anchoredOn, to: nextEndpoint(chain, row.day)?.anchoredOn ?? null }
      : null;
  const sources: ProvenanceSource[] = anchor ? [anchor.source] : [];

  // periods covering this day, and what each concluded
  for (const p of periodsCovering(db, accountId, row.day)) sources.push(periodSource(p));

  /*
   * ⛔ `market_value` covers every investment account; "priced from holdings" is
   * true only of one `derivesFromHoldings` says it of — the branch the rebuild
   * takes, and the one the remove-balance dialog on the same page already reads.
   */
  const pricedFromHoldings = derivesFromHoldings(db, account);
  const heldAtRecordedBalance = isInvestment(account.type) && !pricedFromHoldings;
  /*
   * 🔴 NOT `anchor` above: that is the newest recorded balance of any source, and
   * it named a bank export or a live reading the step-hold never carries. The
   * balance a held day IS comes from the rebuild's own endpoints.
   */
  const held = heldAtRecordedBalance
    ? heldBalanceAnchor(pickWinners(loadReplayInputs(db, account.id).anchors), row)
    : null;

  return {
    verdict,
    headline: headlineForBalance(account.name, account.type, row.basis, row.day, recordedBy, {
      pricedFromHoldings,
      recordedOn: held?.anchoredOn ?? null,
      countedOn: resting?.source === "manual" && resting.anchoredOn !== row.day ? resting.anchoredOn : null,
      countedReplay,
      keptOpeningOn: chain === null ? null : (keptOpeningOf(chain.winners)?.anchoredOn ?? null),
    }),
    sources,
    checkedThrough: chain?.lastClosed ?? null,
    inputs: [],
    badgeWord: isInvestment(account.type) ? marketValueBadgeWord(pricedFromHoldings) : undefined,
  };
}

/**
 * `recordedBy` — the source of the balance recorded ON an anchored day, or null.
 * `value` — how an investment account's figure is known: priced from holdings, or a
 * recorded balance held forward (an account with no holding events); and, for a
 * cash day after one, the day of the balance HE typed that it stands on.
 */
function headlineForBalance(
  name: string,
  type: string,
  basis: BalanceBasis,
  day: string,
  recordedBy: string | null,
  value: {
    pricedFromHoldings: boolean;
    recordedOn: string | null;
    countedOn: string | null;
    /** a replay from one count of his onto the next: the two days he counted */
    countedReplay: { from: string; to: string | null } | null;
    /** the opening kept from a statement he un-imported that every day replays from (`keptOpeningOf`) */
    keptOpeningOn: string | null;
  },
): string {
  const on = readableDay(day);
  if (isInvestment(type)) {
    if (value.pricedFromHoldings) {
      return `${name} is priced from its holdings on ${on}. A brokerage statement sets a value; it never proves the transactions add up.`;
    }
    const recorded =
      value.recordedOn === null
        ? "a recorded balance held forward"
        : value.recordedOn === day
          ? "the balance recorded that day"
          : `the balance recorded on ${readableDay(value.recordedOn)}, held forward`;
    return `${name}'s value on ${on} is ${recorded}. No holdings price it, and no transaction arithmetic checks it.`;
  }
  // a count of his is named as his, never as a "recorded balance" the reader could take for a statement
  const counted = value.countedOn === null ? null : `the balance you recorded on ${readableDay(value.countedOn)}`;
  switch (basis) {
    case "anchored":
      if (recordedBy === "manual") {
        return `You recorded ${name}'s balance on ${on} yourself. No statement carries it, so nothing else can confirm it.`;
      }
      if (recordedBy === "ofx_ledger") {
        return `A bank export records ${name}'s balance on ${on} directly. This is the number the bank printed.`;
      }
      if (recordedBy === "live") return `A live reading records ${name}'s balance on ${on}.`;
      return `A statement records ${name}'s balance on ${on} directly. This is the number the bank printed.`;
    case "derived":
      if (value.countedReplay !== null) {
        const onto =
          value.countedReplay.to === null
            ? "the next balance you recorded"
            : `the one you recorded on ${readableDay(value.countedReplay.to)}`;
        return `Every transaction was replayed forward from the balance you recorded on ${readableDay(value.countedReplay.from)} and landed exactly on ${onto}. Both are your own counts, so nothing else confirms ${name} on ${on}.`;
      }
      return `Every transaction was replayed forward from a recorded balance and landed exactly on the next one, through ${on}.`;
    case "derived_unverified":
      if (value.keptOpeningOn !== null) {
        return `Replayed from the opening balance of a statement you un-imported, printed for ${readableDay(value.keptOpeningOn)}, so nothing checks ${name} on ${on}. The rows are real; the total is unconfirmed.`;
      }
      return `Replayed past ${counted ?? "the last recorded balance"}, so nothing checks ${name} on ${on}. The rows are real; the total is unconfirmed.`;
    case "carried":
      return `${name} had no activity to replay on ${on}, so ${counted ?? "the last known balance"} was carried forward.`;
    case "gap":
      return `The replay did NOT land on ${name}'s next recorded balance. Money is provably missing or double-counted around ${on}.`;
  }
}

/* ── statement period ─────────────────────────────────────────────────── */

function statementPeriodProvenance(db: AppDatabase, id: string): Provenance | null {
  const period = db.select().from(statementPeriods).where(eq(statementPeriods.id, id)).get();
  if (!period) return null;
  const file = db.select().from(importFiles).where(eq(importFiles.id, period.importFileId)).get();
  const account = db.select().from(accounts).where(eq(accounts.id, period.accountId)).get();

  const rows = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, period.accountId),
        gte(transactions.postedOn, period.periodStart),
        lte(transactions.postedOn, period.periodEnd),
        inArray(transactions.status, ["active", "excluded"]),
      ),
    )
    .all();

  const verdict: ProvenanceVerdict =
    period.reconciliation === "reconciled"
      ? "sourced"
      : period.reconciliation === "value_anchor"
        ? "market_value"
        : "unverified";

  const headline =
    period.reconciliation === "reconciled"
      ? `The opening balance plus every row in this period equals the closing balance, to the cent. ${grouped(rows.length)} ${rows.length === 1 ? "row was" : "rows were"} checked.`
      : period.reconciliation === "value_anchor"
        ? `This is an investment statement: it records what ${account?.name ?? "the account"} was worth, and any difference is absorbed as market movement. There is no arithmetic here that could fail.`
        : `This file declares which days it covers but carries no balances, so nothing in it can be checked against a total.`;

  const sources: ProvenanceSource[] = [];
  if (file) {
    sources.push({
      kind: "document",
      label: file.fileName,
      detail: `read by ${file.parserProfile ?? "an unnamed parser"}`,
      on: file.importedAt.slice(0, 10),
    });
  }
  if (period.gapCents !== null && period.gapCents !== 0) {
    // 🔴 "1 cents" / "-1 cents" — a gap of a cent is the smallest one a statement can leave
    const cents = Math.abs(period.gapCents) === 1 ? "cent" : "cents";
    sources.push({ kind: "period", label: "unexplained difference", detail: `${period.gapCents} ${cents}` });
  }

  return {
    verdict,
    // 🔴 a value-anchor statement of an account no holding prices was named "priced from holdings"
    badgeWord: verdict === "market_value" && account ? marketValueBadgeWord(derivesFromHoldings(db, account)) : undefined,
    headline,
    sources,
    checkedThrough: period.reconciliation === "reconciled" ? period.periodEnd : null,
    inputs: [],
  };
}

/**
 * How far a figure standing on SEVERAL accounts is checked through, and the
 * sentence that names whose word that day is when it is his count's.
 *
 * ⛔ One rule, because it had one caller and the second surface answered the
 * old way. `footingThrough` says an account resting on a balance he TYPED
 * bounds the picture at the day before nothing stands under it; net worth read
 * it, and `summedRowsProvenance` compared `verifiedThrough` alone — so a
 * count-only account left that comparison altogether and every row total's
 * date ran past the day the same app calls the account unchecked.
 *
 * `through` is the OLDEST footing of any kind, his count included: a figure
 * cannot be proven past the first account that stops being checked. `note` is
 * the sentence saying that day is his word when it is his count's, and "" when
 * it is a check's.
 *
 * ⛔ …his count included when it is ALL there is. Summed totals kept a second
 * field, the oldest CHECK, and printed no date when there was none, while net
 * worth dates the same count at the day it stops standing — measured
 * 2026-09-28 on a copy of the real ledger, /accounts/<Cash on Hand>'s "1
 * transaction landed" proof printed no date at all. His call, 2026-09-28
 * (handoff §6A 28): make them agree, in net worth's words. One day, one
 * sentence, and they travel together — a caller printing `through` without
 * `note` would print his word as a check.
 *
 * ⛔ Exported because a THIRD surface re-derived it: the dashboard's "what you
 * owe" proof (`cards-owed`) took the oldest `verifiedThrough` of the cards
 * under net worth's own words, so a card resting on his count never dated it.
 * Every figure bounded by the first account to stop being checked reads this.
 */
export function footingBounds(coverage: readonly AccountCoverage[]): { through: string | null; note: string } {
  const bounds = coverage
    .map((c) => ({ name: c.accountName, bound: footingThrough(c) }))
    .filter((b): b is { name: string; bound: { day: string; byCount: boolean } } => b.bound !== null)
    .sort((a, b) => (a.bound.day < b.bound.day ? -1 : a.bound.day > b.bound.day ? 1 : 0));
  const through = bounds[0]?.bound.day ?? null;
  // a check stopping the same day does not make the day a check: his count still stops there
  const byCount = through === null ? undefined : bounds.find((b) => b.bound.day === through && b.bound.byCount);
  return {
    through,
    note: byCount
      ? ` The date it is checked through, ${readableDay(byCount.bound.day)}, is the last day ${byCount.name} rests on the balance you counted — your word, not a check.`
      : "",
  };
}

/* ── net worth ────────────────────────────────────────────────────────── */

function netWorthProvenance(db: AppDatabase, day: string | undefined): Provenance {
  const asOf = day ?? todayIso();
  /**
   * Per-account grading is `accountCoverage`'s job, not this service's. It
   * already encodes the two-arbiter doctrine — an account with no statement can
   * still be fully checked if its anchors close — and the investment branch,
   * where `derived` is written by the price walk and means only "prices were
   * fresh". Re-deriving any of that here would give the app two answers to one
   * question, and the second one would be the untested one.
   */
  const coverage = accountCoverage(db, asOf);

  /**
   * An account with no derived balance is `unknown` either way, but the two
   * cases are not the same figure:
   *
   *  - **no balance AND no rows** — genuinely empty, contributes $0, and
   *    nothing is missing. Dragging the whole total's verdict down for it is
   *    noise, and noise is what teaches a reader to stop reading.
   *  - **no balance BUT rows** — a HOLE. Wells Fargo holds 39 transactions
   *    netting $2,396.67 that this total cannot see, because the app refuses to
   *    derive a balance from the same rows a balance exists to check. That is
   *    the single most useful thing this popover can say, so it says the amount.
   */
  const rowSums = new Map(
    (
      db
        .select({ accountId: transactions.accountId, n: count(), cents: sum(transactions.amountCents) })
        .from(transactions)
        .where(inArray(transactions.status, ["active", "excluded"]))
        .groupBy(transactions.accountId)
        .all() as { accountId: string; n: number; cents: string | null }[]
    ).map((r) => [r.accountId, { n: r.n, cents: Number(r.cents ?? 0) }]),
  );
  const holes = coverage.filter((c) => c.grade === "unknown" && (rowSums.get(c.accountId)?.n ?? 0) > 0);
  const emptyAccountIds = new Set(
    coverage.filter((c) => c.grade === "unknown" && (rowSums.get(c.accountId)?.n ?? 0) === 0).map((c) => c.accountId),
  );

  /*
   * 🔴 "PRICED FROM HOLDINGS" OF EVERY `market_value` ACCOUNT. The grade covers
   * every investment account, and an account with no holding events is a
   * recorded balance held flat — the per-account line and the count both said
   * holdings priced it, and the trust card prints that count verbatim.
   * `derivesFromHoldings` is the rule `accountBalanceProvenance` and /imports'
   * coverage row already read; it cannot live in `accountCoverage` (see
   * `CoverageDetailInput.pricedFromHoldings`).
   */
  const pricedFromHoldings = new Set(
    coverage
      .filter(
        (c) => c.grade === "market_value" && derivesFromHoldings(db, { id: c.accountId, type: c.accountType as AccountType }),
      )
      .map((c) => c.accountId),
  );

  const inputs: ProvenanceInput[] = coverage.map((c) => ({
    id: c.accountId,
    label: c.accountName,
    verdict: GRADE_VERDICT[c.grade],
    isEmpty: emptyAccountIds.has(c.accountId),
    detail:
      c.grade === "verified" && c.verifiedThrough
        ? `adds up through ${readableDay(c.verifiedThrough)}`
        : c.grade === "broken" && c.brokenSince
          ? `stopped adding up on ${readableDay(c.brokenSince)}`
          : // an unverified account — his count named as his, the run still open, or the days
            // before its first balance — is `unverifiedDetail`, which the cards-owed row and its
            // proof read too. ⚠️ The parenthesis is load-bearing: `??` binds tighter than `?:`,
            // so without it `unverifiedDetail(…) ?? <test>` would become the chain's condition.
            unverifiedDetail(c, readableDay) ??
            (c.grade === "market_value"
              ? pricedFromHoldings.has(c.accountId)
                ? "priced from holdings"
                : "held at its recorded balance"
              : c.grade === "manual"
                ? c.lastManualUpdate
                  ? `you last counted it on ${readableDay(c.lastManualUpdate)}`
                  : "you are the statement"
                : (rowSums.get(c.accountId)?.n ?? 0) > 0
                  ? // 🔴 "1 rows" — beside the headline's own "holds 1 row" for the same account
                    `${grouped(rowSums.get(c.accountId)!.n)} ${rowSums.get(c.accountId)!.n === 1 ? "row" : "rows"} but no recorded balance — not in this total`
                  : "empty — no rows, no balance"),
  }));

  // an empty account is not a weakness, it is an absence of anything at all
  const weighed = inputs.filter((_, i) => !emptyAccountIds.has(coverage[i]!.accountId));
  const verdict = weakestVerdict(weighed.map((i) => i.verdict));
  const counted = inputs.length;
  const proven = inputs.filter((i) => i.verdict === "derived" || i.verdict === "sourced").length;
  const marked = inputs.filter((i) => i.verdict === "market_value").length;
  const heldAccounts = marked - pricedFromHoldings.size;
  // `manual` is a basis, not an absence — see the note in categorySpendProvenance
  const byHand = inputs.filter((i) => i.verdict === "manual").length;
  /**
   * ⛔ FIVE buckets, and the fifth is EMPTY. An account with no rows and no
   * balance was already excluded from the verdict two lines above — "an empty
   * account is not a weakness" — but it was still counted in `weak`, so the
   * sentence read "3 have nothing checking them" about a set of two.
   *
   * That is not merely off by one: the /dashboard trust card names each weak
   * account underneath the sentence, so the third one could never be found, and
   * the card's own note about the empty account says the opposite in the next
   * breath ("nothing to check, and nothing missing from any total"). Excluding
   * it from the verdict but not from the count meant the service disagreed with
   * itself depending on which number you read.
   *
   * It stays inside `counted` deliberately — it IS one of his accounts, and
   * "7 of 11" would quietly hide one — so it gets named as what it is instead.
   */
  const empty = emptyAccountIds.size;
  const weak = counted - proven - marked - byHand - empty;

  // A total is only as proven as its weakest part, and saying so plainly is the
  // whole reason this figure gets a popover at all.
  const parts = [`${proven} of ${counted} accounts add up against a document`];
  if (pricedFromHoldings.size > 0) {
    parts.push(`${pricedFromHoldings.size} ${pricedFromHoldings.size === 1 ? "is" : "are"} priced from holdings`);
  }
  if (heldAccounts > 0) {
    parts.push(
      `${heldAccounts} ${heldAccounts === 1 ? "is held at its recorded balance" : "are held at their recorded balances"}`,
    );
  }
  if (byHand > 0) parts.push(`${byHand} you count yourself`);
  if (weak > 0) parts.push(`${weak} ${weak === 1 ? "has" : "have"} nothing checking ${weak === 1 ? "it" : "them"}`);
  if (empty > 0) parts.push(`${empty} ${empty === 1 ? "is" : "are"} empty`);
  const holeText = holes
    .map((h) => {
      const r = rowSums.get(h.accountId)!;
      return `${h.accountName} holds ${grouped(r.n)} ${r.n === 1 ? "row" : "rows"} worth ${formatCents(r.cents)} that this total cannot see, because it has no recorded balance`;
    })
    .join("; ");

  /*
   * 🔴 EVERY ACCOUNT THAT HAS A CHAIN, not only the ones whose chain is still
   * whole. The card's own sentence says "the whole picture stops being proven at
   * the FIRST account that stops being checked", and this filtered to
   * `grade === "verified"` — so the two accounts printed six lines above it
   * under "nothing checks it" never entered the comparison at all. An account
   * that closed to the cent through Aug 3 and then stopped is exactly an account
   * that stops being checked, and it is exactly what the sentence is about.
   *
   * ⚠️ `market_value` and `manual` accounts stay out: neither has an arithmetic
   * chain to stop, which the same card says of them in their own words.
   *
   * 🔴 …and an account resting on his count stays IN, at the day before nothing
   * stands under it — `footingThrough` has the rule and its measurement. That
   * day is his word, so the sentence says whose it is.
   */
  const footing = footingBounds(coverage);
  const checkedThrough = footing.through;
  const countText = footing.note;

  return {
    verdict,
    badgeWord: `${proven} of ${counted} add up`,
    headline: `${parts.join(", ")}. A total is only as proven as its weakest part.${holeText ? ` ⚠️ ${holeText}.` : ""}${countText}`,
    sources: [],
    checkedThrough,
    inputs,
  };
}


/* ── a holding ────────────────────────────────────────────────────────── */

/**
 * A holding's value stands on TWO independent things, and only one of them is
 * checkable. Saying so is the whole reason this kind exists rather than
 * borrowing `accountBalance`'s vocabulary.
 *
 *  - **the share count** — `holdings.quantity_e8` against the sum of every
 *    `holding_events` delta. That is a real arithmetic gate and it either
 *    closes or it does not. Measured on the live ledger: all ten active
 *    holdings close EXACTLY, including AAPL's 244 events back to 2023-12-05.
 *  - **the price** — a market observation from Yahoo or Coinbase. No document
 *    in the ledger states it and none ever will, so no amount of checking can
 *    promote it. It gets named, dated and aged instead.
 *
 * ⛔ Note this is strictly MORE than the account can say. `accountCoverage`
 * grades every investment account `market_value` unconditionally, because
 * `reconcileAccounts` absorbs a discrepancy into `market_change_cents` and
 * cannot fail — so at account level there is no gate at all. At HOLDING level
 * there is one, and it is the share count. A reader deserves the stronger
 * statement where the stronger statement is true.
 *
 * Aggregated across accounts by `(symbol, assetType)`, matching `holdingDetail`
 * — the figure on screen is the position, not one account's leg of it.
 */
function holdingProvenance(db: AppDatabase, symbol: string, assetType: AssetType, day: string | undefined): Provenance | null {
  /*
   * ⛔ HIS legs only — the ones `holdingDetail` reports, by the same rule (`ownPortfolioAccountIds`). The brokerage book
   * paired with Robinhood Agentic is kept out of his returns (owner, 2026-09-14), and read from every account this
   * panel explained his WMT page's $45.76 as 0.662664 shares — the agent's 0.25 counted in — and listed "Robinhood
   * Agentic Brokerage" as a leg of his position (measured 2026-09-16).
   */
  const own = ownPortfolioAccountIds(db);
  const legs = db
    .select({
      accountId: holdings.accountId,
      accountName: accounts.name,
      quantityE8: holdings.quantityE8,
      isActive: holdings.isActive,
    })
    .from(holdings)
    .innerJoin(accounts, eq(accounts.id, holdings.accountId))
    .where(and(eq(holdings.symbol, symbol), eq(holdings.assetType, assetType)))
    .all()
    .filter((l) => own.has(l.accountId));
  if (legs.length === 0) return null;

  const asOf = day ?? todayIso();
  const storedE8 = legs.reduce((t, l) => t + l.quantityE8, 0);

  /* ── basis 1: does the share count add up against its own events? ── */
  const events = db
    .select({
      accountId: holdingEvents.accountId,
      occurredOn: holdingEvents.occurredOn,
      deltaE8: holdingEvents.quantityDeltaE8,
    })
    .from(holdingEvents)
    .where(
      and(
        inArray(
          holdingEvents.accountId,
          legs.map((l) => l.accountId),
        ),
        eq(holdingEvents.symbol, symbol),
        eq(holdingEvents.assetType, assetType),
      ),
    )
    .all();
  const eventsE8 = events.reduce((t, e) => t + e.deltaE8, 0);
  const countMatches = eventsE8 === storedE8;
  /**
   * ⛔ A holding with NO events has nothing to check against, and
   * `0 === 0` would quietly report that as proof. That is the same shape as
   * pass 56's `Math.sign(0)` ruler — a check that passes because it never ran.
   * An unchecked count is `unknown`, never "adds up", and the two directions
   * are pinned by their own tests.
   */
  const countIsChecked = events.length > 0;

  /* ── basis 2: the price, which is an observation and cannot be promoted ── */
  const price = db
    .select({ close: priceCache.close, quotedOn: priceCache.quotedOn, source: priceCache.source })
    .from(priceCache)
    .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, assetType), lte(priceCache.quotedOn, asOf)))
    .orderBy(desc(priceCache.quotedOn))
    .limit(1)
    .get();

  /**
   * ⛔ `isStaleClose` is imported, not re-derived. `lib/holding-price-age`
   * exists precisely so the page note and the per-row date "can never disagree
   * about where the boundary is", and a third opinion in this service would
   * break the guarantee that docstring makes. The app's boundary is strict —
   * anything not quoted TODAY is stale — and a looser one here would let the
   * popover call a price fresh in the same breath the row beside it calls it
   * old.
   */
  const priceIsStale = price !== undefined && isStaleClose(price.quotedOn, asOf, diffDays);
  const priceAgeDays = price ? diffDays(price.quotedOn, asOf) : null;
  const agePhrase = priceAgeDays === null ? "" : `${priceAgeDays} ${priceAgeDays === 1 ? "day" : "days"} old`;

  const sources: ProvenanceSource[] = [];
  if (price) {
    sources.push({
      kind: price.source === "manual" ? "hand-entered" : "document",
      label: price.source === "manual" ? "a price you entered by hand" : `${price.source}'s close`,
      detail: priceIsStale ? `$${price.close.toFixed(2)} — ${agePhrase}` : `$${price.close.toFixed(2)}`,
      on: price.quotedOn,
    });
  }
  if (countIsChecked) {
    const firstDay = events.map((e) => e.occurredOn).sort()[0]!;
    sources.push({
      kind: "anchor",
      label: `${events.length} recorded ${events.length === 1 ? "buy or sell" : "buys and sells"}`,
      detail: countMatches
        ? "they sum exactly to the share count above"
        : `they sum to ${(eventsE8 / 1e8).toFixed(8).replace(/0+$/, "")}, not the share count above`,
      on: firstDay,
    });
  }

  /**
   * ⛔ Verdict order matters. A share count that provably does NOT close is the
   * loudest thing here and outranks any question about the price — the position
   * itself is wrong, so what it is worth is beside the point.
   */
  const verdict: ProvenanceVerdict = countIsChecked && !countMatches ? "broken" : !price ? "unknown" : "market_value";

  const shares = (storedE8 / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
  const unit = assetType === "crypto" ? "coins" : "shares";
  const countSentence = countIsChecked
    ? `The ${unit === "coins" ? "coin" : "share"} count adds up — ${events.length} recorded ${events.length === 1 ? "trade sums" : "trades sum"} exactly to it.`
    : `Nothing checks the ${unit === "coins" ? "coin" : "share"} count: no buys or sells are recorded for it.`;

  /**
   * ⛔ A CLOSED position is its own sentence. The probe caught the generic one
   * reading "0 shares × yahoo's $179.44 close … now 208 days old" for PM — a
   * true statement that wastes the reader's attention on a price that cannot
   * move a figure which is $0 whatever the price does. When the quantity is
   * zero the price is not stale, it is IRRELEVANT, and saying "208 days old"
   * invites a fix for something that is not broken.
   */
  const headline =
    storedE8 === 0
      ? `This position is closed — nothing is held, so it is worth $0 whatever ${symbol} is trading at. ${countSentence}`
      : !price
        ? `No price has ever been recorded for ${symbol}, so there is nothing to value ${shares} ${unit} at. ${countSentence}`
        : countIsChecked && !countMatches
          ? `⚠️ ${symbol}'s ${unit === "coins" ? "coin" : "share"} count does not add up: ${events.length} recorded ${events.length === 1 ? "buy or sell does" : "buys and sells do"} not sum to the ${shares} on file. This value is ${shares} × a price, and the ${shares} is in doubt.`
          : `${shares} ${unit} × ${price.source === "manual" ? "a price you entered" : `${price.source}'s $${price.close.toFixed(2)} close`} on ${readableDay(price.quotedOn)}${priceIsStale ? `, now ${agePhrase}` : ""}. ${countSentence} The price is an observation, not a document — no statement in the ledger states it.`;

  const inputs: ProvenanceInput[] =
    legs.length > 1
      ? legs.map((l) => ({
          label: l.accountName,
          verdict,
          detail: `${(l.quantityE8 / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0"} ${assetType === "crypto" ? "coins" : "shares"}`,
        }))
      : [];

  return {
    verdict,
    /**
     * `market_value` already presents as "market value", which is exactly right
     * here, so the badge is overridden for ONE state: a share count that
     * provably does not close.
     *
     * ⛔ Deliberately NOT for price age. /investments already discloses that,
     * twice — a page note gated on the newest close and a per-row date gated on
     * the row's own (`lib/holding-price-age`) — and a badge repeating it would
     * be a third disclosure of one fact, on the one column that has to stay
     * scannable. The age is still named inside the panel, which the reader
     * opened on purpose.
     */
    badgeWord: countIsChecked && !countMatches ? "share count is off" : undefined,
    headline,
    sources,
    /**
     * ⛔ `null`, always, and deliberately. `checkedThrough` renders as
     * "Checked through <date>", which is a claim that the MONEY added up to
     * that day. A price date is not that claim and must never be printed as
     * one — the price's day is already named in `sources`, where it reads as
     * what it is.
     */
    checkedThrough: null,
    inputs,
  };
}

/* ── a recurring series' amount ───────────────────────────────────────── */

/**
 * What a forecast amount is standing on.
 *
 * ⚠️ The handoff predicted this could reuse `categorySpend`'s "sum of rows"
 * shape. It cannot, and the schema says why: the figure on screen is
 * `user_amount_cents ?? next_expected_amount_cents` (`effectiveSeries`) — an
 * owner override, or a forecast built from an average. It is not a sum of
 * anything, so the question "which documents is this sum standing on?" is the
 * wrong question. The right one is **how much evidence is behind the guess, and
 * did the evidence agree?**
 *
 * ⛔ `MIN_OCCURRENCES` is imported rather than re-picked. `recurring-calendar`
 * already reasons about exactly this — zero postings means a human authored it,
 * one or two means detection extrapolated from too little, three or more means
 * it was measured — and its docstring says outright that the threshold is
 * shared so the codebase keeps ONE definition of "enough occurrences to be a
 * statistic". A second opinion here would be a second definition.
 *
 * Measured on the live ledger: Rocket Money has 16 postings at ONE amount;
 * Flamingo rent has 3 postings at THREE different amounts; the car lease and
 * car insurance have ZERO and are pure owner assertions. Those three cases must
 * not read alike, and before this they all read as a plain number.
 */
function recurringSeriesProvenance(db: AppDatabase, id: string): Provenance | null {
  const series = db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get();
  if (!series) return null;

  const postings = db
    .select({ amountCents: transactions.amountCents, postedOn: transactions.postedOn })
    .from(transactions)
    .where(and(eq(transactions.recurringSeriesId, id), eq(transactions.status, "active")))
    .all();

  const n = postings.length;
  const distinct = new Set(postings.map((p) => p.amountCents));
  const days = postings.map((p) => p.postedOn).sort();
  const userSet = series.userAmountCents !== null;

  const sources: ProvenanceSource[] = [];
  if (userSet) {
    sources.push({
      kind: "hand-entered",
      label: `you set this to ${formatCents(series.userAmountCents!)}`,
      detail: "an override — detection does not get a vote on it",
    });
  }
  if (n > 0) {
    sources.push({
      kind: "period",
      label: `${n} tagged ${n === 1 ? "posting" : "postings"} in the ledger`,
      detail:
        distinct.size === 1
          ? // ⚠️ "every one of them" over a single posting is a plural claim
            // about a population of one — it read exactly that way for FPL.
            n === 1
            ? `it was ${formatCents([...distinct][0]!)}`
            : `every one of them ${formatCents([...distinct][0]!)}`
          : `${distinct.size} different amounts, ${formatCents(Math.min(...distinct))} to ${formatCents(Math.max(...distinct))}`,
      on: days[0],
    });
  }

  /**
   * ⛔ The verdict grades the EVIDENCE, not the forecast. A forecast is always a
   * guess about the future and no amount of evidence makes it a fact, so the
   * strongest word available here is `derived` — never `sourced`, which would
   * claim a document states next month's amount.
   */
  const verdict: ProvenanceVerdict = userSet
    ? "manual"
    : n === 0
      ? "unknown"
      : n < MIN_OCCURRENCES
        ? "unverified"
        : distinct.size === 1
          ? "derived"
          : "unverified";

  /**
   * ⛔ `unverified` presents as "nothing checks it", and that is FALSE of both
   * populations it lands on here. Rent seen three times at three different
   * amounts IS checked — by three documents that disagree. FPL seen once is
   * checked by one document, which is too thin to be a pattern but is not
   * nothing. That is the §2.4 mistake in miniature: a bucket right about the
   * arithmetic and insulting to the source.
   *
   * The TONE stays soft in both cases, because thin evidence and disagreeing
   * evidence both really do make a forecast soft. Only the word is corrected,
   * to one that says which of the two it is.
   */
  const badgeWord = userSet
    ? undefined
    : n === 0
      ? undefined
      : n < MIN_OCCURRENCES
        ? `seen ${n === 1 ? "once" : `${n} times`}`
        : distinct.size > 1
          ? `${distinct.size} different amounts`
          : undefined;

  const observed = (): string => {
    if (n === 0) return "Nothing tagged to it has ever posted, so there is no evidence behind it at all.";
    if (n < MIN_OCCURRENCES)
      return `Only ${n} tagged ${n === 1 ? "posting has" : "postings have"} ever landed — below the ${MIN_OCCURRENCES} this app requires before calling a repeat a pattern, so it is an anecdote rather than a statistic.`;
    if (distinct.size === 1)
      return `All ${n} tagged postings since ${readableDay(days[0]!)} were ${formatCents([...distinct][0]!)}, exactly.`;
    return `Its ${n} tagged postings since ${readableDay(days[0]!)} were ${distinct.size} different amounts, from ${formatCents(Math.min(...distinct))} to ${formatCents(Math.max(...distinct))} — so any single figure for it is an average, not a repeat.`;
  };

  /*
   * 🔴 THE AVERAGE OF WHAT POSTED, NOT THE DETECTOR'S SEED — and silence when
   * nothing posted at all.
   *
   * This read `series.amountCentsAvg`, which `recurring.ts` documents as "the
   * detector's SEED: written when the series was created and never recomputed
   * as rows are attached afterwards", adding that "anything claiming to be the
   * average of the postings reads [postedAvgCents]". Two consequences, both
   * live on /recurring/<Car lease> on 2026-09-11:
   *
   *   "Nothing tagged to it has ever posted, so there is no evidence behind it
   *    at all. ⚠️ The ledger's own average of what actually posted is
   *    -$559.89, which is not what you set."
   *
   *   — one sentence denying what the next one measures, and a figure NO ROW IN
   *   THE LEDGER HAS EVER CARRIED: `SELECT count(*) … amount_cents = -55989`
   *   returns 0. -$559.89 is the superseded amount the owner once said; the
   *   statement figure is $695.04, which this same headline prints correctly.
   *
   * The postings are already in hand here, so the clause is computed from them
   * and says nothing when there are none.
   */
  const postedAvgCents =
    n > 0 ? Math.round(postings.reduce((sum, p) => sum + p.amountCents, 0) / n) : null;
  const disagreement =
    userSet && postedAvgCents !== null && postedAvgCents !== series.userAmountCents
      ? ` ⚠️ The ledger's own average of what actually posted is ${formatCents(postedAvgCents)}, which is not what you set.`
      : "";

  const headline = userSet
    ? `You set this amount yourself, so it is exactly as right as you are. ${observed()}${disagreement}`
    : `This is a forecast, not a record — it says what the app expects next, and nothing has happened yet to check it against. ${observed()}`;

  return {
    verdict,
    badgeWord,
    headline,
    sources,
    // a forecast is never "checked through" a day; the evidence's own dates are
    // named in `sources`, where they read as evidence rather than as a guarantee
    checkedThrough: null,
    inputs: [],
  };
}

/* ── an aggregate over transactions ───────────────────────────────────── */

/** Top few documents named, the rest counted — a list of 40 files is not evidence. */
const SOURCES_NAMED = 4;

/**
 * A total's proof is the proof of the rows underneath it, and its weakest row
 * sets the verdict.
 *
 * ⚠️ Per-ROW day lookups would be one query each, and a category page can hold
 * hundreds. `accountCoverage` answers per account in one call and already
 * carries the two dates that matter — `verifiedThrough` (the last day the chain
 * closed) and `brokenSince` (the first day it did not) — so a row is graded by
 * comparing its own date against its account's, with no extra query at all.
 */
function categorySpendProvenance(
  db: AppDatabase,
  categoryId: string,
  from: string,
  to: string,
  label: string | undefined,
): Provenance | null {
  const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!category) return null;

  // a parent's total includes its children, the same way the app reports it
  const childIds = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId))
    .all()
    .map((c) => c.id);
  const ids = [categoryId, ...childIds];

  /*
   * 🔴 THE PROOF MUST MEASURE THE ROWS THE HEADLINE MEASURED. `/categories/<the
   * system Uncategorized row>` reads the whole bucket — NULL or filed on that
   * category, `spendingTransactions` — but this query asked for the id
   * literally, which after `activeTxnsInRange`'s normalisation is only the six
   * hand-filed rows. For August 2026 the page read "-$1,192.21 · 31
   * transactions" over a popover saying "No rows in Uncategorized between Aug
   * 1, 2026 and Aug 31, 2026, so this total is zero rather than unproven" — a
   * measured zero asserted directly under a non-zero headline, on a card whose
   * own comment says "the total's proof is the proof of the rows underneath
   * it". Introduced 2026-09-11 by the fix that made the headline right, and
   * caught by a second reader rather than by any gate.
   *
   * ⛔ `uncategorizedWhere` is the predicate written for exactly this — "the
   * queries that do not go through `activeTxnsInRange`" — so the proof and the
   * figure cannot answer "which rows" two ways.
   */
  const idx = loadCategoryIndex(db);
  const scope = idx.uncategorizedIds.has(categoryId)
    ? uncategorizedWhere(idx)
    : inArray(transactions.categoryId, ids);
  /*
   * ⚖️ …and an income category's total is his rows: `spendingTransactions` leaves the agent's cash out of it, either
   * sign (`isAgentsIncomeCategoryRow`), so the proof does too. 🔴 Counting them, `/categories/<Income>`'s popover
   * would name the agent's rows — "the sum of 4 rows" — under a headline of 2 transactions.
   */
  const his =
    idx.topLevelOf(categoryId).kind === "income" ? offAgentsCash([...outsidePortfolioCashAccountIds(db)]) : undefined;

  const rows = db
    .select(SUM_ROW_COLUMNS)
    .from(transactions)
    .where(
      and(
        scope,
        his,
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();

  return summedRowsProvenance(db, rows, label ?? category.name, from, to);
}

/**
 * What backs one merchant's spend — the same grading as a category total, over
 * a different set of rows.
 *
 * ⛔ NOT `categorySpend` with the merchant's dominant category id, which is what
 * `merchant-insights` reached for first. That would have graded the CATEGORY's
 * rows and printed their count — "the sum of 470 rows from 9 documents" beside
 * a merchant with four visits. The rows a proof names have to be the rows the
 * figure was summed from.
 */
function merchantSpendProvenance(
  db: AppDatabase,
  merchantId: string,
  from: string,
  to: string,
  label: string | undefined,
): Provenance | null {
  const merchant = db.select().from(merchants).where(eq(merchants.id, merchantId)).get();
  if (!merchant) return null;

  const rows = db
    .select(SUM_ROW_COLUMNS)
    .from(transactions)
    .where(
      and(
        eq(transactions.merchantId, merchantId),
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();

  return summedRowsProvenance(db, rows, label ?? merchant.canonicalName, from, to);
}

/**
 * What backs a count of an account's rows.
 *
 * 🔴 S33: THE COUNT WAS PROVEN WITH THE BALANCE'S PROOF. `account-insights`
 * handed "N transactions landed in X since it opened" the `accountBalance` proof
 * it built for the rank and share — a proof about ONE DAY's balance. Measured
 * 2026-09-14: `/accounts/<Robinhood Cash>` read "How 2,365 transactions landed
 * in Robinhood Cash since it opened is proven — it has nothing checking it",
 * while its chain is verified through 2026-07-31 and 2,364 of the 2,365 rows
 * sit on or before that day; Chase Checking and Discover read "adds up" over a
 * popover about the balance ("had no activity to replay on Aug 14, 2026").
 *
 * ⛔ `summedRowsProvenance` is the rule, not a copy of it — one grading across
 * category, merchant and account totals (owner decision S33 option a). A total
 * holding hand-entered rows therefore reads "you entered it" here exactly as it
 * does on a category page.
 *
 * ⚠️ The window handed on is the rows' own first and last day: a count "since
 * it opened" has no other. `summedRowsProvenance` reads the bounds only for its
 * empty branch and as `accountCoverage`'s today, which moves no grade (see
 * `allSpendProvenance`).
 *
 * ⛔ No rows is not a measured zero. With nothing to count there is no window for
 * the empty branch to vouch for, so this says `unknown` itself.
 */
function accountRowsProvenance(db: AppDatabase, accountId: string, label: string | undefined): Provenance | null {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return null;
  const subject = label ?? account.name;

  const rows = db
    .select(SUM_ROW_COLUMNS)
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.status, "active")))
    .orderBy(asc(transactions.postedOn))
    .all();
  if (rows.length === 0) {
    return {
      verdict: "unknown",
      headline: `No transactions have been imported into ${subject}, so there are no rows for this to stand on.`,
      sources: [],
      checkedThrough: null,
      inputs: [],
    };
  }
  return summedRowsProvenance(db, rows, subject, rows[0]!.postedOn, rows[rows.length - 1]!.postedOn);
}

/**
 * What backs EVERY dollar the app calls spending in a window.
 *
 * ## ⛔ The predicate is borrowed, never rewritten
 *
 * "What counts as spending" is `spendingBucket` plus a debit — a row whose
 * TOP-LEVEL category is an expense, or an uncategorized outflow. Restating that
 * as a SQL `where` here would be a second definition of the largest number in
 * the app, and this codebase has paid for a duplicated definition three times
 * now: two functions computing one due date (pass 54), a ruler that graded
 * itself (pass 56), a `where` clause that made a liveness test dead code while
 * it still looked load-bearing (`recurring-insights`). So this walks the SAME
 * rows through the SAME classifier the figure walks, and adds only the join
 * back to the documents.
 *
 * That borrowing is also why the second query exists. `activeTxnsInRange`
 * does not select `importFileId` — a proof's whole subject — and widening the
 * shared analytics row to carry a column only this file wants would push the
 * cost onto every aggregate in the app. One extra pass over the same window is
 * cheaper than that and leaves the hot path alone.
 *
 * ## ⛔ A SPLIT transaction is ONE row, not three
 *
 * `activeTxnsInRange` explodes a split into a pseudo-row per part so each part
 * lands in its own category. That is right for the SUM and wrong for a PROOF,
 * which counts rows and names documents: a $50 charge split three ways is one
 * line on one statement, and "the sum of 3 rows from 1 document" would be a
 * count of something that does not exist. Contributing transactions are
 * collected as a SET of ids for exactly this reason.
 *
 * A split with one spending part and one Pass-through part still contributes
 * its transaction once, which is correct — the document carries the whole row,
 * and the proof's subject is the document.
 */
function allSpendRows(db: AppDatabase, from: string, to: string): SummedRow[] {
  const idx = loadCategoryIndex(db);
  const contributing = new Set<string>();
  for (const txn of activeTxnsInRange(db, from, to)) {
    // gross money out, matching `periodTotals` exactly: a credit in an expense
    // category is a REFUND and never nets this total down
    if (txn.amountCents < 0 && spendingBucket(idx, txn)) contributing.add(txn.id);
  }

  /*
   * Re-selected by WINDOW rather than by the id set: a four-year window holds
   * thousands of contributing rows, and an `IN (…)` list that long is a
   * SQLITE_MAX_VARIABLE_NUMBER failure waiting for the first person to open a
   * long period. The window predicate is bounded by the dates instead, and the
   * set does the filtering in memory where it costs nothing.
   */
  return db
    .select(SUM_ROW_COLUMNS)
    .from(transactions)
    .where(and(eq(transactions.status, "active"), gte(transactions.postedOn, from), lte(transactions.postedOn, to)))
    .all()
    .filter((r) => contributing.has(r.id));
}

function allSpendProvenance(
  db: AppDatabase,
  from: string,
  to: string,
  label: string | undefined,
  against: { from: string; to: string; label?: string } | undefined,
): Provenance {
  const rows = allSpendRows(db, from, to);
  const subject = label ?? "your spending";
  if (!against) return summedRowsProvenance(db, rows, subject, from, to);

  const priorRows = allSpendRows(db, against.from, against.to);
  const priorSubject = against.label ?? "the window it is compared against";

  /**
   * ⛔ The grading runs over BOTH windows' rows at once, and that is the point
   * rather than a shortcut. A comparison is one claim standing on two sets of
   * documents, so its verdict, its "N of M checked" badge and the day it is
   * checked through all have to answer for every row underneath it — exactly
   * the rule `netWorthProvenance` applies across accounts. Taking the weaker of
   * two separately-computed badges would give a fraction that is true of
   * neither half and of no real set of rows.
   *
   * ⚠️ The union bounds passed below buy LESS than they look like they buy, and
   * the difference is worth writing down because it is a trap. It reads as
   * though the span decides what the rows are graded against — it does not.
   * `accountCoverage(db, day)` takes a TODAY, not an as-of: measured against the
   * real ledger, moving that argument from 2026 to 2023 changes `grade`,
   * `verifiedThrough`, `unverifiedSince` and `brokenSince` on none of the twelve
   * accounts. The only field it moves is `daysSinceVerified`, which this path
   * never reads (and which goes NEGATIVE for a past day). Coverage is a fact
   * about the ledger as it stands now, which is the right thing for a proof to
   * report — but a future caller reaching for historical grading by passing an
   * old date will get today's answer and no warning.
   *
   * The union is passed anyway because it is the only span that is TRUE of both
   * halves. Handing `summedRowsProvenance` the current window's dates while
   * giving it the other window's rows would be a lie in an argument, waiting for
   * the day someone makes that argument matter.
   */
  const { provenance: combined, dateNote } = summedRowsProof(
    db,
    [...rows, ...priorRows],
    subject,
    from < against.from ? from : against.from,
    to > against.to ? to : against.to,
  );

  const count = (n: number): string => `${grouped(n)} ${n === 1 ? "row" : "rows"}`;
  return {
    verdict: combined.verdict,
    badgeWord: combined.badgeWord,
    /*
     * 🔴 The date was borrowed and the sentence saying whose word it is was not.
     * Measured 2026-09-28 on a copy of the real ledger: this proof of August 2026
     * against July read "Checked through 2026-08-10" — the last day Cash on Hand
     * rests on the balance he typed — under a headline that never says so. The
     * one comparison the app renders, a year against the year before, is dated
     * by SoFi's Jul 31 today and would read the same once SoFi's chain runs past
     * Aug 10.
     * Where the date goes, `dateNote` goes (owner decision 2026-09-28, §6A 28).
     */
    headline:
      `This compares two windows, so it stands on both — and is only as proven as the weaker of them. ` +
      `${subject} holds ${count(rows.length)}; ${priorSubject} holds ${count(priorRows.length)}. ` +
      `A change between two figures cannot be better evidenced than the figures themselves.${dateNote}`,
    sources: combined.sources,
    checkedThrough: combined.checkedThrough,
    /*
     * Each window named with its OWN verdict, so a reader can see which half is
     * the weak one instead of being told only that one of them is.
     */
    inputs: [
      {
        label: subject,
        verdict: summedRowsProvenance(db, rows, subject, from, to).verdict,
        detail: `${count(rows.length)}, ${readableDay(from)} to ${readableDay(to)}`,
      },
      {
        label: priorSubject,
        verdict: summedRowsProvenance(db, priorRows, priorSubject, against.from, against.to).verdict,
        detail: `${count(priorRows.length)}, ${readableDay(against.from)} to ${readableDay(against.to)}`,
      },
    ],
  };
}

/** The columns every summed-rows proof grades. Named so two selectors cannot drift. */
const SUM_ROW_COLUMNS = {
  id: transactions.id,
  accountId: transactions.accountId,
  postedOn: transactions.postedOn,
  importFileId: transactions.importFileId,
  amountCents: transactions.amountCents,
};

interface SummedRow {
  id: string;
  accountId: string;
  postedOn: string;
  importFileId: string | null;
  amountCents: number;
}

/**
 * The proof behind ANY total assembled by summing transactions over a window.
 *
 * Extracted when merchant spend became the second such figure. Everything from
 * here down is independent of WHICH rows were selected — how each is graded,
 * which documents are named, how many are unchecked, and how far the total is
 * checked through. A second copy of it would be a second opinion about whether
 * a figure adds up, and the app's rule is that a figure has one.
 */
function summedRowsProvenance(
  db: AppDatabase,
  rows: readonly SummedRow[],
  subject: string,
  from: string,
  to: string,
): Provenance {
  return summedRowsProof(db, rows, subject, from, to).provenance;
}

/**
 * `summedRowsProvenance`, with the sentence that says whose word its date is
 * handed back on its own as well — for a caller that writes its OWN headline
 * over this proof and borrows its date (`allSpendProvenance`'s comparison).
 * Where the date goes, that sentence goes (`footingBounds`).
 */
function summedRowsProof(
  db: AppDatabase,
  rows: readonly SummedRow[],
  subject: string,
  from: string,
  to: string,
): { provenance: Provenance; dateNote: string } {
  if (rows.length === 0) {
    /*
     * 🔴 A ZERO IS ONLY MEASURED IF SOMEONE LOOKED. This branch asserted "so
     * this total is zero rather than unproven" for ANY empty window — including
     * one no day of which has been imported. Measured 2026-09-11: the ledger's
     * newest active row is 2026-08-31 and today is 2026-09-11, so the default
     * September window on every category page carried the claim over eleven
     * unread days — **92 figures** across `/categories` and `/budgets` — while
     * the SAME page said the honest thing forty lines below: "September 2026
     * has not been imported yet … That is a window nobody has looked at, not
     * one in which nothing happened." It was equally false before the records
     * open: `?period=2021-05` claimed a measured zero for a month five years
     * before the first import.
     *
     * ⛔ `emptyPeriodReason` is the rule, and it had exactly two callers —
     * `/spending` and `/categories/[id]` — while this, the third surface,
     * asserted its opposite.
     */
    const reason = emptyPeriodReason({
      from,
      to,
      today: todayIso(),
      ledgerOpens: ledgerOpens(db),
      ledgerReaches: ledgerReaches(db),
    });
    const window = `${readableDay(from)} and ${readableDay(to)}`;
    const provenance: Provenance = {
      verdict: "unknown",
      headline:
        reason.kind === "measured"
          ? `No rows in ${subject} between ${window}, so this total is zero rather than unproven.`
          : `Nothing has been imported for ${reason.uncoveredDays} ${reason.uncoveredDays === 1 ? "day" : "days"} between ${window}, so this zero is a window nobody has looked at rather than a measurement.`,
      sources: [],
      checkedThrough: null,
      inputs: [],
    };
    return { provenance, dateNote: "" };
  }

  const coverage = new Map(accountCoverage(db, to).map((c) => [c.accountId, c]));

  const handEntered = rows.filter((r) => r.importFileId === null).length;
  const verdicts = rows.map((r) => (r.importFileId === null ? "manual" : rowGrade(coverage.get(r.accountId), r.postedOn)));
  const proven = verdicts.filter((v) => v === "derived" || v === "sourced").length;
  /**
   * ⛔ Three buckets, not two. Folding `market_value` into "not checked" told
   * the truth about arithmetic and lied about the figure: every
   * `Investments > Buys` row read "0 of 404 checked", as though 404 rows were
   * missing evidence, when what they actually are is priced from holdings —
   * a different kind of basis, not an absent one.
   */
  const marked = verdicts.filter((v) => v === "market_value").length;
  /*
   * 🔴 …and not every one of them is priced from holdings. `market_value` is
   * every investment account's grade; a row on one with no holding events sits
   * in a recorded balance held flat, and the sentence said holdings priced it.
   * `derivesFromHoldings`, once per account — the rule net worth reads above.
   */
  const heldAccountIds = new Set(
    [...new Set(rows.filter((_, i) => verdicts[i] === "market_value").map((r) => r.accountId))].filter(
      (id) => !derivesFromHoldings(db, { id, type: coverage.get(id)!.accountType as AccountType }),
    ),
  );
  const held = rows.filter((r, i) => verdicts[i] === "market_value" && heldAccountIds.has(r.accountId)).length;
  const priced = marked - held;
  /**
   * ⛔ FOUR buckets. `manual` is a basis, not an absence — for cash in a safe
   * the owner IS the best evidence that will ever exist, and calling his own
   * count "nothing checking it" is both wrong and insulting to the only source
   * there is. It read exactly that way on /budgets before this.
   */
  const byHand = verdicts.filter((v) => v === "manual").length;
  const weak = rows.length - proven - marked - byHand;
  const verdict = weakestVerdict(verdicts);

  const fileIds = [...new Set(rows.map((r) => r.importFileId).filter((f): f is string => f !== null))];
  const files =
    fileIds.length === 0
      ? []
      : db.select().from(importFiles).where(inArray(importFiles.id, fileIds)).orderBy(desc(importFiles.importedAt)).all();

  const sources: ProvenanceSource[] = files.slice(0, SOURCES_NAMED).map((f) => ({
    kind: "document" as const,
    label: f.fileName,
    detail: `read by ${f.parserProfile ?? "an unnamed parser"}`,
    on: f.importedAt.slice(0, 10),
  }));
  if (files.length > SOURCES_NAMED) {
    // 🔴 "and 1 more documents" — the hand-entered row four lines below has
    // pluralised its own noun since it shipped
    const rest = files.length - SOURCES_NAMED;
    sources.push({
      kind: "document",
      label: `and ${rest} more ${rest === 1 ? "document" : "documents"}`,
      detail: "not listed",
    });
  }
  if (handEntered > 0) {
    sources.push({
      kind: "hand-entered",
      label: `${grouped(handEntered)} ${handEntered === 1 ? "row" : "rows"} you entered by hand`,
      detail: handEntered === 1 ? "no statement carries it" : "no statement carries them",
    });
  }

  const parts = [
    `${grouped(rows.length)} ${rows.length === 1 ? "row" : "rows"} from ${grouped(files.length)} ${files.length === 1 ? "document" : "documents"}`,
  ];
  if (priced > 0) parts.push(`${grouped(priced)} ${priced === 1 ? "is" : "are"} priced from holdings rather than checked by arithmetic`);
  if (held > 0) parts.push(`${grouped(held)} ${held === 1 ? "is" : "are"} held at a recorded balance rather than checked by arithmetic`);
  if (byHand > 0) parts.push(`${grouped(byHand)} you entered yourself`);
  if (weak > 0) parts.push(`${grouped(weak)} ${weak === 1 ? "has" : "have"} nothing checking ${weak === 1 ? "it" : "them"}`);

  /*
   * The last day EVERY contributing row is still covered — the first account to
   * stop being checked bounds the whole total, exactly as it does for net worth.
   *
   * 🔴 …and "exactly as it does for net worth" was a claim this code did not
   * keep. It compared `verifiedThrough` alone, so an account resting on a
   * balance he TYPED — which has none — dropped out of the comparison and the
   * date ran past the day the app itself calls that account unchecked. Measured
   * 2026-09-22 on a copy of the real ledger: /categories/Car Payment for August
   * 2026 sums the $5,000.00 down payment out of Cash on Hand with one Chase
   * Checking row and read "Checked through 2026-08-12" — Chase's chain — beside
   * a trust card saying nothing has checked Cash on Hand since Aug 11.
   *
   * ⛔ …and a count dates a total standing on it ALONE, exactly as it dates net
   * worth. This stayed null with nothing checked underneath, so a total over
   * Cash on Hand alone printed no date beside a net worth that printed the day
   * his count stops standing; his call, 2026-09-28 (handoff §6A 28), is that
   * they agree. The sentence beside the date says the day is his word.
   */
  const contributing = [...new Set(rows.map((r) => r.accountId))]
    .map((a) => coverage.get(a))
    .filter((c): c is AccountCoverage => c !== undefined);
  const footing = footingBounds(contributing);

  const provenance: Provenance = {
    verdict,
    // the badge only overrides when rows are genuinely UNCHECKED — a category
    // that is entirely market value should read "market value", not a fraction
    // …and a market-value total wears the verdict's word whenever any of it is not priced from holdings
    badgeWord:
      weak === 0
        ? verdict === "market_value"
          ? marketValueBadgeWord(held === 0)
          : undefined
        : `${grouped(rows.length - weak)} of ${grouped(rows.length)} checked`,
    headline: `This total is the sum of ${parts.join(", ")}. A total is only as proven as its weakest row.${footing.note}`,
    sources,
    checkedThrough: footing.through,
    inputs: [],
  };
  return { provenance, dateNote: footing.note };
}

/**
 * The grade ONE imported row gets from its account's chain — inside every
 * category, merchant, spending and account-rows total, and on the row's own
 * sheet (`transactionProvenance`).
 *
 * ⛔ One function, because it was a closure inside `summedRowsProvenance` and
 * the sheet kept a copy of what it believed the closure said — see S19 in
 * `transactionProvenance`. A second opinion about whether a row is checked is
 * the defect, whichever of the two is right.
 *
 * 🔴 A row before the chain OPENS is not checked, however far `verifiedThrough`
 * reaches — see `AccountCoverage.chainOpensOn`. Robinhood Cash's Dec 6 and Dec
 * 7, 2023 rows counted in "2,387 of 2,392 checked" beside sheets saying nothing
 * checks them (measured 2026-09-15).
 */
function rowGrade(c: AccountCoverage | undefined, postedOn: string): ProvenanceVerdict {
  if (!c) return "unknown";
  if (c.grade === "market_value" || c.grade === "manual") return GRADE_VERDICT[c.grade];
  if (c.brokenSince !== null && postedOn >= c.brokenSince) return "broken";
  if (c.verifiedThrough !== null && c.chainOpensOn !== null && postedOn >= c.chainOpensOn && postedOn <= c.verifiedThrough) {
    return "derived";
  }
  return c.grade === "unknown" ? "unknown" : "unverified";
}

/* ── a plan, rather than a measurement ────────────────────────────────── */

/** How a budget's period reads inside a sentence about its amount. */
const PLAN_PER: Record<BudgetPeriodKind, string> = {
  daily: "a day",
  weekly: "a week",
  monthly: "a month",
  annual: "a year",
};

/**
 * What backs a BUDGET's plan amount — the only figure in this app that is a
 * decision instead of a measurement.
 *
 * ⛔ The honest answer is "nothing checks it", and here that is not a weakness.
 * Every other figure this service grades is a claim about something that
 * happened, so an absent document is a hole. A budget is a claim about what he
 * INTENDS, and there is nothing in the world it could be checked against until
 * the period ends — at which point the thing that closes against a document is
 * the ACTUAL, which `/budgets` already proves separately with `categorySpend`.
 * `manual` is the right verdict for the same reason it is right for cash in a
 * safe: the owner is not a missing source, he is the source.
 *
 * ⚠️ The wording deliberately does NOT say "you typed this". The real budgets
 * were sized by `pnpm propose-budgets` from measured income and then kept, and
 * the schema carries no column that could tell a typed plan from an accepted
 * proposal. A proof that claimed to know which one it was would be asserting
 * something the database cannot support — the exact move this service exists to
 * refuse. So it says what is true of both: a plan is a decision.
 *
 * ⛔ It proves the PLAN and nothing else. When rollover is on, the line the
 * period is actually graded against is the plan PLUS a carry computed from
 * closed periods, and that carry is derived from the ledger rather than chosen.
 * The headline says so, and says it in WORDS rather than in a figure: reading
 * the carry would mean recomputing `budgetStatuses` here, and a proof that
 * quietly re-derives its subject's neighbour is how two definitions of one
 * number get born.
 */
function budgetPlanProvenance(db: AppDatabase, id: string, label: string | undefined): Provenance | null {
  const budget = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!budget) return null;
  const category = db.select().from(categories).where(eq(categories.id, budget.categoryId)).get();

  const subject = label ?? category?.name ?? "this budget";
  const amount = formatCents(budget.amountCents);
  const per = PLAN_PER[budget.period];
  // the day he decided, not the day the plan starts running — `startsOn` is
  // backdatable and says when the money is planned FOR, which is a different fact
  const decidedOn = budget.createdAt.slice(0, 10);

  const sources: ProvenanceSource[] = [
    {
      kind: "hand-entered",
      label: `${amount} ${per} for ${subject}`,
      detail: "a plan you set — no document states it",
      on: decidedOn,
    },
  ];
  if (budget.rolloverEnabled) {
    sources.push({
      kind: "period",
      label: "rollover is on",
      detail: "unspent plan from closed periods is added to this one, and that carry is computed from your ledger",
    });
  }

  const started = `It has been running since ${readableDay(budget.startsOn)}`;
  const ended = budget.endsOn ? `, and it stops after ${readableDay(budget.endsOn)}` : "";
  const carry = budget.rolloverEnabled
    ? " Rollover is on, so what this period is graded against is this plan plus whatever you underspent in closed periods — that carry is measured from your ledger and is not part of what you chose."
    : "";

  return {
    verdict: "manual",
    /*
     * ⛔ `manual`'s stock word is "you entered it", and this is the one figure
     * where that over-claims. The headline is careful not to say he typed it —
     * the real budgets were sized by `pnpm propose-budgets` and kept, and no
     * column can tell a typed plan from an accepted proposal — so the badge
     * must not say it either, or the two disagree at a glance. The TONE is
     * unchanged: a plan is neither proven nor weak, which is what neutral means.
     */
    badgeWord: "a plan",
    headline:
      `This is a plan, not a record: ${amount} ${per} for ${subject}, decided rather than measured. ` +
      `Nothing checks it, because until the period ends there is nothing for it to be checked against — ` +
      `what closes against a document is the spending beside it, not the budget. ${started}${ended}.${carry}`,
    sources,
    // a plan is never "checked through" a day; the day it was decided is named
    // in `sources`, where it reads as a decision rather than as a guarantee
    checkedThrough: null,
    inputs: [],
  };
}

/* ── entry point ──────────────────────────────────────────────────────── */

/**
 * What backs a rendered figure. Returns `null` only when the figure's subject
 * does not exist — an unproven figure is an answer, not an absence.
 */
export function provenanceFor(db: AppDatabase, ref: FigureRef): Provenance | null {
  switch (ref.kind) {
    case "transaction":
      return transactionProvenance(db, ref.id);
    case "accountBalance":
      return accountBalanceProvenance(db, ref.accountId, ref.day);
    case "statementPeriod":
      return statementPeriodProvenance(db, ref.id);
    case "netWorth":
      return netWorthProvenance(db, ref.day);
    case "categorySpend":
      return categorySpendProvenance(db, ref.categoryId, ref.from, ref.to, ref.label);
    case "merchantSpend":
      return merchantSpendProvenance(db, ref.merchantId, ref.from, ref.to, ref.label);
    case "accountRows":
      return accountRowsProvenance(db, ref.accountId, ref.label);
    case "holding":
      return holdingProvenance(db, ref.symbol, ref.assetType, ref.day);
    case "recurringSeries":
      return recurringSeriesProvenance(db, ref.id);
    case "allSpend":
      return allSpendProvenance(db, ref.from, ref.to, ref.label, ref.against);
    case "budgetPlan":
      return budgetPlanProvenance(db, ref.id, ref.label);
  }
}
