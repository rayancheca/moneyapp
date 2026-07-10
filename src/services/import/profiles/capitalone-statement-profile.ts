import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";

/**
 * Real Capital One card statement PDFs (their download naming:
 * Statement_MMYYYY_<docid>.pdf). Everything differs from the generic
 * statement parser: the billing period prints as "May 15, 2026 - Jun 13,
 * 2026 | 30 days in Billing Cycle", activity dates carry NO year (inferred
 * from the period), payments print a spaced minus ("- $43.17"), and the
 * summary's "New Balance = -$140.59" coexists with an ambiguous payment-slip
 * line ("New Balance - $140.59") that must never be the sign source.
 */

const PROFILE_ID = "capitalone-statement-pdf";

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const LONG_DATE = "([A-Z][a-z]{2}) (\\d{1,2}), (\\d{4})";
const PERIOD_RE = new RegExp(`${LONG_DATE} - ${LONG_DATE} \\| \\d+ days in Billing Cycle`);
/** the "=" form is the Account Summary; the slip's "New Balance - $x" is ambiguous */
const NEW_BALANCE_RE = /New Balance = (- ?)?\$([\d,]+\.\d{2})/;
const PREVIOUS_BALANCE_RE = /Previous Balance (- ?)?\$([\d,]+\.\d{2})/;
const CARD_RE = /(?:ending in|#)\s?(\d{4})/;
const ROW_RE = /^([A-Z][a-z]{2}) (\d{1,2}) ([A-Z][a-z]{2}) (\d{1,2}) (.+?) (- ?)?\$([\d,]+\.\d{2})$/;

function toIso(year: number, monthNum: number, day: number): string {
  const iso = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${iso}`);
  return iso;
}

function signedCents(minus: string | undefined, digits: string): number {
  return (minus ? -1 : 1) * parseAmountToCents(`$${digits}`);
}

export interface CapitalOneParse {
  periodStart: string;
  periodEnd: string;
  /** printed convention: positive owed */
  previousBalanceCents: number;
  newBalanceCents: number;
  last4?: string;
  isVentureX: boolean;
  txns: CanonicalTxn[];
}

/** Pure text-level core, exported for unit tests. */
export function parseCapitalOneLines(texts: readonly string[]): CapitalOneParse {
  const all = texts.join(" ");
  if (!/Capital One|capitalone\.com/i.test(all)) {
    throw new ParseError(PROFILE_ID, "Not a Capital One statement");
  }

  const pm = PERIOD_RE.exec(all);
  if (!pm) throw new ParseError(PROFILE_ID, "No billing-cycle period found");
  const startMonth = MONTHS[pm[1]!];
  const endMonth = MONTHS[pm[4]!];
  if (!startMonth || !endMonth) throw new ParseError(PROFILE_ID, "Unknown month in period");
  const startYear = Number(pm[3]);
  const endYear = Number(pm[6]);
  const periodStart = toIso(startYear, startMonth, Number(pm[2]));
  const periodEnd = toIso(endYear, endMonth, Number(pm[5]));

  const prev = PREVIOUS_BALANCE_RE.exec(all);
  const next = NEW_BALANCE_RE.exec(all);
  if (!prev || !next) throw new ParseError(PROFILE_ID, "Missing printed balances");

  // activity dates carry no year: months at/after the cycle's start month
  // belong to the start year, earlier months wrapped into the end year
  const yearOf = (monthNum: number): number =>
    startYear === endYear ? startYear : monthNum >= startMonth ? startYear : endYear;

  const txns: CanonicalTxn[] = [];
  for (const text of texts) {
    const m = ROW_RE.exec(text);
    if (!m) continue;
    const transMonth = MONTHS[m[1]!];
    const postMonth = MONTHS[m[3]!];
    if (!transMonth || !postMonth) continue;
    // printed: charges positive, payments "- $x" → canonical flips both
    // (credit-card money-out is negative in the net-worth convention)
    const printed = signedCents(m[6], m[7]!);
    txns.push({
      transactedOn: toIso(yearOf(transMonth), transMonth, Number(m[2])),
      postedOn: toIso(yearOf(postMonth), postMonth, Number(m[4])),
      amountCents: -printed,
      rawDescription: m[5]!,
    });
  }
  if (txns.length === 0) throw new ParseError(PROFILE_ID, "No activity rows parsed");

  return {
    periodStart,
    periodEnd,
    previousBalanceCents: signedCents(prev[1], prev[2]!),
    newBalanceCents: signedCents(next[1], next[2]!),
    ...(CARD_RE.exec(all)?.[1] ? { last4: CARD_RE.exec(all)![1] } : {}),
    isVentureX: /Venture X/i.test(all),
    txns,
  };
}

export const capitalOneStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  // Capital One's own download naming, or the inbox convention after rename;
  // parse still verifies content loudly
  matches: (f) =>
    f.format === "pdf" &&
    (/^Statement_\d{6}_\d{4}\.pdf$/i.test(f.name) || /^capitalone-.*statement.*\.pdf$/i.test(f.name)),
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseCapitalOneLines(lines.map((l) => l.text));
    return [
      {
        accountHint: {
          institution: "Capital One",
          type: "credit",
          ...(parsed.last4 ? { last4: parsed.last4 } : {}),
          ...(parsed.isVentureX ? { name: "Venture X" } : {}),
        },
        txns: parsed.txns,
        period: {
          start: parsed.periodStart,
          end: parsed.periodEnd,
          // printed positive owed → net-worth negative
          beginCents: -parsed.previousBalanceCents,
          endCents: -parsed.newBalanceCents,
        },
      },
    ];
  },
};
