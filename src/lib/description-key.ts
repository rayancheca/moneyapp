/**
 * Merchantless grouping key (ux-overhaul-plan §3.2): strips the volatile
 * tokens statement descriptions embed (dates, amounts, reference numbers,
 * R/D–P/D dividend date markers) so re-occurrences of the same activity
 * produce the same key. Input is a normalizeDescription() output (already
 * uppercase); the function re-uppercases defensively so it stays total.
 *
 * Brokerage-style rows ("… CUSIP: … (COKE)", "CASH DIV: … (MSFT)") are keyed
 * by the trailing parenthesized ticker PLUS an activity word class — the same
 * instrument's cash dividends, DRIP purchases, recurring buys, and plain
 * trades group separately, because they follow different cadences and mixing
 * them would poison recurring detection (the Stage-2 consumer). Ticker keying
 * is gated on brokerage marker words so retail "(NYC)"-style suffixes never
 * collapse unrelated merchants.
 *
 * Returns "" when nothing survives stripping — callers must not group empty
 * keys (mirrors the null-key skip in recurring detection).
 */

const TICKER_SUFFIX_RE = /\(([A-Z][A-Z0-9.]{0,6})\)\s*$/;
const BROKERAGE_MARKER_RE = /\b(?:CUSIP|DIV|DIVIDENDS?|SHARES|REINVEST(?:MENT)?|SPLIT)\b/;

const RECORD_PAY_DATE_RE = /\b[RP]\/D\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
// 07/02, 6/5/2026, 04-24-26 — anything date-shaped is volatile by definition
const NUMERIC_DATE_RE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g;
const MONTH_NAME_DATE_RE =
  /\b(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\.?\s+\d{1,2}(?:\s*,?\s*\d{4})?\b/g;
// 9-char CUSIPs survive the normalizer because they mix letters in (81762P102)
const CUSIP_RE = /\b\d{3}[A-Z0-9]{5}\d\b/g;
// "$43.64", "1,234.56", "0.25", trailing "32." — bare short integers stay
// (store/street numbers are identity, not noise)
const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d+\b|\b\d+\.(?=\s|$)/g;
const LONG_DIGIT_RUN_RE = /\b\d{5,}\b/g;

export type BrokerageActivityClass = "REINVEST" | "RECURRING" | "DIV" | "TRADE";

// REINVEST is tested first: "DIVIDEND REINVESTMENT" must not classify as DIV
function activityClass(body: string): BrokerageActivityClass {
  if (/\bREINVEST(?:MENT)?\b/.test(body)) return "REINVEST";
  if (/\bRECURRING\b/.test(body)) return "RECURRING";
  if (/\bDIV\b|\bDIVIDENDS?\b/.test(body)) return "DIV";
  return "TRADE";
}

export function strippedDescriptionKey(normalizedDescription: string): string {
  const s = normalizedDescription.toUpperCase().trim();
  if (s === "") return "";

  const tickerMatch = TICKER_SUFFIX_RE.exec(s);
  if (tickerMatch) {
    const body = s.slice(0, tickerMatch.index);
    if (BROKERAGE_MARKER_RE.test(body)) {
      // lowercase prefix cannot collide with retail keys (always uppercase)
      return `ticker:${tickerMatch[1]!}:${activityClass(body)}`;
    }
  }

  const stripped = s
    .replace(RECORD_PAY_DATE_RE, " ")
    .replace(ISO_DATE_RE, " ")
    .replace(NUMERIC_DATE_RE, " ")
    .replace(MONTH_NAME_DATE_RE, " ")
    .replace(CUSIP_RE, " ")
    .replace(AMOUNT_RE, " ")
    .replace(LONG_DIGIT_RUN_RE, " ");

  return stripped
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ""))
    .filter((token) => token !== "")
    .join(" ");
}
