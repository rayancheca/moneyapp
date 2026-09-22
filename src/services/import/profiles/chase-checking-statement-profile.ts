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
/** the right-margin statement identifier Chase prints once per page */
const MARGIN_ID_RE = /^\d{20}$/;

/**
 * Drop the right-margin statement identifier.
 *
 * Chase prints a 20-digit identifier in the right margin of one line per page.
 * unpdf clusters text by BASELINE, not by column, so that identifier joins
 * whatever printed line happens to share its y — and the joined line then no
 * longer ends in the running balance. ROW_RE stops matching (the row is
 * dropped AND its whole text folds into the description of the row above),
 * BALANCE_RE stops matching, and a wrapped continuation carries the digits
 * into a description. When it lands on a blank baseline it becomes a line of
 * its own, which the fold then appends to whichever description is open.
 *
 * Measured over all 48 real Chase checking statements: 89 identifiers, every
 * one exactly 20 digits printed at x = 605.7, while the widest token in the
 * printed content column anywhere in the corpus sits at x = 535.4 — a 70pt
 * gap, and no other 20-digit token exists. The account number is 15 digits and
 * Zelle/ACH references are 10-12 characters, so removing a trailing 20-digit
 * token cannot reach printed content. The stripped remainder may be empty;
 * an empty line folds nothing and leaves the open description untouched.
 */
function stripMarginIdentifier(text: string): string {
  const cut = text.lastIndexOf(" ");
  const tail = cut === -1 ? text : text.slice(cut + 1);
  return MARGIN_ID_RE.test(tail) ? text.slice(0, Math.max(cut, 0)) : text;
}

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
export function parseChaseCheckingLines(printed: readonly string[]): ChaseCheckingParse {
  const texts = printed.map(stripMarginIdentifier);
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

/**
 * Chase checking and Chase card statements ship under the SAME download name
 * (<YYYYMMDD>-statements-<last4>-.pdf), so content is the only thing that can
 * separate them — see isChaseCardStatementText, whose CHECKING_MARKERS are the
 * mirror of these. The `*start*` clause is load-bearing: the bank-name line
 * alone also appears in the two Spending Reports. Measured over every PDF on
 * disk: 27/27 real Chase checking statements, 0 of the other 209.
 */
export function isChaseCheckingStatementText(text: string): boolean {
  return /JPMorgan Chase Bank, N\.A\./.test(text) && /\*start\*/.test(text);
}

export const chaseCheckingStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  /**
   * v2: the right-margin statement identifier is dropped before parsing (`stripMarginIdentifier`). Every file already
   * in the ledger was read without that rule, so the bump is what lets a file already in the ledger be read AGAIN at
   * all — a parser fix never reaches an already-imported file, and `ux_import_files_sha_parser` would skip an
   * unbumped re-import as a duplicate.
   *
   * What the parser fix buys, measured over the archive on disk (75 files, 48 unique statements): the drift between
   * the printed Beginning/Ending Balance and the rows between them goes from one file at −$33.99
   * (57eaf4fa39bd0797-20250312) to none, and the rows read go 2,649 → 2,650 — the 2025-02-28 +$33.99 Zelle deposit a
   * merged line had swallowed.
   *
   * ⚠️ What the bump does NOT do. `retiredReadsOf` is keyed on the file's sha256, so one drop re-reads exactly the
   * bytes dropped and nothing else in the archive. And Chase regenerates a statement's bytes on every download
   * (scripts/trial-import.ts), so a statement downloaded fresh arrives under a NEW sha: it is a new import, read at
   * v2 like any other, never a re-read. Its clean lines then dedupe against the rows already in the ledger, which
   * keep the words the old read gave them. No drop the owner would normally make corrects a row already stored.
   *
   * That +$33.99 never reaches the ledger from this parser either: it is already there from
   * Chase3522_Activity_20260710.CSV, whose `chase-deposit-csv` outranks a statement on the days it covers. Dropping
   * this very statement's archived byte-copy at v2 is 1 parsed, 0 inserted, 58 skippedOwned, $0.00 moved.
   *
   * The 13 live rows that still carry the margin digits are corrected by ONE run and only that one: re-dropping the
   * archived byte-copies the ledger itself holds, data/statements/chase-checking-3522 (76 files, the 75 the ledger
   * records at v1). Measured on a python read-only copy of the real ledger, 2026-09-22 — 75 parsed, 1,536 inserted,
   * 0 quarantined, active rows 10,320 → 10,320, net worth $110,914.77 → $110,914.77, rows carrying a 20-digit run
   * 55 → 42 — 16 ledger lines move: those 13 descriptions, and three Fordham rows the merchant map re-derives
   * Financial Aid → Education. Nothing else, and nothing crosses to another charge (`claimCarry`). That run is the
   * owner's call to make and a step of its own, behind its own restore point — `pnpm import-statements
   * data/statements/chase-checking-3522 --confirm`, after `pnpm trial-import` on the same folder — never a side
   * effect of an upload.
   */
  version: 2,
  matches: (f) => f.format === "pdf",
  matchesContent: isChaseCheckingStatementText,
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
