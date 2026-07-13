import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";

/**
 * Real Robinhood Crypto statement PDFs (single-column). The account is an
 * investment value anchor: OPENING/CLOSING BALANCE are portfolio VALUES with
 * sub-cent precision (rounded to the nearest cent). The activity table is
 * DATE TYPE DEBIT CREDIT PRICE VALUE FEE — a Crypto Purchase credits crypto for
 * $VALUE (cash into the account, +VALUE), a Crypto Sale debits crypto for $VALUE
 * (cash out, −VALUE). Reconciliation is value_anchor, so market movement lands in
 * market_change_cents; these rows are the activity ledger, priced by holding
 * events elsewhere.
 */

const PROFILE_ID = "robinhood-crypto-statement-pdf";

const PERIOD_START_RE = /^PERIOD START (\d{4}-\d{2}-\d{2})$/;
const PERIOD_END_RE = /^PERIOD END (\d{4}-\d{2}-\d{2})$/;
const OPENING_RE = /^OPENING BALANCE \$([\d.]+)$/;
const CLOSING_RE = /^CLOSING BALANCE \$([\d.]+)$/;
/** DATE TYPE DEBIT CREDIT PRICE VALUE FEE — DEBIT/CREDIT are "--" or "<qty> SYM" */
const ROW_RE =
  /^(\d{4}-\d{2}-\d{2}) (Crypto Purchase|Crypto Sale) (--|[\d.]+ [A-Z]+) (--|[\d.]+ [A-Z]+) \$[\d.]+ \$([\d.]+) (--|\$[\d.]+)$/;

function requireIso(raw: string): string {
  if (!isValidIsoDate(raw)) throw new ParseError(PROFILE_ID, `Invalid date "${raw}"`);
  return raw;
}

function findCapture(texts: readonly string[], re: RegExp): string | null {
  for (const t of texts) {
    const m = re.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

export interface RobinhoodCryptoParse {
  periodStart: string;
  periodEnd: string;
  /** portfolio market values (positive assets), rounded to the nearest cent */
  openingValueCents: number;
  closingValueCents: number;
  txns: CanonicalTxn[];
}

/** Pure text-level core, exported for unit tests. */
export function parseRobinhoodCryptoLines(texts: readonly string[]): RobinhoodCryptoParse {
  const start = findCapture(texts, PERIOD_START_RE);
  const end = findCapture(texts, PERIOD_END_RE);
  if (!start || !end) throw new ParseError(PROFILE_ID, "No PERIOD START/END found");

  const opening = findCapture(texts, OPENING_RE);
  const closing = findCapture(texts, CLOSING_RE);
  if (opening === null || closing === null) {
    throw new ParseError(PROFILE_ID, "Missing OPENING/CLOSING BALANCE");
  }

  const txns: CanonicalTxn[] = [];
  for (const text of texts) {
    const m = ROW_RE.exec(text);
    if (!m) continue;
    const isSale = m[2] === "Crypto Sale";
    // the non-"--" leg carries the crypto quantity + symbol
    const cryptoLeg = isSale ? m[3]! : m[4]!;
    const valueCents = parseAmountToCents(`$${m[5]}`);
    txns.push({
      postedOn: requireIso(m[1]!),
      // purchase = cash into the account (+), sale = cash out (−)
      amountCents: isSale ? -valueCents : valueCents,
      rawDescription: `${m[2]} ${cryptoLeg}`,
      categoryPath: isSale ? "Investments > Sells" : "Investments > Buys",
    });
  }

  return {
    periodStart: requireIso(start),
    periodEnd: requireIso(end),
    openingValueCents: parseAmountToCents(`$${opening}`),
    closingValueCents: parseAmountToCents(`$${closing}`),
    txns,
  };
}

export const robinhoodCryptoStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  matches: (f) => f.format === "pdf" && /robinhood-crypto.*statement.*\.pdf$/i.test(f.name),
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseRobinhoodCryptoLines(lines.map((l) => l.text));
    return [
      {
        accountHint: {
          institution: "Robinhood",
          type: "investment",
          subtype: "crypto",
          name: "Robinhood Crypto",
        },
        txns: parsed.txns,
        period: {
          start: parsed.periodStart,
          end: parsed.periodEnd,
          // investment portfolio values are positive assets (not flipped)
          beginCents: parsed.openingValueCents,
          endCents: parsed.closingValueCents,
        },
      },
    ];
  },
};
