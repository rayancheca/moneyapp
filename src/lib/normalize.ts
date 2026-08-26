/**
 * Description normalizer v1 — used for merchant matching and display,
 * NEVER for dedupe (dedupe hashes raw text; see schema.md).
 * Versioned so matching behavior changes are traceable.
 */

export const NORMALIZER_VERSION = 2;

/** Payment-processor prefixes that hide the real payee. */
const PROCESSOR_PREFIX_RE = /^(?:TST\*\s*|TST\s\*\s*|SQ\s?\*\s*|DD\s\*\s*|PY\s\*\s*|PAYPAL\s?\*\s*|PP\*\s*|APLPAY\s+|GOOGLE\s?\*\s*)/;

/**
 * Wells Fargo wraps every card purchase in a fixed envelope that no other
 * institution here uses: a `PURCHASE AUTHORIZED ON MM/DD ` opener and a
 * ` S<19 digits> CARD <4 digits>` reference at the end.
 *
 * ⛔ That reference is UNIQUE PER TRANSACTION, which makes this more than
 * cosmetic. Left in place, every Wells Fargo row normalizes to a string no
 * other row can ever equal, so the merchant map — which matches aliases
 * `exact` in 1,741 of 1,802 cases — can neither match an existing merchant nor
 * usefully learn a new one: each alias it learned would be single-use. Measured
 * on the real import: 38 of 39 rows landed uncategorized, and the one that did
 * not was McDonald's, whose alias happens to be a `contains`.
 *
 * Stripped BEFORE `PROCESSOR_PREFIX_RE` because the envelope hides those
 * prefixes: `PURCHASE AUTHORIZED ON 07/31 SQ *YA-FIT…` only reveals its `SQ *`
 * once the opener is gone.
 *
 * With both gone the rest of this pipeline already does the work — the trailing
 * state rule turns `LA PISCINE MIAMI BEACH FL` into `LA PISCINE MIAMI BEACH`,
 * which is the exact alias Chase Sapphire already taught it.
 */
const WF_AUTHORIZED_PREFIX_RE =
  /^(?:PURCHASE(?: WITH CASH BACK \$ ?[\d,.]+)?|RECURRING PAYMENT|RECURRING TRANSFER)\s+AUTHORIZED ON \d{2}\/\d{2}\s+/;
const WF_CARD_REFERENCE_RE = /\s+S\d{10,}\s+CARD\s+\d{4}\s*$/;

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
]);

export function normalizeDescription(raw: string): string {
  let s = raw.toUpperCase().trim();

  // the Wells Fargo envelope comes off first — it hides the processor prefixes
  s = s.replace(WF_AUTHORIZED_PREFIX_RE, "").replace(WF_CARD_REFERENCE_RE, "");
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
