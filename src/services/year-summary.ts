import { and, asc, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { importFiles } from "@/db/schema/imports";
import { recurringSeries, type SeriesStatus } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import {
  moneyWeightedReturn,
  type MoneyWeightedReturn,
  type ReturnBoundary,
} from "@/lib/money-weighted-return";
import type { CashFlow } from "@/lib/xirr";
import { diffDays } from "@/lib/dates";
import { formatDayFull, formatDayShort } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { seriesDrawsAsRecurring } from "@/lib/series-evidence";
import { yearSummary, type YearLineInput, type YearSummary } from "@/lib/year-summary";
import { investmentSideAccountIds, outsidePortfolioCashAccountIds } from "./accounts";
import { offAgentsCash } from "./analytics";
import { portfolioSeries, realizedSalesByDay } from "./portfolio";
import { fitCadence, gapKeepsCadence, median } from "./recurring";
import { yearSpendingWindow, type YearSpendingWindow } from "./year-insights";

/**
 * A calendar year, assembled from the ledger for `/summary/[year]`.
 *
 * ⛔ **Every grouping decision here is quoted from `docs/income-ground-truth.md`,
 * not invented.** That doc is the owner's own rule about what he counts as
 * earned, and this module's `basis` strings say which part of it each line is
 * standing on, so a reader can check the classification and not just the sum.
 *
 * ⚠️ This is a summary of records. It is not tax advice, it is not a tax
 * document, and the page says so — see `SUMMARY_DISCLAIMER`.
 */

/** The page's own words about what it is. Rendered, not just intended. */
export const SUMMARY_DISCLAIMER =
  "This is a summary of your own records, produced from the statements you imported. " +
  "It is not tax advice and it is not a tax document — figures here are grouped the way " +
  "you separate them, which is not necessarily how any tax authority would.";

/**
 * ⚠️ `Income › Salary` is NO LONGER pure Fordham.
 *
 * The ground-truth doc records that Fordham work-study ended 2026-05-13 and the
 * owner now earns from a cash job whose deposits he asked to be categorized
 * `Salary`. Both are earned, so both sit in the earned section — but they are
 * separate LINES, because "your wages" and "your cash job" are different
 * answers and a single $-figure would hide which one moved.
 */
const FORDHAM_DESCRIPTOR = "%FORDHAM%";

interface RawLine {
  amountCents: number;
  rowCount: number;
  sourcedRowCount: number;
  sources: string[];
}

export interface YearGambling {
  wonCents: number;
  lostCents: number;
  netCents: number;
  rowCount: number;
  /**
   * the days read — What you spent's own (`yearSpendingWindow`), or null when the ledger has not reached the year and
   * the page measures no spending in it, so there is no gambling to print either
   */
  window: YearSpendingWindow | null;
}

/** Re-exported so callers need not know which module decides this. */
export type XirrStatus = MoneyWeightedReturn;

export interface YearSummaryView {
  year: number;
  summary: YearSummary;
  /**
   * Kept out of every section on purpose. Gambling is net-negative in both
   * measured years, so it is not "money in" — and pass 45 settled that winnings
   * are not income. It gets its own block, never a row in a total.
   */
  gambling: YearGambling;
  /** the year's money-weighted return, or why it was withheld */
  moneyWeightedReturn: XirrStatus;
  disclaimer: string;
  /** years the ledger holds any activity for, newest first */
  availableYears: number[];
}

function yearBounds(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Income-side rows for one category name, in one year, with their documents.
 *
 * ⚖️ `agentsCash` is POSITIONAL AND REQUIRED, not one more optional filter. It was an option
 * (`accountIdNotIn`) that the Dividends line passed and the page's ten other lines did not, and every one of them
 * read the agent's cash account as a result — see the scope's own test. A line cannot be written now without
 * answering whose money it counts.
 */
function lineFor(
  db: AppDatabase,
  year: number,
  /** `outsidePortfolioCashAccountIds` — never his, on any line (`ownPortfolioAccountIds`) */
  agentsCash: readonly string[],
  opts: LineOptions,
): RawLine {
  return rawLineOf(lineRows(db, year, agentsCash, opts), opts.direction);
}

interface LineOptions {
  categoryName: string;
  /** restrict to one account name */
  accountName?: string;
  /**
   * …or to every account EXCEPT these. The mirror of `accountName`, and the
   * reason it exists: two lines split `Interest` by account name, so interest
   * credited anywhere else belonged to neither and was counted in no total.
   */
  accountNameNotIn?: readonly string[];
  /** SQL LIKE against the raw descriptor, or its negation */
  descriptorLike?: string;
  descriptorNotLike?: string;
  /** money IN by default; "out" measures the returning leg as a magnitude */
  direction?: "in" | "out";
}

interface LineRow {
  amountCents: number;
  postedOn: string;
  recurringSeriesId: string | null;
  importFileId: string | null;
  fileName: string | null;
}

/**
 * The rows behind one line. Kept apart from the sum so a line that says something ABOUT its rows — the pay line's
 * name and caveat — reads the very rows its figure adds up, not a second query that could drift from them.
 */
function lineRows(db: AppDatabase, year: number, agentsCash: readonly string[], opts: LineOptions): LineRow[] {
  const { from, to } = yearBounds(year);
  const where = [
    eq(transactions.status, "active"),
    gte(transactions.postedOn, from),
    lte(transactions.postedOn, to),
    eq(categories.name, opts.categoryName),
    opts.direction === "out"
      ? sql`${transactions.amountCents} < 0`
      : sql`${transactions.amountCents} > 0`,
  ];
  if (opts.accountName) where.push(eq(accounts.name, opts.accountName));
  if (opts.accountNameNotIn && opts.accountNameNotIn.length > 0) {
    where.push(notInArray(accounts.name, [...opts.accountNameNotIn]));
  }
  if (agentsCash.length > 0) where.push(notInArray(accounts.id, [...agentsCash]));
  if (opts.descriptorLike) {
    where.push(sql`upper(${transactions.rawDescription}) LIKE ${opts.descriptorLike}`);
  }
  if (opts.descriptorNotLike) {
    where.push(sql`upper(${transactions.rawDescription}) NOT LIKE ${opts.descriptorNotLike}`);
  }

  return db
    .select({
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
      recurringSeriesId: transactions.recurringSeriesId,
      importFileId: transactions.importFileId,
      fileName: importFiles.fileName,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(importFiles, eq(importFiles.id, transactions.importFileId))
    .where(and(...where))
    .all();
}

function rawLineOf(rows: readonly LineRow[], direction: LineOptions["direction"]): RawLine {
  const signed = rows.reduce((t, r) => t + r.amountCents, 0);
  return {
    // always a positive magnitude — the section headings say the direction
    amountCents: direction === "out" ? -signed : signed,
    rowCount: rows.length,
    sourcedRowCount: rows.filter((r) => r.importFileId !== null).length,
    sources: [...new Set(rows.map((r) => r.fileName).filter((n): n is string => n !== null))].sort(),
  };
}

/** Realized gains for the calendar year, off the shared average-cost walk. */
function realizedFor(db: AppDatabase, year: number): RawLine & { exact: boolean } {
  let gainCents = 0;
  let sales = 0;
  let exact = true;
  for (const [day, list] of realizedSalesByDay(db)) {
    if (day.slice(0, 4) !== String(year)) continue;
    for (const s of list) {
      gainCents += s.gainCents;
      sales += 1;
      if (!s.exact) exact = false;
    }
  }
  // a derived walk has no import file of its own — the HOLDINGS behind it do,
  // and saying "0 of 31 sourced" is the honest way to report that
  return { amountCents: gainCents, rowCount: sales, sourcedRowCount: 0, sources: [], exact };
}

/**
 * ⚖️ The page's one scope, as on every line (`lineFor`): the agent's cash is none of his gambling. What the agent's
 * account pays is not his spending (owner decision 2026-10-02, §6A 34), and the block says his losses sit inside the
 * figure under What you spent. 🔴 Read from every account, a loss on the agent's cash was in Lost and in no Spent.
 *
 * ⛔ …and What you spent's DAYS, not the calendar year's. On a running year that figure stops on the last day every
 * account you spend from has been imported through (`yearSpendingWindow`, /spending's cut of the same year). 🔴 Read
 * Jan 1 – Dec 31, a loss posted past that day — on an account imported further than the one holding the year back —
 * was in Lost and in no Spent, under the same sentence. The block reads the window and names it (`gamblingNote`).
 */
function gamblingFor(db: AppDatabase, window: YearSpendingWindow | null, agentsCash: readonly string[]): YearGambling {
  const none = { wonCents: 0, lostCents: 0, netCents: 0, rowCount: 0, window };
  if (window === null) return none;
  const { from, to } = window;
  const parent = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, "Gambling"))
    .all()
    .map((c) => c.id);
  if (parent.length === 0) return none;

  const ids = db
    .select({ id: categories.id })
    .from(categories)
    .where(inArray(categories.parentId, parent))
    .all()
    .map((c) => c.id);

  const rows = db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
        inArray(transactions.categoryId, [...parent, ...ids]),
        offAgentsCash(agentsCash),
      ),
    )
    .all();

  const wonCents = rows.filter((r) => r.amountCents > 0).reduce((t, r) => t + r.amountCents, 0);
  const lostCents = rows.filter((r) => r.amountCents < 0).reduce((t, r) => t - r.amountCents, 0);
  return { wonCents, lostCents, netCents: wonCents - lostCents, rowCount: rows.length, window };
}

/**
 * The gambling block's sentence — what its figures are counted in, and where. Written here rather than on the page,
 * beside the window it names, so the claim and the days it is true over are one decision.
 *
 * ⛔ "They sit inside the figure under What you spent" is true of Lost because Lost reads that figure's own days
 * (`gamblingFor`). On a running year those days stop short of December, and the sentence says so and where — a reader
 * holding Lost against the year's Gambling rows in the ledger must not have to guess why the two differ.
 *
 * 🔴 …and only when that figure is ON the page. The block prints whenever it holds a row; What you spent only when
 * the year measured spending above zero (`yearSpendingView`). A year whose only Gambling row was a win printed the
 * block alone, pointing at "the figure under What you spent" with none there. `spentShown` is the page's own test.
 */
export function gamblingNote(gambling: YearGambling, spentShown: boolean): string {
  const head =
    "Counted in none of the money-in totals above: winnings are not treated as income here. Losses are spending — " +
    "your categories file Gambling as an expense";
  const inside = `${head} — and they sit inside the figure under What you spent`;
  const w = gambling.window;
  if (w === null || !w.truncated) return spentShown ? `${inside}.` : `${head}.`;
  const importing = `${w.from.slice(0, 4)} is still being imported`;
  const lastDay = `${formatDayShort(w.to)}, the last day every account you spend from has been imported through.`;
  if (!spentShown) return `${head}. ${importing}, so these figures stop on ${lastDay}`;
  return `${inside}, over the same days: ${importing}, so both stop on ${lastDay}`;
}

/**
 * The block's Lost, a magnitude printed as an outflow — "−$442.50" — and no loss as "$0.00": there is no such amount as
 * negative zero dollars (`formatCents`), and a sign on nothing claims a loss that did not happen.
 */
export function gamblingLostFigure(lostCents: number): string {
  return lostCents === 0 ? formatCents(0) : `−${formatCents(lostCents)}`;
}

/**
 * Gathers the two boundary valuations and the year's external flows, then hands
 * the DECISION to `lib/money-weighted-return`.
 *
 * The withholding rules live there, not here, because they are the valuable
 * part and they need the 100%-branch gate: a mutation that deleted the
 * incomplete-opening guard survived this file's tests, since reaching that
 * branch through the database takes a seeded portfolio with prices and holdings.
 */
/**
 * The Investment Contribution rows that really CROSS the boundary — one row per
 * movement, from the account outside the brokerage.
 *
 * 🔴 The exclusion here was `type in (checking, savings)`, and a brokerage's own
 * settlement sleeve is typed `checking`. `lib/account-side` exists for exactly
 * this and says so — "detection's descriptor rules + pair categories key off
 * this classification, NOT the raw account type" — and this was the one caller
 * still using the type.
 *
 * So BOTH legs of every contribution were selected. They land on the same day,
 * the caller's `byDay` nets them to zero, and `lib/money-weighted-return` drops
 * zeroed days: of 23 flow days in 2026, 16 vanished and the 7 survivors netted
 * to +$87.22. With almost no flows left the XIRR degenerates to the raw
 * close/open ratio annualised, and `/summary/2026` printed
 *
 *     Investment return   115.42 % a year   Money-weighted
 *
 * of a window in which $25,554.42 of NEW MONEY went in ($26,854.42 out of Chase
 * Checking, $1,300.00 out of SoFi) against a portfolio that moved $65,038.62 →
 * $108,980.71. The honest figure is 36.15% a year, and the one on screen was
 * crediting the deposits as gain.
 */
export function externalInvestmentFlows(
  db: AppDatabase,
  from: string,
  through: string,
): { day: string; amountCents: number }[] {
  const investmentSide = investmentSideAccountIds(db);
  return db
    .select({
      day: transactions.postedOn,
      amountCents: transactions.amountCents,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, through),
        eq(categories.name, "Investment Contribution"),
      ),
    )
    .orderBy(asc(transactions.postedOn))
    .all()
    .filter((r) => !investmentSide.has(r.accountId))
    .map((r) => ({ day: r.day, amountCents: r.amountCents }));
}

function moneyWeightedReturnFor(db: AppDatabase, year: number, today: string): XirrStatus {
  const series = portfolioSeries(db);
  const at = (day: string): ReturnBoundary | null => {
    let found: (typeof series)[number] | undefined;
    for (const p of series) {
      if (p.day <= day) found = p;
      else break;
    }
    return found
      ? {
          day: found.day,
          valueCents: found.valueCents,
          complete: found.complete,
          coveredAccounts: found.coveredAccounts,
          totalAccounts: found.totalAccounts,
        }
      : null;
  };

  const { from, to } = yearBounds(year);
  const closeDay = to < today ? to : today;

  // External flows only — see `externalInvestmentFlows`.
  const byDay = new Map<string, number>();
  for (const c of externalInvestmentFlows(db, from, closeDay)) {
    // cash leaving checking (negative) is money INTO the investment: an
    // investor-signed negative flow. Money coming back is positive.
    byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.amountCents);
  }
  const flows: CashFlow[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, amountCents]) => ({ day, amountCents }));

  return moneyWeightedReturn({ open: at(`${year - 1}-12-31`), close: at(closeDay), flows, windowEnd: to });
}

/** Every calendar year the ledger holds an active row for, newest first. */
export function summaryYears(db: AppDatabase): number[] {
  const rows = db
    .select({ y: sql<string>`substr(${transactions.postedOn}, 1, 4)` })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .groupBy(sql`substr(${transactions.postedOn}, 1, 4)`)
    .all();
  return rows.map((r) => Number(r.y)).sort((a, b) => b - a);
}

/**
 * ⛔ THE SECOND SENTENCE IS A FACT ABOUT 2026, and it was printed on every year.
 *
 * 🔴 Measured on the owner's `/summary/2022`: "Cash job $1,388.10 — Salary rows
 * that are not Fordham payroll. **Work-study ended 2026-05-13 and these deposits
 * are the job that replaced it.**" The row behind that figure is a single
 * `Deposit 1183713709` from 2022-08-25 — it cannot be from a job that replaced
 * something which ended four years later. A description printed unconditionally
 * became a false claim about the world the moment it was read on an early year.
 *
 * The first sentence is the RULE and is true of every year, so it always shows.
 * The history only appears where the history had happened.
 */
const WORK_STUDY_ENDED = "2026-05-13";

/**
 * ⛔ AND THE LABEL IS A CLAIM TOO — the half the fix above left behind.
 *
 * 🔴 With only the sentence made year-aware, `/summary/2022` read, on two
 * adjacent lines:
 *
 *     Cash job                                          $1,388.10
 *     Salary rows that are not Fordham payroll. In 2022 that is not yet the
 *     cash job — work-study ran until 2026-05-13.
 *
 * The row denied its own heading, and a caveat underneath does not undo a wrong
 * name on top — the heading is what a reader scanning the page takes away.
 *
 * ⛔ ONE decision, not two that agree. The label and the sentence come out of
 * this function together, so a later edit cannot move one and leave the other
 * behind, which is exactly how the first half shipped alone.
 *
 * The early label names the RULE (`Salary, not Fordham payroll`), which is true
 * of every year and claims no job at all — and the early sentence no longer has
 * to deny a heading that no longer says anything to deny.
 *
 * ⛔ AND THE CAVEAT IS THE THIRD CLAIM — the one both fixes above left behind.
 *
 * 🔴 Passed as a literal on every year, `/summary/2022` printed in red, under a
 * basis saying the ledger cannot name the job, "Deposited irregularly, so a
 * calendar year captures what reached the bank rather than what was worked."
 * (measured 2026-09-15). Irregular deposits are a fact about the 2026 cash
 * job's ATM lumps; 2022 holds one branch deposit, which shows no pattern and no
 * work. So the caveat comes out of this decision too, and an early year has
 * none.
 *
 * ⛔ AND THE LATE LABEL WAS A LITERAL — it named a job the owner had renamed.
 *
 * 🔴 Measured on `/summary/2026`, 2026-10-07: "Cash job $7,156.60". All 4 rows are attached to the pay series he
 * renamed on 2026-09-28 to name the payer, "It America LLC (weekly pay)", and two of them are ACH payroll into Wells
 * Fargo — not cash at all. Every other surface printed the series' name; this one printed a string. So the label is
 * READ off the rows now: one income series behind every row names the line; rows in several series, or in none, get
 * the rule's name, which claims no job — and then neither does the basis.
 *
 * And the caveat is a claim about the rows, so it is measured on them (`depositsAreIrregular`): his 2026 is two June
 * ATM lumps and a four-week payroll lump in September; a payroll that lands every week is not irregular.
 */
const PAY_RULE_LABEL = "Salary, not Fordham payroll";

/** What the pay line's own rows say about themselves — read from the rows its figure sums. */
export interface PayLineFacts {
  /** the one income series every row is attached to, or null when they sit in several or in none */
  seriesName: string | null;
  /** each row's posted day */
  postedOn: readonly string[];
}

export function cashJobNaming(year: number, facts: PayLineFacts): { label: string; basis: string; caveat?: string } {
  const named = facts.seriesName !== null;
  const rule = named
    ? "Salary rows that are not Fordham payroll, every one attached to this pay series."
    : "Salary rows that are not Fordham payroll.";
  // 🔴 PROSE, so the date is spelled: both sentences printed the raw constant
  // ("Work-study ended 2026-05-13 and…") on /summary/2026 and /summary/2022.
  // ⛔ Only the sentence is formatted — the year gate below must keep reading
  // the ISO constant, whose first four characters are the year.
  const ended = formatDayFull(WORK_STUDY_ENDED);
  const label = facts.seriesName ?? PAY_RULE_LABEL;
  if (year >= Number(WORK_STUDY_ENDED.slice(0, 4))) {
    return {
      label,
      basis: named
        ? `${rule} Work-study ended ${ended}, and these deposits are the job that replaced it.`
        : `${rule} Work-study ended ${ended}; these rows are not all attached to one pay series, so which job they are, this ledger does not say.`,
      ...(depositsAreIrregular(facts.postedOn)
        ? {
            caveat:
              "Deposited irregularly, so a calendar year captures what reached the bank rather than what was worked.",
          }
        : {}),
    };
  }
  return {
    label,
    basis: named
      ? `${rule} Work-study ran until ${ended}, so in ${year} these are an earlier job.`
      : `${rule} Work-study ran until ${ended}, so in ${year} these are an earlier job — which one, this ledger does not say.`,
  };
}

/**
 * Do the rows SHOW irregular deposits? Only a rhythm can be broken, so it takes three deposit days — two gaps — to
 * show one; fewer says nothing, and the caveat stays off rather than guessing.
 *
 * ⛔ DETECTION'S RHYTHM, NOT A SLACK OF ITS OWN. The cadence is fitted to the rows' own median gap as recurring
 * detection fits one (`fitCadence`), so no series is assumed and it holds for rows in none; each gap must then keep
 * that cadence by detection's tolerance (`gapKeepsCadence`). Rows whose median gap fits no cadence keep no rhythm a
 * payroll keeps — his 2026, two June ATM lumps and a September payroll lump (gaps 1, 110, 1), is that.
 *
 * 🔴 It allowed the gaps a SPREAD of 3 days (longest minus shortest), a number of its own. A weekly payday moved a day
 * early one week and a day late the next — Wed, Fri, Wed — has gaps 9 and 5, a spread of 4, so the caveat called a
 * payroll irregular that detection, holding a weekly gap to 2 days either side of the median, calls on time. Latent
 * on his ledger (2026-10-08): his 2026 holds its June lumps either way; his payroll has landed on a Wed and a Thu.
 */
function depositsAreIrregular(postedOn: readonly string[]): boolean {
  const days = [...new Set(postedOn)].sort();
  if (days.length < 3) return false;
  const gaps = days.slice(1).map((day, i) => diffDays(days[i]!, day));
  const medianGap = median(gaps);
  const cadence = fitCadence(medianGap, days.map((day) => Number(day.slice(8, 10))));
  return cadence === null || !gaps.every((gap) => gapKeepsCadence(gap, medianGap, cadence));
}

/**
 * A series he STANDS BEHIND, and so one whose name may head his pay: confirmed, or ended (a job that stopped was
 * still that job). ⛔ Dismissed is out by the repo's one rule (`seriesDrawsAsRecurring`) — dismissing flips the
 * status and leaves every row attached, so the link alone would keep naming a series he rejected. Detected is out
 * too: it is the detector's suggestion, which every other surface labels "suggested" (`seriesRowLabel`), not his word.
 */
function seriesNamesPay(status: SeriesStatus): boolean {
  return seriesDrawsAsRecurring(status) && status !== "detected";
}

/** One income series he stands behind, behind EVERY row, names the line; anything else — several, none, a loose row — does not. */
function payLineFacts(db: AppDatabase, rows: readonly LineRow[]): PayLineFacts {
  const postedOn = rows.map((r) => r.postedOn);
  const ids = new Set(rows.map((r) => r.recurringSeriesId));
  const [only] = [...ids];
  if (ids.size !== 1 || only === null || only === undefined) return { seriesName: null, postedOn };
  const series = db
    .select({ name: recurringSeries.name, kind: recurringSeries.kind, status: recurringSeries.status })
    .from(recurringSeries)
    .where(eq(recurringSeries.id, only))
    .get();
  const named = series !== undefined && series.kind === "income" && seriesNamesPay(series.status);
  return { seriesName: named ? series.name : null, postedOn };
}

export function yearSummaryView(db: AppDatabase, year: number, today: string): YearSummaryView {
  const line = (
    id: string,
    label: string,
    section: YearLineInput["section"],
    basis: string,
    raw: RawLine,
    caveat?: string,
    counter?: { counterCents: number; counterLabel: string },
  ): YearLineInput | null =>
    raw.rowCount === 0 ? null : { id, label, section, basis, caveat, ...raw, ...counter };

  const realized = realizedFor(db, year);
  /*
   * ⚖️ THE WHOLE PAGE IS HIS MONEY, in one scope. Realized reads his books only (`realizedSalesByDay`), and the owner
   * kept Robinhood Agentic out of his brokerage returns (2026-09-14) — so a dividend the agent's shares pay, credited
   * to Agentic, is not his either. 🔴 Read from every account, the agent's $0.06 was in his Dividends while the
   * agent's sale was not in his Realized (measured 2026-09-16).
   *
   * 🔴 …and then the scope gated the Dividends line ALONE. The agent's cash is uninvested between its buys and
   * Robinhood pays interest on it: filed `Income > Interest` on an account named neither "SoFi Savings" nor
   * "Robinhood Cash", that interest fell into "Interest on other accounts" and was printed under "Money in that you
   * did not earn" — his, on the page that had just refused his agent's dividends. Stock-lending pay, filed "Other
   * Income", did the same one line below. So `lineFor` takes it as a REQUIRED argument now rather than an option a
   * line can forget, and every line on the page reads the one scope.
   */
  const agentsCash = [...outsidePortfolioCashAccountIds(db)];
  // ONE decision for all three claims the cash-job line makes (see `cashJobNaming`), read off the very rows it sums
  const payRows = lineRows(db, year, agentsCash, { categoryName: "Salary", descriptorNotLike: FORDHAM_DESCRIPTOR });
  const cashJob = cashJobNaming(year, payLineFacts(db, payRows));

  const lines = [
    line(
      "fordham",
      "Fordham work-study wages",
      "earned",
      "Biweekly ACH direct deposit described FORDHAM UNIVERSI PAYROLL — the first term in your own definition of earnings.",
      lineFor(db, year, agentsCash, { categoryName: "Salary", descriptorLike: FORDHAM_DESCRIPTOR }),
    ),
    line(
      "cash-job",
      cashJob.label,
      "earned",
      cashJob.basis,
      rawLineOf(payRows, "in"),
      cashJob.caveat,
    ),
    line(
      "knack",
      "Knack tutoring",
      "earned",
      "Payouts described KNACK PAYOUT — the second term in your definition of earnings.",
      lineFor(db, year, agentsCash, { categoryName: "Tutoring" }),
    ),
    line(
      "sofi-interest",
      "SoFi savings interest",
      "earned",
      "Interest credited to the SoFi savings account — the third term in your definition of earnings.",
      lineFor(db, year, agentsCash, { categoryName: "Interest", accountName: "SoFi Savings" }),
    ),
    line(
      "dividends",
      "Dividends",
      "investment",
      "Dividends credited inside the brokerage.",
      lineFor(db, year, agentsCash, { categoryName: "Dividends" }),
    ),
    line(
      "brokerage-interest",
      "Brokerage cash interest",
      "investment",
      "Interest paid on uninvested brokerage cash. Separated from SoFi savings interest, which your rule counts as earnings.",
      lineFor(db, year, agentsCash, { categoryName: "Interest", accountName: "Robinhood Cash" }),
    ),
    /*
     * ⛔ The two lines above split `Interest` by ACCOUNT NAME, so interest
     * credited to any third account fell between them — 7 rows across
     * 2023-2026, absent from a page headed "All money in". `line()` returns
     * null at zero rows, so this appears only on years that have some.
     */
    line(
      "other-interest",
      "Interest on other accounts",
      "notEarned",
      "Interest credited somewhere other than the SoFi savings account or brokerage cash — money in, but outside your definition of earnings.",
      lineFor(db, year, agentsCash, {
        categoryName: "Interest",
        accountNameNotIn: ["SoFi Savings", "Robinhood Cash"],
      }),
    ),
    line(
      "realized",
      "Realized gains",
      "investment",
      "An average-cost walk over every sale in the year, valued at each day's close — the same walk the holdings table reads.",
      realized,
      realized.exact
        ? "Estimated: execution prices are not recorded, so each sale is valued at its day's close."
        : "Estimated, and PARTIAL — at least one trade had no close price, so it is missing from this figure.",
    ),
    line(
      "aid",
      "Financial aid refund",
      "notEarned",
      "Tuition is paid from an account this ledger does not hold; the aid is deducted and the balance refunded to you. Money in from outside, but not earned.",
      lineFor(db, year, agentsCash, { categoryName: "Financial Aid" }),
    ),
    line(
      "reimbursements",
      "Refunds and reimbursements",
      "notEarned",
      "Money coming back to you, not money you were paid.",
      lineFor(db, year, agentsCash, { categoryName: "Refunds & Reimbursements" }),
    ),
    line(
      "other-income",
      "Other income",
      "notEarned",
      /*
       * 🔴 IT IS NOT A RESIDUAL. This line is the category literally named
       * "Other Income", and the sentence promised every income-kind row the
       * lines above do not claim. Measured 2026-09-11, the difference was real:
       * 7 interest rows credited to SoFi CHECKING sat in no line at all,
       * because the two `Interest` lines are pinned to SoFi Savings and
       * Robinhood Cash by name. They have their own line now, and this
       * description says what it actually holds.
       */
      "Rows you filed to the Other Income category — money in that belongs to none of the named sources.",
      lineFor(db, year, agentsCash, { categoryName: "Other Income" }),
    ),
    (() => {
      const inbound = lineFor(db, year, agentsCash, { categoryName: "Pass-through" });
      const outbound = lineFor(db, year, agentsCash, { categoryName: "Pass-through", direction: "out" });
      /*
       * 🔴 THE DESCRIPTION ASSERTED A LEG THE PAGE COULD NOT FIND. "…and money
       * held briefly for someone and handed back. Not income; both legs largely
       * cancel" printed unconditionally, including on /summary/2022 and
       * /summary/2023 — years with ONE and THREE inbound rows and not a single
       * outbound one. Pass-through money first went back out in 2025.
       *
       * The gate was already here, one line below, choosing whether to print the
       * "sent back over N rows" counter. The sentence reads from the same test,
       * so the page cannot describe a return leg it is about to say nothing
       * about.
       */
      const hasReturnLeg = outbound.rowCount > 0;
      return line(
        "passthrough",
        "Pass-through",
        "excluded",
        hasReturnLeg
          ? "Money that moves through your accounts on its way to someone else — your father's wires, and money held briefly for someone and handed back. Not income; both legs largely cancel."
          : `Money that moves through your accounts on its way to someone else — your father's wires, and money held briefly for someone. Not income. Nothing went back out of these accounts in ${year}, so this year holds only the arriving leg.`,
        inbound,
        undefined,
        hasReturnLeg
          ? {
              counterCents: outbound.amountCents,
              // 🔴 "sent back over 1 rows" — a year with one return leg
              counterLabel: `sent back over ${outbound.rowCount} ${outbound.rowCount === 1 ? "row" : "rows"}`,
            }
          : undefined,
      );
    })(),
  ].filter((l): l is YearLineInput => l !== null);

  return {
    year,
    summary: yearSummary({ year, lines }),
    gambling: gamblingFor(db, yearSpendingWindow(db, year, today), agentsCash),
    moneyWeightedReturn: moneyWeightedReturnFor(db, year, today),
    disclaimer: SUMMARY_DISCLAIMER,
    availableYears: summaryYears(db),
  };
}
