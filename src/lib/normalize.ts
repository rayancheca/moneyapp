/**
 * Description normalizer v1 — used for merchant matching and display,
 * NEVER for dedupe (dedupe hashes raw text; see schema.md).
 * Versioned so matching behavior changes are traceable.
 */

export const NORMALIZER_VERSION = 1;

/** Payment-processor prefixes that hide the real payee. */
const PROCESSOR_PREFIX_RE = /^(?:TST\*\s*|TST\s\*\s*|SQ\s?\*\s*|DD\s\*\s*|PY\s\*\s*|PAYPAL\s?\*\s*|PP\*\s*|APLPAY\s+|GOOGLE\s?\*\s*)/;

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
]);

export function normalizeDescription(raw: string): string {
  let s = raw.toUpperCase().trim();

  s = s.replace(PROCESSOR_PREFIX_RE, "");

  // masked card numbers: XXXXXXXXXXXX1234
  s = s.replaceAll(/\bX{4,}\d{0,6}\b/g, " ");
  // store numbers: "#402", "# 0071"
  s = s.replaceAll(/#\s?\d+/g, " ");
  // long reference/phone digit runs (5+) — keep short numbers
  s = s.replaceAll(/\b\d{5,}\b/g, " ");

  s = s.replaceAll(/\s+/g, " ").trim();

  // trailing US state code (statement city/state suffix), only when enough
  // of the merchant name remains to match on
  const tokens = s.split(" ");
  const last = tokens.at(-1);
  if (tokens.length >= 3 && last !== undefined && US_STATES.has(last)) {
    s = tokens.slice(0, -1).join(" ");
  }

  return s;
}
