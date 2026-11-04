import type { Cadence } from "@/db/schema/recurring";
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

/** The series a commitment is billed inside, as its evidence needs it — the LIVE one, followed through any merge. */
export interface BillingCarrier {
  readonly id: string;
  readonly name: string;
  /** the CARRIER's own newest matched charge — the evidence the series billed inside it borrows */
  readonly lastMatchedOn: string | null;
  /**
   * …and where the CARRIER's own schedule opens, and whether that day is his (`ownOpening`): what opens the series
   * billed inside it too — on the day of that series' own that falls due with it — for every grader and every
   * projection of it (`openingOf`, `DueDays.opensOn`)
   */
  readonly opensOn: string | null;
  readonly opensOnHisDate: boolean;
  /**
   * ⚖️ …and the payment that PAID that day by the carrier's own test (`paymentFor`), or null while none has: which day
   * of what it carries falls due with it — the one that payment pays (`openingOf`; default built, not asked,
   * 2026-10-29). ⛔ REQUIRED, `userEndsOn`'s reason: a carrier built without it would open what it carries on its day
   * nearest the carrier's date, silently — a day a payment posted after that date may never pay.
   */
  readonly opensPaidBy: OpeningPayment | null;
  /**
   * ⚖️ …and the carrier's own schedule, as its due days are stepped (`effectiveSchedule`): what PAIRS each day of what
   * it carries with the carrier's own day of that period (`pairingOf`; default (B), built, not asked, 2026-10-30) — the
   * day of theirs that falls due with the carrier's opening day pairs with that day, and each later day of theirs with
   * the carrier's day the same number of steps on, so each payment of the carrier's pays exactly the one of theirs its
   * own day carries. Checked against a calendar: the rent typed Nov 16, the utilities on the 1st — their Nov 1 is the
   * rent's Nov 16, their Dec 1 the rent's Dec 16, their Jan 1 the rent's Jan 16: whatever pays the rent's Dec 16 pays
   * their Dec 1, and nothing else does; and their Dec 1 falls due on the rent's Dec 16 — still to come until then, owed
   * or drawn missed only from then, and named, listed and drawn on that day by every reader (`fallsDueOn`). ⛔
   * REQUIRED, `userEndsOn`'s reason: a carrier built without it would leave every day of what it carries to the
   * payment nearest it, silently.
   */
  readonly schedule: CarrierSchedule;
}

/** When a carrier falls due — its effective schedule's step and anchor (`effectiveSchedule`), as its due days step. */
export interface CarrierSchedule {
  readonly cadence: Cadence;
  readonly intervalDaysAvg: number | null;
  readonly nextExpectedOn: string | null;
  readonly anchorDay: number | null;
}

/**
 * The payment that paid where a carrier's schedule opens (`BillingCarrier.opensPaidBy`): the day it posted, and how
 * many of the carrier's due days its own day lies past that opening day — read off the branch of `paymentFor` that
 * found it: 0 when it was that day's own payment, on time, early or late (default (c)'s late one too); 1 when, a
 * payment of two, it caught the opening day up from the day after; −1 when it paid the opening day as the second
 * charge of the day before. 🔴 Read off the payment's NEAREST due day (review of 46f19f15), a payment of one month
 * late for the opening day by default (c) — nearer the next day, which another payment paid on time — read 1: the
 * rent typed Nov 25, Dec 12 and Dec 25, it opened what the rent carries a day of theirs before the one Dec 12 pays.
 */
export interface OpeningPayment {
  readonly postedOn: string;
  readonly dueDaysPast: number;
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
 * "its payments carry Rent utilities & fees too" — said, in the line's own quiet words, wherever a CARRIER's posted
 * average is named (the series page's Per charge, the All tab, the amount popover): what is billed inside its payments
 * is money that average holds. `names` are the series billed inside it (`carriedNamesBySeries`); null for none.
 *
 * 🔴 His rent's page read "posted avg -$2,312.20" under "-$2,109.00" — and the popover "⚠️ … which is not what you
 * set" — with nothing to say the $182.21 utilities are inside every payment (a copy of his ledger, 2026-10-12).
 */
export function carriesPhrase(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `its payments carry ${list} too`;
}

/**
 * "billed with the rent, last seen Sep 2" — the words where "never billed" stood, on the Subscriptions card and the
 * series' own page. Null for a series billed on its own. The day is `lastSeenOn`, spelled for a sentence
 * (`formatDayShortIn`, the card's own "last seen" spelling).
 */
export function billedWithLabel(s: EvidenceSource, today: string): string | null {
  if (s.billedWith === null) return null;
  return carriedLabel(s.billedWith, lastSeenOn(s), today);
}

function carriedLabel(carrier: Pick<BillingCarrier, "name">, seen: string | null, today: string): string {
  const phrase = billedWithPhrase(carrier);
  if (seen === null) return `${phrase}, which has never been billed`;
  return `${phrase}, last seen ${formatDayShortIn(seen, today)}`;
}

/**
 * What the proof of its amount says of the evidence behind it when no row has posted under its own name — the
 * sentence where "Nothing tagged to it has ever posted, so there is no evidence behind it at all" stood (the amount
 * popover on its page, and every insight that cites it). Its carrier's postings ARE its evidence, named in the chip's
 * own words (`billedWithLabel`); a carrier the bank has never billed lends none, and the sentence says that too. Null
 * for a series billed on its own.
 */
export function billedWithEvidence(s: EvidenceSource, today: string): string | null {
  if (s.billedWith === null) return null;
  const seen = lastSeenOn(s);
  const lead = `No row posts under its own name — it is ${carriedLabel(s.billedWith, seen, today)}`;
  if (seen === null) return `${lead}, so there is no evidence behind it at all.`;
  const carrier = carrierWord(s.billedWith.name);
  return `${lead}: paid inside ${carrier}'s payment, so ${carrier}'s postings are its evidence.`;
}
