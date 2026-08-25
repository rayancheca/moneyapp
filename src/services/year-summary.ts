import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { importFiles } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import {
  moneyWeightedReturn,
  type MoneyWeightedReturn,
  type ReturnBoundary,
} from "@/lib/money-weighted-return";
import type { CashFlow } from "@/lib/xirr";
import { yearSummary, type YearLineInput, type YearSummary } from "@/lib/year-summary";
import { portfolioSeries, realizedSalesByDay } from "./portfolio";

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

/** Income-side rows for one category name, in one year, with their documents. */
function lineFor(
  db: AppDatabase,
  year: number,
  opts: {
    categoryName: string;
    /** restrict to one account name */
    accountName?: string;
    /** SQL LIKE against the raw descriptor, or its negation */
    descriptorLike?: string;
    descriptorNotLike?: string;
    /** money IN by default; "out" measures the returning leg as a magnitude */
    direction?: "in" | "out";
  },
): RawLine {
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
  if (opts.descriptorLike) {
    where.push(sql`upper(${transactions.rawDescription}) LIKE ${opts.descriptorLike}`);
  }
  if (opts.descriptorNotLike) {
    where.push(sql`upper(${transactions.rawDescription}) NOT LIKE ${opts.descriptorNotLike}`);
  }

  const rows = db
    .select({
      amountCents: transactions.amountCents,
      importFileId: transactions.importFileId,
      fileName: importFiles.fileName,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(importFiles, eq(importFiles.id, transactions.importFileId))
    .where(and(...where))
    .all();

  const signed = rows.reduce((t, r) => t + r.amountCents, 0);
  return {
    // always a positive magnitude — the section headings say the direction
    amountCents: opts.direction === "out" ? -signed : signed,
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

function gamblingFor(db: AppDatabase, year: number): YearGambling {
  const { from, to } = yearBounds(year);
  const parent = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, "Gambling"))
    .all()
    .map((c) => c.id);
  if (parent.length === 0) return { wonCents: 0, lostCents: 0, netCents: 0, rowCount: 0 };

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
      ),
    )
    .all();

  const wonCents = rows.filter((r) => r.amountCents > 0).reduce((t, r) => t + r.amountCents, 0);
  const lostCents = rows.filter((r) => r.amountCents < 0).reduce((t, r) => t - r.amountCents, 0);
  return { wonCents, lostCents, netCents: wonCents - lostCents, rowCount: rows.length };
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

  /*
   * External flows only: money crossing INTO or OUT OF the investment side,
   * taken from the CASH leg (a checking/savings row categorized Investment
   * Contribution). The investment leg's mirror would double every movement.
   */
  const contributions = db
    .select({ day: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, closeDay),
        eq(categories.name, "Investment Contribution"),
        inArray(accounts.type, ["checking", "savings"]),
      ),
    )
    .orderBy(asc(transactions.postedOn))
    .all();

  const byDay = new Map<string, number>();
  for (const c of contributions) {
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

  const lines = [
    line(
      "fordham",
      "Fordham work-study wages",
      "earned",
      "Biweekly ACH direct deposit described FORDHAM UNIVERSI PAYROLL — the first term in your own definition of earnings.",
      lineFor(db, year, { categoryName: "Salary", descriptorLike: FORDHAM_DESCRIPTOR }),
    ),
    line(
      "cash-job",
      "Cash job",
      "earned",
      "Salary rows that are not Fordham payroll. Work-study ended 2026-05-13 and these deposits are the job that replaced it.",
      lineFor(db, year, { categoryName: "Salary", descriptorNotLike: FORDHAM_DESCRIPTOR }),
      "Deposited irregularly, so a calendar year captures what reached the bank rather than what was worked.",
    ),
    line(
      "knack",
      "Knack tutoring",
      "earned",
      "Payouts described KNACK PAYOUT — the second term in your definition of earnings.",
      lineFor(db, year, { categoryName: "Tutoring" }),
    ),
    line(
      "sofi-interest",
      "SoFi savings interest",
      "earned",
      "Interest credited to the SoFi savings account — the third term in your definition of earnings.",
      lineFor(db, year, { categoryName: "Interest", accountName: "SoFi Savings" }),
    ),
    line(
      "dividends",
      "Dividends",
      "investment",
      "Dividends credited inside the brokerage.",
      lineFor(db, year, { categoryName: "Dividends" }),
    ),
    line(
      "brokerage-interest",
      "Brokerage cash interest",
      "investment",
      "Interest paid on uninvested brokerage cash. Separated from SoFi savings interest, which your rule counts as earnings.",
      lineFor(db, year, { categoryName: "Interest", accountName: "Robinhood Cash" }),
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
      lineFor(db, year, { categoryName: "Financial Aid" }),
    ),
    line(
      "reimbursements",
      "Refunds and reimbursements",
      "notEarned",
      "Money coming back to you, not money you were paid.",
      lineFor(db, year, { categoryName: "Refunds & Reimbursements" }),
    ),
    line(
      "other-income",
      "Other income",
      "notEarned",
      "Income-kind rows that fit none of the named sources above.",
      lineFor(db, year, { categoryName: "Other Income" }),
    ),
    (() => {
      const inbound = lineFor(db, year, { categoryName: "Family pass-through" });
      const outbound = lineFor(db, year, { categoryName: "Family pass-through", direction: "out" });
      return line(
        "family",
        "Family pass-through",
        "excluded",
        "Money your father sends, often wired back. A pass-through, not income — both legs largely cancel.",
        inbound,
        undefined,
        outbound.rowCount === 0
          ? undefined
          : { counterCents: outbound.amountCents, counterLabel: `sent back over ${outbound.rowCount} rows` },
      );
    })(),
  ].filter((l): l is YearLineInput => l !== null);

  return {
    year,
    summary: yearSummary({ year, lines }),
    gambling: gamblingFor(db, year),
    moneyWeightedReturn: moneyWeightedReturnFor(db, year, today),
    disclaimer: SUMMARY_DISCLAIMER,
    availableYears: summaryYears(db),
  };
}
