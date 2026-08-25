import { BRAND_ICONS, type BrandIcon, type BrandSlug } from "./brand-icons.generated";

/**
 * What mark to draw for a merchant: its brand logo where the app has one, and a
 * monogram tile where it does not.
 *
 * ## Why a monogram is the DEFAULT, not the failure case
 *
 * The ledger holds 893 merchants and the vendored set carries 63 logos, so most
 * marks will be monograms — and on the owner's own recurring series the hit rate
 * is worse than average, because simple-icons has dropped Amazon, OpenAI,
 * T-Mobile and every US utility over trademark policy. A design that only looks
 * right when a logo is found would look wrong most of the time.
 *
 * So the monogram is treated as the real design and the logo as the bonus: both
 * are the same tile, the same size, in the same category hue, and a row of them
 * reads as one system. What identifies the charge is the tile's HUE (its
 * category) plus its letters; the logo, when present, just makes it instant.
 *
 * Pure: no React, no DOM, no `Date`, no `Math.random`.
 */

export interface BrandMark {
  kind: "logo" | "monogram";
  /** present when `kind` is "logo" */
  icon: BrandIcon | null;
  /** 1–2 uppercase letters; always present, and used as the logo's fallback */
  monogram: string;
}

/**
 * Merchant-name fragments → brand slug, longest-first at match time.
 *
 * Matched against a lowercased, punctuation-stripped name rather than an exact
 * key, because bank descriptors are not tidy: the real ledger carries
 * "YOUTUBEPREMIUM", "UBER *ONE" and "TMOBILE*PREPD AUTOPY 877-778-2106" for
 * merchants a human would call YouTube, Uber and T-Mobile.
 *
 * The slug is typed `BrandSlug`, so a fragment pointing at an icon nobody
 * vendored is a compile error rather than a silent fall-through to a monogram —
 * which would look exactly like a deliberate design choice.
 *
 * ⚠️ Fragments must be distinctive enough to survive being searched for inside
 * an arbitrary descriptor. Pass 32's lesson is the cautionary one here: a
 * `/CHASE/i` test matched "pur**CHASE**" and routed a statement to the wrong
 * parser. Every fragment below is either ≥5 characters or a brand whose name is
 * not a substring of ordinary English — and `chase` itself is deliberately
 * spelled as the two forms a bank actually prints.
 */
const FRAGMENTS: ReadonlyArray<readonly [fragment: string, slug: BrandSlug]> = [
  ["youtube music", "youtubemusic"],
  ["youtubemusic", "youtubemusic"],
  ["youtube", "youtube"],
  ["netflix", "netflix"],
  ["spotify", "spotify"],
  ["audible", "audible"],
  ["patreon", "patreon"],
  ["twitch", "twitch"],
  ["crunchyroll", "crunchyroll"],
  ["duolingo", "duolingo"],
  ["coursera", "coursera"],
  ["udemy", "udemy"],
  ["playstation", "playstation"],
  ["steam", "steam"],
  ["github", "github"],
  ["notion", "notion"],
  ["figma", "figma"],
  ["dropbox", "dropbox"],
  ["googledrive", "googledrive"],
  ["google drive", "googledrive"],
  ["icloud", "icloud"],
  ["jetbrains", "jetbrains"],
  ["zoomvideo", "zoom"],
  ["zoomus", "zoom"],
  ["ubereats", "ubereats"],
  ["uber eats", "ubereats"],
  ["uber", "uber"],
  ["lyft", "lyft"],
  ["doordash", "doordash"],
  ["instacart", "instacart"],
  ["starbucks", "starbucks"],
  ["mcdonald", "mcdonalds"],
  ["target", "target"],
  ["ikea", "ikea"],
  ["etsy", "etsy"],
  ["ebay", "ebay"],
  ["shopify", "shopify"],
  ["adidas", "adidas"],
  ["uniqlo", "uniqlo"],
  ["nike", "nike"],
  ["zara", "zara"],
  ["chase sapphire", "chase"],
  ["chase freedom", "chase"],
  ["jpmorgan", "chase"],
  ["discover", "discover"],
  ["american express", "americanexpress"],
  ["amex", "americanexpress"],
  ["mastercard", "mastercard"],
  ["paypal", "paypal"],
  ["venmo", "venmo"],
  ["zelle", "zelle"],
  ["robinhood", "robinhood"],
  ["wells fargo", "wellsfargo"],
  ["bank of america", "bankofamerica"],
  ["coinbase", "coinbase"],
  ["cash app", "cashapp"],
  ["revolut", "revolut"],
  ["stripe", "stripe"],
  ["airbnb", "airbnb"],
  ["marriott", "marriott"],
  ["hilton", "hilton"],
  ["tesla", "tesla"],
  ["apple", "apple"],
];

/** Lowercased, with every non-alphanumeric run collapsed to a single space. */
export function normalizeForBrand(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * 1–2 letters standing in for a merchant.
 *
 * Two letters from two words ("Extra Space Storage" → ES, "Cash job (weekly
 * pay)" → CJ), one from a single word ("Netflix" → N). Digits count as words so
 * a descriptor like "7-Eleven" still reads as 7E rather than E.
 *
 * Falls back to "?" only for a name with nothing alphanumeric in it at all,
 * which is the `<UNKNOWN>` merchant the importer creates.
 */
export function monogramFor(name: string): string {
  const words = normalizeForBrand(name).split(" ").filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}

/**
 * The mark for one merchant name.
 *
 * Fragments are tried LONGEST FIRST so a more specific brand wins over one whose
 * name it contains — "youtubemusic" before "youtube", "ubereats" before "uber".
 * Sorting here rather than trusting the table's order means adding a fragment
 * can never silently shadow an existing one.
 */
const BY_LENGTH = [...FRAGMENTS].sort((a, b) => b[0].length - a[0].length);

export function brandMarkFor(name: string): BrandMark {
  const monogram = monogramFor(name);
  const haystack = normalizeForBrand(name);
  for (const [fragment, slug] of BY_LENGTH) {
    if (haystack.includes(fragment)) return { kind: "logo", icon: BRAND_ICONS[slug], monogram };
  }
  return { kind: "monogram", icon: null, monogram };
}
