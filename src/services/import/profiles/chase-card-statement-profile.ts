import { isValidIsoDate, toEpochDay } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";

/**
 * Real Chase credit-card statement PDFs (Sapphire and friends). They share a
 * download name with the checking statements — <YYYYMMDD>-statements-<last4>-.pdf
 * — but nothing else, which is why routing here is decided by CONTENT:
 *
 *   checking                         card
 *   "May 13, 2026 through June 10"   "Opening/Closing Date 06/03/26 - 07/02/26"
 *   "Beginning/Ending Balance"       "Previous Balance" / "New Balance"
 *   "Account Number: 00000088906..." "Account Number: XXXX XXXX XXXX 9805"
 *   amounts already net-worth-signed amounts printed CARD-side
 *   a running-balance column         no balance column
 *
 * Two inversions matter. The statement prints a PURCHASE as positive and a
 * PAYMENT as negative, which is the mirror of how this app stores a liability
 * (a purchase makes net worth go down). And "New Balance -$70.89" means the
 * card owes the customer, i.e. net worth is +$70.89. Both are negated on the
 * way in, so the DB stays uniformly net-worth-signed.
 *
 * Rows are classified by the SIGN THEY PRINT, not by which section they sit
 * under. That was measured rather than assumed: across both statements the
 * positive rows sum exactly to the printed Purchases total and the negative
 * rows to Payments and Other Credits, with zero crossover — so a page break in
 * the middle of a section (these statements have one) cannot strand a row.
 */

const PROFILE_ID = "chase-card-statement-pdf";

/** 2-digit years: correct for 2000-2099, which the reconcile check backstops. */
const CENTURY = 2000;

/**
 * Markers proven to appear in every Chase CARD statement and in none of the 29
 * Chase CHECKING statements on hand. Three are required so that one Chase
 * template tweak cannot silently flip routing.
 */
const CARD_MARKERS = [
  /Opening\/Closing Date/,
  /Merchant\s+Name or Transaction Description/,
  /PAYMENTS AND OTHER CREDITS/,
  /Credit Access Line/,
  /Account Number:\s*X{4}\s+X{4}\s+X{4}\s+\d{4}/,
];
const CHECKING_MARKERS = [/CHECKING SUMMARY/, /\*start\*transaction detail/, /JPMorgan Chase Bank, N\.A\./];

/** Whether extracted statement text is a Chase card statement (not a checking one). */
export function isChaseCardStatementText(text: string): boolean {
  if (CHECKING_MARKERS.some((re) => re.test(text))) return false;
  return CARD_MARKERS.filter((re) => re.test(text)).length >= 3;
}

const PERIOD_RE = /^Opening\/Closing Date\s+(\d{2})\/(\d{2})\/(\d{2})\s*-\s*(\d{2})\/(\d{2})\/(\d{2})$/;
const MASK_RE = /^Account Number:\s*X{4}\s+X{4}\s+X{4}\s+(\d{4})$/;
/** The sign is its own token in the source; pdf.js merges it inconsistently. */
const PREVIOUS_RE = /^Previous Balance\s+([+-]?)\s*\$([\d,]+\.\d{2})$/;
const NEW_RE = /^New Balance\s+([+-]?)\s*\$([\d,]+\.\d{2})$/;
const CREDITS_RE = /^Payment,\s*Credits\s+([+-]?)\s*\$([\d,]+\.\d{2})$/;
const PURCHASES_RE = /^Purchases\s+([+-]?)\s*\$([\d,]+\.\d{2})$/;
// Chase prints fees and interest as their OWN summary sections, but lists them
// as ordinary activity rows. So a statement carrying the $95 annual fee has
// `Purchases +$5,371.57` and `Fees Charged +$95.00`, while the rows sum to
// $5,466.57 — and the section check below rejected the whole statement over a
// difference that was never an error. Both are read so the check can add them
// back rather than be loosened.
const FEES_RE = /^Fees Charged\s+([+-]?)\s*\$([\d,]+\.\d{2})$/;
const INTEREST_RE = /^Interest Charged\s+([+-]?)\s*\$([\d,]+\.\d{2})$/;
/**
 * MM/DD <description> <amount>; (?!\/) rejects a full MM/DD/YY date line.
 *
 * The integer part is OPTIONAL because Chase drops the leading zero on
 * sub-dollar amounts — it prints `.78`, never `0.78`. Requiring a digit there
 * silently dropped 71 real charges worth $32.95 across the owner's 18 Sapphire
 * statements, and six of those statements then failed to reconcile by exactly
 * the amount that had been dropped. The rows were never malformed; the reader
 * refused to see them.
 *
 * `(?:\d[\d,]*)?` rather than `[\d,]*`: both accept the same real amounts, but
 * the loose form also admits a comma-only integer part (`,.21`), which reaches
 * parseAmountToCents and throws MoneyParseError — escaping this profile as an
 * unexpected error type instead of a clean ParseError.
 *
 * This widens what the parser can READ. It does not touch either check below,
 * and must not: those are what prove the recovered rows are real.
 */
const ROW_RE = /^(\d{2})\/(\d{2})(?!\/)\s+(.+?)\s+(-?)((?:\d[\d,]*)?\.\d{2})$/;
/** Everything past the year-to-date block is summary, never activity. */
const TERMINATOR_RE = /Totals\s+Year-to-Date/;

function signed(sign: string, amount: string): number {
  const cents = parseAmountToCents(amount);
  return sign === "-" ? -cents : cents;
}

function toIso(year: number, month: number, day: number): string {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${iso}`);
  return iso;
}

/**
 * Activity rows print MM/DD with no year. A statement can straddle December,
 * and a row can fall a day or two OUTSIDE its own period, so this picks
 * whichever candidate year lands the date nearest the period rather than
 * assuming the row is inside it.
 */
function inferYear(month: number, day: number, startIso: string, endIso: string): number {
  const mid = (toEpochDay(startIso) + toEpochDay(endIso)) / 2;
  const years = [Number(startIso.slice(0, 4)), Number(endIso.slice(0, 4))];
  let best = years[0]!;
  let bestDistance = Infinity;
  for (const year of years) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!isValidIsoDate(iso)) continue; // e.g. 02/29 in the non-leap candidate
    const distance = Math.abs(toEpochDay(iso) - mid);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = year;
    }
  }
  return best;
}

export interface ChaseCardParse {
  periodStart: string;
  periodEnd: string;
  last4?: string;
  /** net-worth-signed: what the card contributes to net worth (owed = negative) */
  beginningBalanceCents: number;
  endingBalanceCents: number;
  /** net-worth-signed, so a purchase is negative */
  txns: CanonicalTxn[];
}

/** Pure text-level core, exported for unit tests. */
export function parseChaseCardLines(texts: readonly string[]): ChaseCardParse {
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  let last4: string | undefined;
  let previousPrinted: number | undefined;
  let newPrinted: number | undefined;
  let creditsPrinted: number | undefined;
  let purchasesPrinted: number | undefined;
  let feesPrinted: number | undefined;
  let interestPrinted: number | undefined;

  for (const raw of texts) {
    const text = raw.trim();
    const period = PERIOD_RE.exec(text);
    if (period) {
      const [, m1, d1, y1, m2, d2, y2] = period;
      periodStart = toIso(CENTURY + Number(y1), Number(m1), Number(d1));
      periodEnd = toIso(CENTURY + Number(y2), Number(m2), Number(d2));
      continue;
    }
    const mask = MASK_RE.exec(text);
    if (mask) {
      last4 = mask[1];
      continue;
    }
    const previous = PREVIOUS_RE.exec(text);
    if (previous && previousPrinted === undefined) {
      previousPrinted = signed(previous[1]!, previous[2]!);
      continue;
    }
    const next = NEW_RE.exec(text);
    if (next && newPrinted === undefined) {
      newPrinted = signed(next[1]!, next[2]!);
      continue;
    }
    const credits = CREDITS_RE.exec(text);
    if (credits && creditsPrinted === undefined) {
      creditsPrinted = signed(credits[1]!, credits[2]!);
      continue;
    }
    const purchases = PURCHASES_RE.exec(text);
    if (purchases && purchasesPrinted === undefined) {
      purchasesPrinted = signed(purchases[1]!, purchases[2]!);
      continue;
    }
    const fees = FEES_RE.exec(text);
    if (fees && feesPrinted === undefined) {
      feesPrinted = signed(fees[1]!, fees[2]!);
      continue;
    }
    const interest = INTEREST_RE.exec(text);
    if (interest && interestPrinted === undefined) interestPrinted = signed(interest[1]!, interest[2]!);
  }

  if (!periodStart || !periodEnd) {
    throw new ParseError(PROFILE_ID, "No 'Opening/Closing Date MM/DD/YY - MM/DD/YY' period found");
  }
  if (previousPrinted === undefined) throw new ParseError(PROFILE_ID, "No 'Previous Balance' found");
  if (newPrinted === undefined) throw new ParseError(PROFILE_ID, "No 'New Balance' found");

  const txns: CanonicalTxn[] = [];
  let printedSum = 0;
  for (const raw of texts) {
    const text = raw.trim();
    if (TERMINATOR_RE.test(text)) break;
    const row = ROW_RE.exec(text);
    if (!row) continue;
    const [, mm, dd, description, sign, amount] = row;
    const month = Number(mm);
    const day = Number(dd);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const printed = signed(sign!, amount!);
    printedSum += printed;
    const iso = toIso(inferYear(month, day, periodStart, periodEnd), month, day);
    txns.push({
      postedOn: iso,
      // the card statement prints ONE date and it is the transaction date;
      // recording it as such is what lets dedupe match a post-dated row
      transactedOn: iso,
      amountCents: -printed, // card-side sign -> net-worth sign
      rawDescription: description!.replace(/\s+/g, " ").trim(),
    });
  }

  if (txns.length === 0) throw new ParseError(PROFILE_ID, "No activity rows found");

  // The statement must reconcile: previous + activity = new, to the cent. This
  // is also what backstops the 2-digit-year expansion and the row regex — a
  // dropped or phantom row shows up here rather than as a silent balance drift.
  const expected = previousPrinted + printedSum;
  if (expected !== newPrinted) {
    throw new ParseError(
      PROFILE_ID,
      `Statement does not reconcile: previous ${previousPrinted} + activity ${printedSum} = ${expected}, printed New Balance ${newPrinted}`,
    );
  }
  // Second, independent check: the rows split by their own printed sign must
  // reproduce the two printed section totals. Compared as magnitudes because
  // Chase prints the credits total with a leading minus that pdf.js sometimes
  // merges into the amount token and sometimes leaves as its own.
  if (creditsPrinted !== undefined && purchasesPrinted !== undefined) {
    const credits = txns.reduce((sum, t) => (t.amountCents > 0 ? sum + t.amountCents : sum), 0);
    const purchases = txns.reduce((sum, t) => (t.amountCents < 0 ? sum - t.amountCents : sum), 0);
    // Fees and interest are charged to the card exactly like a purchase and
    // appear in the row list, but Chase totals them in their own sections. The
    // comparison therefore adds them back rather than dropping the check: a
    // dropped or phantom row must still be caught to the cent.
    const chargesPrinted =
      Math.abs(purchasesPrinted) + Math.abs(feesPrinted ?? 0) + Math.abs(interestPrinted ?? 0);
    if (credits !== Math.abs(creditsPrinted) || purchases !== chargesPrinted) {
      throw new ParseError(
        PROFILE_ID,
        `Section totals disagree: credits ${credits} vs printed ${Math.abs(creditsPrinted)}, charges ${purchases} vs printed ${chargesPrinted} (purchases ${Math.abs(purchasesPrinted)} + fees ${Math.abs(feesPrinted ?? 0)} + interest ${Math.abs(interestPrinted ?? 0)})`,
      );
    }
  }

  return {
    periodStart,
    periodEnd,
    ...(last4 ? { last4 } : {}),
    beginningBalanceCents: -previousPrinted,
    endingBalanceCents: -newPrinted,
    txns,
  };
}

export const chaseCardStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  // shares its filename shape with the checking statements — content decides,
  // and gating on the name too would exclude any copy that has been renamed
  matches: (f) => f.format === "pdf",
  matchesContent: isChaseCardStatementText,
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseChaseCardLines(lines.map((l) => l.text));
    return [
      {
        accountHint: {
          institution: "Chase",
          type: "credit",
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
