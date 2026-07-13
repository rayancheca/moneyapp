import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";

/**
 * Real Chase College Checking statement PDFs (their download naming:
 * <YYYYMMDD>-statements-<last4>-.pdf). The generic statement parser only knows
 * the synthetic "Statement Period:" header; real Chase differs on every axis:
 * the period prints as "August 25, 2022 through September 13, 2022", activity
 * dates carry NO year (inferred from the period, with a Dec→Jan boundary),
 * negatives sometimes print a space after the minus ("- 2.08"), and a trailing
 * card-number token can wrap onto the next line. Deposit amounts are already
 * net-worth-signed (deposits +, withdrawals −), matching the Chase deposit CSV.
 */

const PROFILE_ID = "chase-checking-statement-pdf";

const MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

const PERIOD_RE = /^([A-Z][a-z]+) (\d{1,2}), (\d{4}) through ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/;
const ACCOUNT_RE = /^Account Number:\s*(\d+)$/;
/** MM/DD <desc> <amount> <running-balance> — amount/balance are the last two money tokens */
const ROW_RE = /^(\d{2})\/(\d{2}) (.+?) (-\s*)?([\d,]+\.\d{2}) (-\s*)?([\d,]+\.\d{2})$/;
const BALANCE_RE = /^(?:Beginning|Ending) Balance (-?)\$([\d,]+\.\d{2})$/;

function toIso(year: number, monthNum: number, day: number): string {
  const iso = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${iso}`);
  return iso;
}

/** A continuation line to fold into the prior row (a wrapped card number or
 *  description tail): plain text, never a boundary marker or a balance label. */
function isFoldCandidate(text: string): boolean {
  if (text.includes("$")) return false;
  if (text.startsWith("*")) return false;
  if (PERIOD_RE.test(text)) return false;
  return !/^(Beginning Balance|Ending Balance|Page \d|TRANSACTION DETAIL|DATE DESCRIPTION|Account Number:|\(continued\))/i.test(
    text,
  );
}

export interface ChaseCheckingParse {
  periodStart: string;
  periodEnd: string;
  /** deposit account kind — checking unless the summary says SAVINGS */
  accountType: "checking" | "savings";
  /** net-worth-signed (positive assets) */
  beginningBalanceCents: number;
  endingBalanceCents: number;
  last4?: string;
  txns: CanonicalTxn[];
}

/** Pure text-level core, exported for unit tests. */
export function parseChaseCheckingLines(texts: readonly string[]): ChaseCheckingParse {
  const periodLine = texts.find((t) => PERIOD_RE.test(t));
  const pm = periodLine ? PERIOD_RE.exec(periodLine) : null;
  if (!pm) throw new ParseError(PROFILE_ID, "No 'Month D, YYYY through Month D, YYYY' period found");
  const startMonth = MONTHS[pm[1]!];
  const endMonth = MONTHS[pm[4]!];
  if (!startMonth || !endMonth) throw new ParseError(PROFILE_ID, "Unknown month in period");
  const startYear = Number(pm[3]);
  const endYear = Number(pm[6]);
  const periodStart = toIso(startYear, startMonth, Number(pm[2]));
  const periodEnd = toIso(endYear, endMonth, Number(pm[5]));

  const acctLine = texts.find((t) => ACCOUNT_RE.test(t));
  const am = acctLine ? ACCOUNT_RE.exec(acctLine) : null;
  if (!am) throw new ParseError(PROFILE_ID, "No 'Account Number:' line — not a Chase checking statement");
  const acctNumber = am[1]!;
  const last4 = acctNumber.slice(-4);

  const beginMatch = texts.find((t) => t.startsWith("Beginning Balance") && BALANCE_RE.test(t));
  const endMatch = texts.find((t) => t.startsWith("Ending Balance") && BALANCE_RE.test(t));
  if (!beginMatch || !endMatch) throw new ParseError(PROFILE_ID, "Missing printed Beginning/Ending Balance");
  const signedBalance = (line: string): number => {
    const b = BALANCE_RE.exec(line)!;
    const cents = parseAmountToCents(`$${b[2]}`);
    return b[1] === "-" && cents !== 0 ? -cents : cents;
  };

  // activity rows print the POST date as MM/DD with no year; every row is
  // within the billing period, so its year is the one that places (month, day)
  // at or before the period close — endYear normally, endYear−1 when that month
  // would overshoot periodEnd (a December row on a Dec→Jan statement).
  const inferYear = (mm: number, dd: number): number => {
    const atEnd = `${endYear}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return atEnd <= periodEnd ? endYear : endYear - 1;
  };

  const txns: CanonicalTxn[] = [];
  // fold a wrapped continuation ONLY when it immediately follows a row (or a
  // prior fold) — never the summary, the daily-balance/footer text, or page
  // chrome that trails the transaction-detail block
  let foldable = false;
  for (const text of texts) {
    const row = ROW_RE.exec(text);
    if (row) {
      const month = Number(row[1]);
      const day = Number(row[2]);
      const amount = parseAmountToCents(row[5]!); // "- 2.08" is captured sign-first
      const negative = row[4] !== undefined;
      txns.push({
        postedOn: toIso(inferYear(month, day), month, day),
        amountCents: negative ? -amount : amount,
        rawDescription: row[3]!.trim(),
      });
      foldable = true;
      continue;
    }
    if (foldable && isFoldCandidate(text)) {
      const last = txns[txns.length - 1]!;
      txns[txns.length - 1] = { ...last, rawDescription: `${last.rawDescription} ${text}`.trim() };
      continue;
    }
    foldable = false;
  }

  return {
    periodStart,
    periodEnd,
    accountType: texts.some((t) => /SAVINGS SUMMARY/i.test(t)) ? "savings" : "checking",
    beginningBalanceCents: signedBalance(beginMatch),
    endingBalanceCents: signedBalance(endMatch),
    last4,
    txns,
  };
}

export const chaseCheckingStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  // Chase's date-prefixed deposit-statement naming; parse verifies content loudly
  matches: (f) => f.format === "pdf" && /^\d{8}-statements?-\d{4}[-_]?.*\.pdf$/i.test(f.name),
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseChaseCheckingLines(lines.map((l) => l.text));
    return [
      {
        accountHint: {
          institution: "Chase",
          type: parsed.accountType,
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
