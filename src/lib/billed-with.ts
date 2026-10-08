import { compareDates } from "./dates";
import { formatDayShortIn } from "./format-date";

/**
 * ⚖️ A commitment BILLED INSIDE another series' payment (owner decision 2026-10-08, §6A 59). `Rent utilities & fees`
 * ($182.21 a month) is paid inside the rent: Sep 2's $2,291.21 is the rent's $2,109.00 + $182.21, and the payments
 * before it ($2,285.70, $2,237.11, $1,100.00 + $1,334.80) carried it too. No row of its own will ever post, so its
 * EVIDENCE is the rent's postings — and it reads "billed with the rent, last seen Sep 2" wherever it read "never
 * billed".
 *
 * 🔴 It read "never billed" on every surface that says so — the Subscriptions card's line and its "$477.90 of the
 * figure above — 12.5% of it — has never been billed by a bank", /recurring's "$651.07 never billed", the All tab's
 * Never billed section, the calendar's badge and its own page — of money the bank takes every month inside the rent.
 *
 * The link is one column (`recurring_series.user_billed_with_series_id`) and this is its one reading; services attach
 * the carrier to a row (`billingCarriers`), and every evidence reader — staleness, evidence, lapse, the forecast's
 * gate — asks `lastSeenOn`. Client-safe, so a component can word it without importing the database.
 */

/** The series a commitment is billed inside, as its evidence needs it. */
export interface BillingCarrier {
  readonly id: string;
  readonly name: string;
  /** the CARRIER's own newest matched charge — the evidence the series billed inside it borrows */
  readonly lastMatchedOn: string | null;
}

/**
 * What a series' evidence is read from: its own newest posting, and the carrier it is billed with.
 *
 * ⛔ `billedWith` is REQUIRED, `userEndsOn`'s reason: a row that reached an evidence reader without it would read
 * "never billed" for a series billed with the rent, silently, for whoever forgot. `null` says "billed on its own".
 */
export interface EvidenceSource {
  readonly lastMatchedOn: string | null;
  readonly billedWith: BillingCarrier | null;
}

/**
 * When the series was last SEEN: the newer of its own posting and its carrier's. Null when neither has ever posted —
 * a carrier the bank has never billed lends nothing, and the series is never billed until it is.
 */
export function lastSeenOn(s: EvidenceSource): string | null {
  const borrowed = s.billedWith?.lastMatchedOn ?? null;
  if (borrowed === null) return s.lastMatchedOn;
  if (s.lastMatchedOn === null) return borrowed;
  return compareDates(borrowed, s.lastMatchedOn) > 0 ? borrowed : s.lastMatchedOn;
}

/** A name that ENDS in its own word in parentheses — "Flamingo South Beach (rent)". */
const OWN_WORD = /\(([^()]*\S[^()]*)\)\s*$/;

/**
 * What the carrier is called in a sentence: the word its name gives itself in parentheses — "Flamingo South Beach
 * (rent)" is "the rent", the owner's own phrase — else its whole name.
 */
export function carrierWord(name: string): string {
  const own = OWN_WORD.exec(name)?.[1]?.trim();
  return own ? `the ${own}` : name;
}

/** "billed with the rent" — the calendar's word for an upcoming entry, beside its confidence. */
export function billedWithPhrase(carrier: Pick<BillingCarrier, "name">): string {
  return `billed with ${carrierWord(carrier.name)}`;
}

/**
 * "billed with the rent, last seen Sep 2" — the words where "never billed" stood, on the Subscriptions card and the
 * series' own page. Null for a series billed on its own. The day is `lastSeenOn`, spelled for a sentence
 * (`formatDayShortIn`, the card's own "last seen" spelling).
 */
export function billedWithLabel(s: EvidenceSource, today: string): string | null {
  if (s.billedWith === null) return null;
  const seen = lastSeenOn(s);
  const phrase = billedWithPhrase(s.billedWith);
  if (seen === null) return `${phrase}, which has never been billed`;
  return `${phrase}, last seen ${formatDayShortIn(seen, today)}`;
}
