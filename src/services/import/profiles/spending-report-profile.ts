import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";

/**
 * Chase "Spending Report" PDF (chase.com → card → Spending report →
 * custom range → download). NOT a statement: transactions grouped under
 * Chase's category buckets, no balances, no payments — so it declares a
 * coverage range instead of anchoring balances, and each row carries its
 * bucket as bankCategory for the categorizer. Charges print positive;
 * canonical form is net-worth-signed, so amounts flip here.
 */

const PROFILE_ID = "chase-spending-report-pdf";

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

const MON = "([A-Z][a-z]{2}) (\\d{2}), (\\d{4})";
const ROW_RE = new RegExp(`^${MON} ${MON} (.+?) (-?\\$[\\d,]+\\.\\d{2})$`);
const RANGE_RE = new RegExp(`^${MON} to ${MON} Spending Report(?: (\\d{4}))?`);
/** section headers are Chase bucket slugs: AUTOMOTIVE, BILLS_AND_UTILITIES… */
const CATEGORY_RE = /^[A-Z][A-Z0-9_&]{2,}$/;

function monthDayYearToIso(mon: string, dd: string, yyyy: string): string {
  const mm = MONTHS[mon];
  if (!mm) throw new ParseError(PROFILE_ID, `Unknown month "${mon}"`);
  const iso = `${yyyy}-${mm}-${dd}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${mon} ${dd}, ${yyyy}`);
  return iso;
}

export interface SpendingReportParse {
  txns: CanonicalTxn[];
  rangeStart: string;
  rangeEnd: string;
  /** the constant card identifier printed beside "Spending Report" in the footer */
  last4?: string;
}

/** Pure text-level core, exported for unit tests. */
export function parseSpendingReportLines(texts: readonly string[]): SpendingReportParse {
  let category: string | undefined;
  let range: { start: string; end: string; last4?: string } | undefined;
  const txns: CanonicalTxn[] = [];

  for (const text of texts) {
    const rangeMatch = RANGE_RE.exec(text);
    if (rangeMatch) {
      range ??= {
        start: monthDayYearToIso(rangeMatch[1]!, rangeMatch[2]!, rangeMatch[3]!),
        end: monthDayYearToIso(rangeMatch[4]!, rangeMatch[5]!, rangeMatch[6]!),
        ...(rangeMatch[7] ? { last4: rangeMatch[7] } : {}),
      };
      continue;
    }
    if (CATEGORY_RE.test(text)) {
      category = text;
      continue;
    }
    const row = ROW_RE.exec(text);
    if (!row) continue; // column headers, "Total $…", footers
    txns.push({
      transactedOn: monthDayYearToIso(row[1]!, row[2]!, row[3]!),
      postedOn: monthDayYearToIso(row[4]!, row[5]!, row[6]!),
      // report prints charges positive → money out; a printed negative
      // (refund) flips back to an inflow
      amountCents: -parseAmountToCents(row[8]!),
      rawDescription: row[7]!,
      ...(category ? { bankCategory: category } : {}),
    });
  }

  if (!range) {
    throw new ParseError(PROFILE_ID, 'No "Mon DD, YYYY to Mon DD, YYYY … Spending Report" footer — not a Chase spending report?');
  }
  if (txns.length === 0) throw new ParseError(PROFILE_ID, "No transaction rows parsed");
  return { txns, rangeStart: range.start, rangeEnd: range.end, ...(range.last4 ? { last4: range.last4 } : {}) };
}

export const chaseSpendingReportPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  // matches() is sync so content can't be sniffed here — the filename
  // carries the routing (Chase names these exports "Spending Report PDF");
  // a mis-named report reaches statement-pdf and fails loudly there.
  matches: (f) => f.format === "pdf" && /spending[ _-]?report/i.test(f.name),
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseSpendingReportLines(lines.map((l) => l.text));
    return [
      {
        accountHint: {
          institution: "Chase",
          type: "credit",
          ...(parsed.last4 ? { last4: parsed.last4 } : {}),
        },
        txns: parsed.txns,
        declaredRange: { start: parsed.rangeStart, end: parsed.rangeEnd },
      },
    ];
  },
};
