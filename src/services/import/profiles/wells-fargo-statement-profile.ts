import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines, type Line } from "./pdf-profile";

/**
 * Real Wells Fargo Everyday Checking statement PDFs.
 *
 * ## Why this could not reuse any existing profile
 *
 * Every other deposit statement here prints a SIGN. Chase writes `- 2.08`,
 * SoFi writes a minus, the OFX carries one. Wells Fargo writes none: the
 * transaction table has two money columns, `Deposits/Additions` and
 * `Withdrawals/Subtractions`, and **which column a number is printed in is the
 * only thing that says whether money came in or went out**. Parsed as text the
 * two are identical — `7.00` is `7.00` — so a line-based parser cannot get the
 * sign right even in principle, and would silently record every purchase as
 * income.
 *
 * ⛔ So this profile reads x positions, and it reads the BOUNDARIES off the
 * printed column header rather than hardcoding them:
 *
 *     Check@124 | Deposits/@404 | Withdrawals/@458 | Ending daily@525
 *
 * Amounts are right-aligned inside their column, so a token's left edge always
 * lands before the NEXT column's header. Measured across all 39 rows of the
 * 2026-08-25 statement: deposits 406–421, withdrawals 474–489, balances
 * 538–548 — every one comfortably inside its band, with ~36pt of margin either
 * side. Hardcoding 458 and 525 would work today and break the first time Wells
 * Fargo reflows the table; reading the header means the parser moves with it.
 *
 * ## The third column is not a transaction
 *
 * `Ending daily balance` prints only on the LAST row of each day, so a row may
 * carry one money token or two. The second is a running balance and must never
 * be mistaken for an amount — which is exactly what a "last two money tokens
 * are amount and balance" rule (the shape the generic PDF profile uses) would
 * do to the 30 rows here that have no balance printed at all.
 *
 * ## Dates carry no year
 *
 * Activity prints `M/D`. The year is the one that places (month, day) at or
 * before the period close, so a December row on a Dec→Jan statement resolves
 * backwards — the same rule the Chase checking profile uses, for the same
 * reason.
 *
 * ## Not checksummed against the printed totals, deliberately
 *
 * Rows that do not sum to the printed change must surface as a quarantined gap
 * through reconciliation, not as a parse failure — the trust layer is where
 * that belongs (see pdf-profile's header). This parser reports what is printed
 * and lets `reconcileAccounts` be the arbiter.
 */

const PROFILE_ID = "wells-fargo-checking-statement-pdf";

const MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

/** the statement date, printed beside the page number on every page */
const STATEMENT_DATE_RE = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/;
const PAGE_RE = /^Page \d+ of \d+$/;
const BEGIN_RE = /^Beginning balance on (\d{1,2})\/(\d{1,2})$/;
const END_RE = /^Ending balance on (\d{1,2})\/(\d{1,2})$/;
const ACCOUNT_RE = /^(\d{6,})\b/;
const MONEY_RE = /^[\d,]+\.\d{2}$/;
const DOLLAR_RE = /^-?\$[\d,]+\.\d{2}$/;
const DAY_RE = /^(\d{1,2})\/(\d{1,2})$/;

function toIso(year: number, month: number, day: number): string {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${iso}`);
  return iso;
}

/** Where the two right-hand money columns begin, in PDF x units. */
export interface MoneyColumns {
  withdrawalsX: number;
  balanceX: number;
}

/**
 * Read the column boundaries off the transaction table's own header.
 *
 * The header wraps onto two lines (`Check | Deposits/ | Withdrawals/ | Ending
 * daily` then `Date | Number | Description | Additions | Subtractions |
 * balance`); the first carries all three positions we need.
 */
export function findMoneyColumns(lines: readonly Line[]): MoneyColumns | null {
  for (const line of lines) {
    const withdrawals = line.tokens.find((t) => t.str === "Withdrawals/");
    const balance = line.tokens.find((t) => t.str === "Ending daily");
    const deposits = line.tokens.find((t) => t.str === "Deposits/");
    if (!withdrawals || !balance || !deposits) continue;
    // a header whose columns are out of order is a mis-clustered line, not a table
    if (!(deposits.x < withdrawals.x && withdrawals.x < balance.x)) continue;
    return { withdrawalsX: withdrawals.x, balanceX: balance.x };
  }
  return null;
}

/** Which column a money token was printed in — the only thing that carries the sign. */
export function columnOf(x: number, cols: MoneyColumns): "deposit" | "withdrawal" | "balance" {
  if (x >= cols.balanceX) return "balance";
  if (x >= cols.withdrawalsX) return "withdrawal";
  return "deposit";
}

export interface WellsFargoParse {
  periodStart: string;
  periodEnd: string;
  beginningBalanceCents: number;
  endingBalanceCents: number;
  last4?: string;
  txns: CanonicalTxn[];
}

/**
 * A continuation line folded into the row above it: a wrapped description tail
 * (`S586211836828418 Card 7158`, `Rayan Karim Checa`).
 *
 * ⛔ The `Totals` row is the hard stop. It prints `$6,447.92 $4,051.25` in the
 * same two columns as the activity above it, so a parser that kept folding past
 * it would append the statement's own totals to the last transaction's
 * description — and, worse, a parser that kept READING past it would record
 * them as two more transactions worth $10,499.17.
 */
function isTableEnd(text: string): boolean {
  return /^Totals\b/.test(text) || /^Monthly service fee summary/.test(text) || /^Fee period:/.test(text);
}

/** Page furniture that appears between activity rows and must not be folded in. */
function isPageChrome(text: string, tokens: readonly { str: string }[]): boolean {
  if (PAGE_RE.test(text)) return true;
  if (/^Transaction [Hh]istory/.test(text)) return true;
  if (/^Account number:/.test(text)) return true;
  if (/^(Check|Date)\b/.test(text) && tokens.length >= 3) return true;
  // "August 25, 2026 Page 3 of 6"
  if (tokens[0] !== undefined && STATEMENT_DATE_RE.test(`${tokens[0].str}`)) return true;
  if (/^(The Ending Daily Balance|Totals)\b/.test(text)) return true;
  return false;
}

/** Pure positional core, exported for unit tests. */
export function parseWellsFargoLines(lines: readonly Line[]): WellsFargoParse {
  const cols = findMoneyColumns(lines);
  if (!cols) {
    throw new ParseError(PROFILE_ID, "No 'Deposits/ Withdrawals/ Ending daily' column header — cannot tell an inflow from an outflow");
  }

  // the statement date is the period close; it prints beside every page number
  const dateLine = lines.find((l) => {
    const first = l.tokens[0]?.str ?? "";
    return STATEMENT_DATE_RE.test(first) && l.tokens.some((t) => PAGE_RE.test(t.str));
  });
  const dm = dateLine ? STATEMENT_DATE_RE.exec(dateLine.tokens[0]!.str) : null;
  if (!dm) throw new ParseError(PROFILE_ID, "No 'Month D, YYYY' statement date beside a page number");
  const closeYear = Number(dm[3]);
  const closeMonth = MONTHS[dm[1]!];
  if (!closeMonth) throw new ParseError(PROFILE_ID, `Unknown month ${dm[1]}`);
  const statementDate = toIso(closeYear, closeMonth, Number(dm[2]));

  const findLabelled = (re: RegExp): { m: RegExpExecArray; line: Line } | null => {
    for (const line of lines) {
      // the label is one token, the amount another — match on the label token
      const label = line.tokens.find((t) => re.test(t.str));
      if (!label) continue;
      return { m: re.exec(label.str)!, line };
    }
    return null;
  };

  const begin = findLabelled(BEGIN_RE);
  const end = findLabelled(END_RE);
  if (!begin || !end) throw new ParseError(PROFILE_ID, "Missing printed 'Beginning balance on M/D' / 'Ending balance on M/D'");

  const amountOn = (line: Line): number => {
    const token = line.tokens.find((t) => DOLLAR_RE.test(t.str));
    if (!token) throw new ParseError(PROFILE_ID, `No balance amount on "${line.text}"`);
    return parseAmountToCents(token.str);
  };

  /**
   * Every activity date and both balance dates sit at or before the close, so
   * the year is the close's — unless that would overshoot, which happens only
   * on a statement that spans New Year.
   */
  const inferYear = (month: number, day: number): number => {
    const atClose = `${closeYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return atClose <= statementDate ? closeYear : closeYear - 1;
  };
  const isoOf = (month: number, day: number): string => toIso(inferYear(month, day), month, day);

  const periodStart = isoOf(Number(begin.m[1]), Number(begin.m[2]));
  const periodEnd = isoOf(Number(end.m[1]), Number(end.m[2]));

  const acctLine = lines.find((l) => l.text.startsWith("Account number:"));
  const acctToken = acctLine?.tokens.map((t) => ACCOUNT_RE.exec(t.str)).find((m) => m !== null);
  const last4 = acctToken ? acctToken[1]!.slice(-4) : undefined;

  const txns: CanonicalTxn[] = [];
  let inTable = false;
  let foldable = false;
  for (const line of lines) {
    if (findMoneyColumns([line]) !== null) {
      inTable = true;
      foldable = false;
      continue;
    }
    if (!inTable) continue;
    if (isTableEnd(line.text)) {
      inTable = false;
      foldable = false;
      continue;
    }

    const first = line.tokens[0];
    const dayMatch = first ? DAY_RE.exec(first.str) : null;
    if (dayMatch) {
      const money = line.tokens.filter((t) => MONEY_RE.test(t.str));
      /**
       * The amount is the money token in a TRANSACTION column. A row prints at
       * most one — the second, when present, is the day's ending balance, and a
       * `.at(-1)` rule would read it as the amount on the 9 rows that carry it.
       */
      const amountToken = money.find((t) => columnOf(t.x, cols) !== "balance");
      if (!amountToken) {
        // a dated line with no transaction amount is not a row (a wrapped
        // description that happens to begin with a date, or a balance-only line)
        foldable = false;
        continue;
      }
      const cents = parseAmountToCents(amountToken.str);
      const outflow = columnOf(amountToken.x, cols) === "withdrawal";
      const description = line.tokens
        .filter((t) => t !== first && !MONEY_RE.test(t.str))
        .map((t) => t.str)
        .join(" ")
        .trim();
      txns.push({
        postedOn: isoOf(Number(dayMatch[1]), Number(dayMatch[2])),
        amountCents: outflow ? -cents : cents,
        rawDescription: description,
      });
      foldable = true;
      continue;
    }

    if (foldable && !isPageChrome(line.text, line.tokens)) {
      const last = txns[txns.length - 1]!;
      txns[txns.length - 1] = { ...last, rawDescription: `${last.rawDescription} ${line.text}`.trim() };
      continue;
    }
    // page chrome interrupts a row's continuation but does not end the table —
    // the transaction history runs across pages 2 and 3
    foldable = false;
  }

  return {
    periodStart,
    periodEnd,
    beginningBalanceCents: amountOn(begin.line),
    endingBalanceCents: amountOn(end.line),
    ...(last4 ? { last4 } : {}),
    txns,
  };
}

/**
 * Wells Fargo statements are unmistakable in their own text, and none of the
 * other institutions here print these strings. The account-type line keeps this
 * from claiming a Wells Fargo credit-card or savings statement it has never
 * been shown and cannot be assumed to parse.
 */
export function isWellsFargoCheckingStatementText(text: string): boolean {
  if (!/Wells Fargo Bank, N\.A\./.test(text) && !/1-800-TO-WELLS/.test(text)) return false;
  return /Everyday Checking/.test(text) && /Transaction history/.test(text);
}

export const wellsFargoCheckingStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  matches: (f) => f.format === "pdf",
  matchesContent: isWellsFargoCheckingStatementText,
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseWellsFargoLines(lines);
    return [
      {
        accountHint: {
          institution: "Wells Fargo",
          type: "checking",
          name: "Wells Fargo Everyday Checking",
          ...(parsed.last4 ? { last4: parsed.last4 } : {}),
        },
        txns: parsed.txns,
        period: {
          start: parsed.periodStart,
          end: parsed.periodEnd,
          beginCents: parsed.beginningBalanceCents,
          endCents: parsed.endingBalanceCents,
        },
      },
    ];
  },
};
