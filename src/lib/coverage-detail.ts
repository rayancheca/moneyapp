import { diffDays } from "./dates";
import { MONTHS_SHORT } from "./format-date";

/**
 * What one account's coverage row SAYS, in one place.
 *
 * ⛔ This exists because the shipped sentence was false on the owner's own
 * ledger. `/imports` read:
 *
 *     Cash on Hand · UNVERIFIED
 *     nothing has checked this account since 2026-08-11 — 1 days rest on an
 *     export with no closing balance
 *
 * Two defects in one line. **"1 days"** — the `broken` branch pluralised and
 * this one did not. And **"nothing has checked this account"** is simply
 * untrue: that account closes to the cent through 2026-08-03, and exactly one
 * day at the end does not. `verifiedThrough` was computed, carried on the
 * record, and then rendered only inside `case "verified"` — so the two states
 * that most need it were the two that could not show it.
 *
 * Both halves of the fact belong in the sentence: **what closes, and where it
 * stops**. An account that closes through last week with one loose day is a
 * different object from one that has never closed at all, and before this they
 * read identically.
 *
 * `daysSinceVerified` gets its consumer here — pass 68 asked for one or for its
 * deletion. It answers the question the date alone does not: 27 days is this
 * ledger's ordinary monthly rhythm, and knowing that is what stops a reader
 * treating a normal cycle as a fault.
 */

export type CoverageGradeName = "broken" | "unverified" | "market_value" | "unknown" | "manual" | "verified";

export interface CoverageDetailInput {
  grade: CoverageGradeName;
  /** last day whose balance rests on a closed arithmetic chain */
  verifiedThrough: string | null;
  /** first day that is `derived_unverified` or `gap` */
  unverifiedSince: string | null;
  /** first day the walk actually MISSED an anchor */
  brokenSince: string | null;
  /** whole days from `verifiedThrough` to today */
  daysSinceVerified: number | null;
  lastManualUpdate: string | null;
  gapDays: number;
  unverifiedDays: number;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * "Aug 3, 2026" — readable, and it always carries the year.
 *
 * ⚠️ `formatDayShort` drops the year, and these dates are forensic rather than
 * recent: Robinhood Cash's first unverified day is 2023-12-05, which rendered
 * as "Dec 5" and read as THIS December. The raw ISO the panel shipped with was
 * ugly and unambiguous; this is neither ugly nor ambiguous.
 */
function dayWithYear(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = MONTHS_SHORT[Number(month) - 1];
  // an unparseable day is echoed rather than rendered as "undefined NaN"
  if (!name || !year || !day) return iso;
  return `${name} ${Number(day)}, ${year}`;
}

/** "today" / "1 day ago" / "27 days ago" — null when nothing has ever closed. */
export function agoPhrase(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 0) return "today";
  return `${days} ${plural(days, "day", "days")} ago`;
}

/**
 * What DOES close, as a clause — or the honest alternative when nothing does.
 *
 * ⚠️ `verifiedThrough` can be null on a `verified` account too, not only on a
 * broken one: an account whose every day is `carried` has no `anchored` or
 * `derived` day for the walk to end on. Rare, and it rendered "through null"
 * before this branch existed.
 */
function closesClause(input: CoverageDetailInput): string {
  if (input.verifiedThrough === null) return "nothing has closed on this account yet";
  const ago = agoPhrase(input.daysSinceVerified);
  const dated = dayWithYear(input.verifiedThrough);
  return ago === null ? `closes to the cent through ${dated}` : `closes to the cent through ${dated} (${ago})`;
}

export function coverageDetail(input: CoverageDetailInput): string {
  switch (input.grade) {
    case "broken": {
      /*
       * `brokenSince`, NOT `unverifiedSince`. The sentence pairs a date with a
       * count and they came from two different populations: `unverifiedSince`
       * is the first `derived_unverified` OR `gap` day, while `gapDays` counts
       * only the latter. On Robinhood Cash that once rendered "stops closing at
       * 2023-12-05 — 264 days cannot be trusted" when every one of those 264
       * days is 2025-11 or later and 2023-12-05 is merely where the replay
       * begins. The date accused eighteen months of reconciled history.
       */
      const n = input.gapDays;
      /*
       * A `broken` account always has a `brokenSince` by construction, but the
       * TYPE allows null and `?? ""` rendered an empty date rather than saying
       * anything. A clause that admits it does not know beats one that quietly
       * prints nothing where a date belongs.
       */
      const where = input.brokenSince === null ? "on a day the record does not name" : `on ${dayWithYear(input.brokenSince)}`;
      return `${closesClause(input)}; the chain first fails ${where} — ${n} ${plural(n, "day", "days")} cannot be trusted`;
    }
    case "unverified": {
      const n = input.unverifiedDays;
      const first =
        input.unverifiedSince === null ? "a day the record does not name" : dayWithYear(input.unverifiedSince);
      /*
       * 🔴 SEVEN DAYS ONCE FELL BETWEEN THE TWO CLAUSES. On Cash on Hand this
       * read "closes to the cent through Aug 3, 2026 …; the first day it does
       * not is Aug 11, 2026", leaving Aug 4–10 in a limbo the reader has to
       * invent an explanation for — the same shape as the trust card's bare
       * "52 days" beside a date.
       *
       * ⛔ They are CARRIED, and that is a deduction rather than a guess:
       * `verifiedThrough` is the last day on a CLOSED chain, so nothing after it
       * is verified; `unverifiedSince` is the FIRST derived-unverified or gap
       * day, so nothing before it is either. One basis remains — the balance
       * held forward, which the trust card already calls "as proven as that
       * balance, and not a gap". Naming it closes the hole without new data.
       */
      const carried =
        input.verifiedThrough === null || input.unverifiedSince === null
          ? 0
          : Math.max(0, diffDays(input.verifiedThrough, input.unverifiedSince) - 1);
      const held =
        carried === 0 ? "" : `, then carries that balance forward for ${carried} ${plural(carried, "day", "days")}`;
      return `${closesClause(input)}${held}; the first day it does not is ${first} — ${n} ${plural(n, "day rests", "days rest")} on an export with no closing balance`;
    }
    case "market_value":
      return "priced from holdings; statements here set a value, they never prove the transactions add up";
    case "manual":
      return input.lastManualUpdate
        ? `you are the statement — last counted ${dayWithYear(input.lastManualUpdate)}`
        : "you are the statement — no balance recorded yet";
    case "unknown":
      return "no balances derived yet — import a statement to start the chain";
    case "verified":
      /*
       * Deliberately says nothing about whether the NEXT statement is late. It
       * used to, off a flat 45-day rule, which is not a fact about any
       * particular account: a cycle closing on the 2nd is 45 days quiet every
       * month by construction. The Statement schedule panel answers that from
       * each account's own close dates, and two panels asserting "overdue"
       * against different definitions is the shape that lets them drift apart.
       */
      return closesClause(input);
  }
}
