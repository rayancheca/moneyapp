/**
 * Description normalizer v3 — used for merchant matching and display,
 * NEVER for dedupe (dedupe hashes raw text; see schema.md).
 * Versioned so matching behavior changes are traceable: v2 took off Wells
 * Fargo's card envelope, v3 an ACH entry's individual ID (below).
 */

export const NORMALIZER_VERSION = 3;

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

/**
 * v3 — an ACH entry's INDIVIDUAL ID: the fifteen-character field a NACHA entry carries beside the payee, which Wells
 * Fargo prints just before his name and Chase before the originator's "WEB ID:". The originator sets it per entry,
 * so — like the card reference above — it made every entry a descriptor of its own.
 *
 * 🔴 Measured on his ledger copy 2026-10-29: the Oct 26 statement brought four weekly pay deposits of +$1,141.92,
 * "It America LLC Payroll 261001 9303446743548Qj Karim Checa,Rayan" and three more like it, and linking at import
 * linked none — absorption matches a descriptor exactly, and each held an ID no other row can share. Only the
 * off-cycle +$200.00 linked: its ID field holds his name. Each Capital One card payment ("Capital One Mobile Pmt
 * CA0Fda683870046 Rayan Karim Checa") was a payee of its own on /spending, "· 1 transaction · unlinked · $1,500.00".
 *
 * ⛔ Narrow on purpose. All-digit IDs already go with the long digit runs below; this takes a token of exactly fifteen
 * letters and digits holding five digits or more — never a 9-character CUSIP, a short store number, a 12-character
 * Zelle reference or a 13-character T-Mobile one. And never a number glued to a word: Venture X prints a store number
 * and its city as one token ("MODERN MARKET 014042JAMAICANY", fifteen characters), and that is a name. Measured over
 * every raw description on the copy, 13,026 rows: 47 change — Chase 37 (32 active), Wells Fargo 10 (9 active), 41
 * distinct IDs, every one Capital One's CA0…/RT0…/LD0… or the payroll's …QJ — and nothing else in any of them moves.
 */
const ACH_INDIVIDUAL_ID_LENGTH = 15;
const ACH_INDIVIDUAL_ID_MIN_DIGITS = 5;
const ACH_INDIVIDUAL_ID_RE = /^[A-Z0-9]+$/;
const NUMBER_GLUED_TO_WORD_RE = /^(?:\d+[A-Z]{3,}|[A-Z]{3,}\d+)$/;

function isAchIndividualId(token: string): boolean {
  if (token.length !== ACH_INDIVIDUAL_ID_LENGTH || !ACH_INDIVIDUAL_ID_RE.test(token) || !/[A-Z]/.test(token)) return false;
  if ((token.match(/\d/g) ?? []).length < ACH_INDIVIDUAL_ID_MIN_DIGITS) return false;
  return !NUMBER_GLUED_TO_WORD_RE.test(token);
}

/**
 * A normalized description without its ACH individual IDs (above) — v3's LAST step, so it is v2's answer with the ID
 * taken off. ⛔ That is why it is exported: `normalized_description` is stored at import, and his rows keep the v2
 * strings theirs wrote, so a comparison of a stored description against another reads both through this — absorption
 * (`absorbIntoLiveSeries`) and the stripped key (`strippedDescriptionKey`) — and a v2 row and a v3 row of one payee are
 * one descriptor without a row of his being rewritten. A description that is nothing but the ID keeps it: an empty one
 * names nothing, and every reader skips it.
 */
export function withoutAchReferences(normalized: string): string {
  const tokens = normalized.split(" ");
  const kept = tokens.filter((t) => !isAchIndividualId(t));
  return kept.length === tokens.length || kept.length === 0 ? normalized : kept.join(" ");
}

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

  // v3, last: a stored v2 string reads as this one through the same function (`withoutAchReferences`)
  return withoutAchReferences(s);
}
