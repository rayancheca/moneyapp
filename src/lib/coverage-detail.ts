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
 * this one did not. And **"nothing has checked this account"** read as though
 * nothing stood behind any of its days. `verifiedThrough` was computed, carried
 * on the record, and then rendered only inside `case "verified"` — so the two
 * states that most need it were the two that could not show it.
 *
 * ⚠️ The fix then said Cash on Hand "closes to the cent through Aug 3, 2026",
 * and that was false too: Aug 3 is a balance he TYPED, and nothing was ever
 * replayed onto it (2026-09-16). A count is named as a count (`countedOn`).
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
  /**
   * `AccountCoverage.firstBalanceOn`: its first recorded balance. Unchecked days before it are
   * replayed backwards from that balance (`beforeFirstBalance`).
   *
   * ⛔ REQUIRED, like `countedOn`: a forgotten field drops the 26 days before Robinhood Agentic's
   * first balance from its row, which then reads as though nothing about it is unchecked.
   *
   * 🔴 Not `AccountCoverage.chainOpensOn`, the first day that CLOSES: with his count first and
   * statements after, that is the first statement, and the row named it as the balance the days
   * before his count were replayed from (review, 2026-10-01).
   */
  firstBalanceOn: string | null;
  /**
   * `AccountCoverage.firstBalanceIsCount`: whether that balance is one he TYPED, which the row
   * names as his. ⛔ REQUIRED, like `firstBalanceOn`.
   */
  firstBalanceIsCount: boolean;
  /**
   * first day that is `derived_unverified` or `gap` — the first unchecked day it EVER had, so
   * before `firstBalanceOn` it is the first of the days before its first balance
   */
  unverifiedSince: string | null;
  /**
   * First day of the run of unchecked days that is still OPEN, and its length.
   *
   * 🔴 The sentence below pairs a date with a count, and `unverifiedSince` is
   * the first unchecked day the account EVER had. Robinhood Cash's 52 unchecked
   * days fall in two runs 946 checked days apart — 26 of prehistory before its
   * very first anchor, 26 at the end — so "the first day it does not is Dec 5,
   * 2023 — 52 days rest on an export with no closing balance" named a
   * three-year blackout on an account whose newest statement closed 35 days
   * earlier. The date and the count have to be about the same run; the
   * account's total follows it when the two differ.
   */
  uncheckedSince: string | null;
  uncheckedRunDays: number;
  /** first day the walk actually MISSED an anchor */
  brokenSince: string | null;
  /** whole days from `verifiedThrough` to today */
  daysSinceVerified: number | null;
  lastManualUpdate: string | null;
  gapDays: number;
  unverifiedDays: number;
  /**
   * Whether any statement period has ever closed on this account — the same
   * fact the row prints beside the badge as "statements → …" or "no statements".
   *
   * 🔴 Exists because the `unverified` sentence asserted "…rest on an export
   * with no closing balance" for EVERY account, and `Cash on Hand` has no
   * export: no statement periods, no import files, one hand-entered anchor.
   * Read on 2026-09-04 the row said "no statements" and then explained itself
   * with a document, on one line.
   */
  hasStatements: boolean;
  /**
   * Whether `derivesFromHoldings` prices this account from holding events. Read
   * only by `market_value`, which covers EVERY investment account: one with no
   * events is a recorded balance held flat, and "priced from holdings" is false
   * of it.
   *
   * ⛔ REQUIRED, for the reason `hasHistory` is: an optional flag a caller
   * forgets reads `undefined`, and the row goes back to asserting holdings.
   */
  pricedFromHoldings: boolean;
  /**
   * `AccountCoverage.countedOn`: the balance he TYPED that the newest days stand
   * on, when no closed chain reaches it. Read by `unverified`.
   *
   * 🔴 Cash on Hand's row read "closes to the cent through Aug 3, 2026 (44 days
   * ago)" of the $5,000.00 he typed for that day (real ledger copy, 2026-09-16).
   * `verifiedThrough` no longer names a count; this names it as one.
   *
   * ⛔ REQUIRED, like `pricedFromHoldings`: a forgotten field would drop the
   * count and read "nothing closes to the cent from its first day" of days that
   * stand on something.
   */
  countedOn: string | null;
  /**
   * `AccountCoverage.keptOpeningOn`: the opening balance kept from a statement he un-imported that every day stands on
   * (owner decision 20). Read by `unverified`, before anything else — the account has no other balance.
   *
   * ⛔ REQUIRED, like `countedOn`: a forgotten field reads "rests on entries alone" of rows an export printed.
   */
  keptOpeningOn: string | null;
  /**
   * `AccountCoverage.balancesThrough`: the newest day with a stored balance. Read by `countFooting`,
   * for how many days his count carries when no unchecked run is open past it.
   *
   * ⛔ REQUIRED, like `countedOn`: a forgotten field drops the days carried on his count.
   */
  balancesThrough: string | null;
}

/** What `countFooting` reads — `AccountCoverage` carries every one under the same name. */
type CountFields = Pick<
  CoverageDetailInput,
  "grade" | "countedOn" | "uncheckedSince" | "uncheckedRunDays" | "balancesThrough"
>;

/** What the days of an account resting on a balance he TYPED stand on — see `countFooting`. */
export interface CountFooting {
  /** the day he counted the balance its newest days stand on */
  countedOn: string;
  /** days past the count that hold its balance, nothing posted: up to the open run, else to the newest day */
  carriedDays: number;
  /** first day of the unchecked run still open past the count; null when nothing past it is unchecked */
  uncheckedSince: string | null;
  /** …and that run's length, 0 with no run */
  uncheckedDays: number;
}

/**
 * What the days of an account resting on a balance he TYPED stand on — the ONE reading every
 * sentence about his count is worded from — or null when they do not rest on his count.
 *
 * 🔴 THREE COPIES, TWO RULES. Net worth's line, the dashboard card's row and /imports' row
 * each said this, and /imports chose its unchecked days the way an account with no count does:
 * the open run, else the FIRST unchecked day the account ever had (`unverifiedSince`). On a
 * card with rows before his count — replayed backwards from it, unchecked — and nothing
 * unchecked past it, that read "the first day past that count is Jul 27, 2026" of a count made
 * on Aug 1, dropped the 9 days the count carried, and disagreed with "nothing else checks it"
 * on the other two surfaces (§6A 28 review, measured through `addManualAnchor` and
 * `rebuildAccount`). Days before the count are prehistory; a "since" is about the run still
 * open (`AccountCoverage.uncheckedSince`), and with none, nothing else checks it.
 *
 * ⚠️ `carriedDays` is day arithmetic, as the row's other carry is: every day past his count
 * that is not unchecked is carried on it, because a later count or statement would be the
 * newer footing (`AccountCoverage.countedOn`).
 */
export function countFooting(c: CountFields): CountFooting | null {
  if (c.grade !== "unverified" || c.countedOn === null) return null;
  if (c.uncheckedSince !== null) {
    return {
      countedOn: c.countedOn,
      carriedDays: Math.max(0, diffDays(c.countedOn, c.uncheckedSince) - 1),
      uncheckedSince: c.uncheckedSince,
      uncheckedDays: c.uncheckedRunDays,
    };
  }
  return {
    countedOn: c.countedOn,
    carriedDays: c.balancesThrough === null ? 0 : Math.max(0, diffDays(c.countedOn, c.balancesThrough)),
    uncheckedSince: null,
    uncheckedDays: 0,
  };
}

/**
 * What an account whose days rest on a balance he TYPED says about itself in one line — net
 * worth's line for it, the dashboard card's row and its line in "what you owe", each through
 * `unverifiedDetail` — or null when they do not rest on his count. /imports says the same
 * `countFooting` at length.
 *
 * 🔴 Net worth said "nothing checks it since Aug 11, 2026" of Cash on Hand, whose days before
 * Aug 11 stand on nothing but the $5,000.00 he typed for Aug 3 (real ledger copy, 2026-09-16) —
 * "since" said something checked them. The count is named as his.
 *
 * ⛔ Shared because the second surface said it the old way: the dashboard's "what you owe" row
 * wrote "nothing has checked it since Aug 4 — 6 days ago" of a card resting on his count, and
 * dated it `unverifiedSince`, so a charge before the count, replayed backwards from it, became
 * the day checking stopped (§6A 28 review). Here, beside /imports' row, because that row is the
 * third surface and it had kept its own rule. `formatDay` is only each surface's voice for a
 * date, so the card can age its dates without re-wording them.
 */
export function countedDetail(c: CountFields, formatDay: (iso: string) => string): string | null {
  const count = countFooting(c);
  if (count === null) return null;
  const counted = `you counted it on ${formatDay(count.countedOn)}`;
  return count.uncheckedSince === null
    ? `${counted}, and nothing else checks it`
    : `${counted}, and nothing checks it since ${formatDay(count.uncheckedSince)}`;
}

/** What `unverifiedDetail` reads — `AccountCoverage` carries every one under the same name. */
type UnverifiedFields = CountFields &
  Pick<CoverageDetailInput, "verifiedThrough" | "unverifiedSince" | "firstBalanceOn" | "firstBalanceIsCount">;

/** A verified account's unchecked days, all before its first balance — `beforeFirstBalance`. */
export interface BeforeFirstBalance {
  /** the last day on the closed chain — the day "checked through" names */
  checkedThrough: string;
  /** its first recorded balance, the one those days are replayed backwards from */
  firstBalanceOn: string;
  /** whether that balance is one he typed — then the days stand on his word, and he is named */
  firstBalanceIsCount: boolean;
}

/**
 * Where a `verified` account's unchecked days are: before its first balance, replayed backwards from
 * it — the ONE reading net worth's line ("adds up through <day>, and unchecked days before that",
 * `beforeFirstBalanceDetail`), the dashboard card's note and proof line and /imports' row are worded
 * from. Null when it has none, and for every other grade.
 *
 * ⚖️ His answer, 2026-10-05 (§6A 35): those days alone do not make an account one nothing is
 * checking, so `accountCoverage` grades it by the days its balance rests on and this is a `verified`
 * account's reading. It was an `unverified` one's, and /imports' header had to count around it
 * ("3 accounts nothing is checking" of Robinhood Agentic, Robinhood Cash and Cash on Hand on a copy
 * of his ledger); net worth counted Agentic among "3 have nothing checking them" all along. An
 * `unverified` account rests on unchecked days of its own — his count, or a run still open — so it
 * is never this reading (§6A 36 kept the words).
 *
 * 🔴 TWO RULES, ONE ACCOUNT. /imports chose its unchecked days as it had before the run fields
 * existed — the open run, else `unverifiedSince` — and named that day as where it stops closing.
 * Robinhood Agentic read "closes to the cent through Aug 31, 2026 (31 days ago); the first day it
 * does not is Jun 4, 2026" (a copy of his ledger, 2026-10-01): Jun 4–29 are replayed backwards
 * from its first balance, the Jun 30 statement, and nothing past Aug 31 is unchecked. Net worth
 * already said "checked through Aug 31, 2026, and unchecked days before that" of it.
 *
 * ⛔ What each date is: `verifiedThrough` the last day on the closed chain; `firstBalanceOn` the
 * first balance it records, which the rebuild replays backwards from; `uncheckedSince` the first of
 * the run still open, the only unchecked days past the chain; `unverifiedSince` the first unchecked
 * day the account EVER had — before its first balance, the first of the days before it, never a
 * day it stopped closing.
 *
 * 🔴 `firstBalanceOn`, not `AccountCoverage.chainOpensOn`: the first day that CLOSES is a later day
 * when the first balance is his count, which closes nothing — the next statement, or the day after
 * his count when a replay from it lands on one. Read off `chainOpensOn`, the row named that day as
 * the balance the days before his count were replayed from (review, 2026-10-01).
 *
 * ⚠️ Every unchecked day lies before its first balance, not only the first: past it the replay
 * writes one only going forward (`deriveForward`), and that run reaches the newest day, so it would
 * be the run still open — and the grade `unverified`. The first day is checked anyway, so the words
 * cannot name a day after it.
 */
export function beforeFirstBalance(c: UnverifiedFields): BeforeFirstBalance | null {
  if (c.grade !== "verified" || c.uncheckedSince !== null) return null;
  const { verifiedThrough, unverifiedSince, firstBalanceOn } = c;
  if (verifiedThrough === null || unverifiedSince === null || firstBalanceOn === null) return null;
  if (unverifiedSince >= firstBalanceOn) return null;
  return { checkedThrough: verifiedThrough, firstBalanceOn, firstBalanceIsCount: c.firstBalanceIsCount };
}

/**
 * What a `verified` account's line ends with when it has days before its first balance — ", and
 * unchecked days before that" — or "" when it has none (`beforeFirstBalance`).
 *
 * ⚖️ His answer, 2026-10-05: the line reads with its verified neighbours' verb. So the days are a
 * clause after the line each surface already gives a verified account — net worth's "adds up
 * through <day>", "what you owe"'s proof "checked through <day>" — never a line with a verb of its
 * own beside them.
 */
export function beforeFirstBalanceClause(c: UnverifiedFields): string {
  return beforeFirstBalance(c) === null ? "" : ", and unchecked days before that";
}

/**
 * `beforeFirstBalance` in one line — net worth's line for a `verified` account with days before its
 * first balance, which the trust card prints, and the dashboard card's quiet note under its row — or
 * null when it has none. /imports says the same days at length (`beforeRow`).
 *
 * ⚖️ His answer, 2026-10-05: in the verb of the verified accounts beside it, "adds up through Aug 31,
 * 2026, and unchecked days before that". It kept the words `unverifiedDetail` gave the account while
 * those days graded it `unverified` (§6A 35–36), so under "adds up" Robinhood Agentic read "checked
 * through Aug 31, 2026, …" where every other verified account reads "adds up through <day>".
 * /imports' row keeps its words (§6A 36): it is this reading at length, not this line.
 */
export function beforeFirstBalanceDetail(
  c: UnverifiedFields,
  formatDay: (iso: string) => string,
): string | null {
  const before = beforeFirstBalance(c);
  if (before === null) return null;
  return `adds up through ${formatDay(before.checkedThrough)}${beforeFirstBalanceClause(c)}`;
}

/**
 * What an `unverified` account says about itself in one line — net worth's line for it, which the
 * trust card prints, and the dashboard card's row and its line in "what you owe" — or null for any
 * other grade. His count first (`countedDetail`); then the run still open.
 *
 * 🔴 TWO COPIES, TWO DATES. Net worth dates "since" from the run still open
 * (`AccountCoverage.uncheckedSince`) since Robinhood Cash read "nothing checks it since Dec 5,
 * 2023 · 52 days unchecked" of an account whose newest statement had closed 35 days before. The
 * card kept its own copy of the line and still dated it from `unverifiedSince`, the first
 * unchecked day the account EVER had: "nothing has checked it since Jul 19 — 22 days ago" of a
 * card two statements checked, the newer on Aug 5, because its export reached back before the
 * first of them — where net worth said "checked through Aug 5, 2026, and unchecked days before
 * that" (§6A 28 review, through `rebuildAccount`). `formatDay` is each surface's voice for a date.
 *
 * ⚖️ With no run open, the days before its first balance were the third branch here, until his
 * answer of 2026-10-05 (§6A 35) graded such an account `verified`: its line is
 * `beforeFirstBalanceDetail` now, in its verified neighbours' verb ("adds up through …").
 *
 * ⚠️ So an `unverified` account with neither his count nor a run open gets no sentence: none is
 * one `accountCoverage` gives, since it grades by the unchecked days past the first balance — the
 * run still open — and an account nothing closes rests on his count (`countedOn`). Measured on the
 * pristine e2e fixture and on it after the suite (2026-10-05): none.
 */
export function unverifiedDetail(
  c: UnverifiedFields,
  formatDay: (iso: string) => string,
): string | null {
  if (c.grade !== "unverified") return null;
  const counted = countedDetail(c, formatDay);
  if (counted !== null) return counted;
  if (c.uncheckedSince !== null) return `nothing checks it since ${formatDay(c.uncheckedSince)}`;
  return null;
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
  /*
   * 🔴 "nothing has closed on this account yet" — said of Robinhood Cash, which
   * has 33 statement anchors and 32 reconciled periods listed on the same page.
   * `verifiedThrough` is null because the chain is unproven from the account's
   * FIRST day (52 days from Dec 5, 2023 rest on an export with no closing
   * balance), not because nothing ever closed. Say the true thing.
   */
  if (input.verifiedThrough === null) return "nothing closes to the cent from its first day";
  const ago = agoPhrase(input.daysSinceVerified);
  const dated = dayWithYear(input.verifiedThrough);
  return ago === null ? `closes to the cent through ${dated}` : `closes to the cent through ${dated} (${ago})`;
}

/**
 * The row for an account whose days rest on a balance he TYPED — `countFooting` said at length:
 * what closes before the count, the count, the days it carries, and the run still open past it.
 *
 * 🔴 HIS COUNT IS NOT A CLOSED CHAIN. Cash on Hand read "closes to the cent through Aug 3, 2026
 * (44 days ago), then carries that balance forward for 7 days; the first day it does not is Aug
 * 11, 2026" of the $5,000.00 he typed for Aug 3 — nothing was ever replayed onto it (real ledger
 * copy, 2026-09-16). The row says what the days stand on.
 */
function countedRow(
  input: CoverageDetailInput,
  restsOn: CountFooting,
  resting: (unchecked: number) => string,
): string {
  const opening =
    input.verifiedThrough === null ? "nothing closes to the cent: it rests on" : `${closesClause(input)}, then rests on`;
  const carried = restsOn.carriedDays;
  const held = carried === 0 ? "" : `, carried forward for ${carried} ${plural(carried, "day", "days")}`;
  const count = `${opening} the balance you counted on ${dayWithYear(restsOn.countedOn)}${held}`;
  if (restsOn.uncheckedSince === null) return `${count}, and nothing else checks it`;
  const first = dayWithYear(restsOn.uncheckedSince);
  return `${count}; the first day past that count is ${first} — ${resting(restsOn.uncheckedDays)}`;
}

/**
 * The row for an account whose unchecked days all lie before its first balance — `beforeFirstBalance`
 * said at length: what closes, then those days, counted, and what they stand on.
 *
 * ⛔ Not `resting`'s reason. An export with no closing balance, or his entries with no document, is
 * what the run past a chain stands on; what the days before a first balance lack is an EARLIER one.
 * Robinhood Agentic's one row there is the Jun 5 transfer its June statement printed — no export.
 *
 * ⚠️ A count is named as a count: when the first balance is one he typed, the days before it were
 * replayed from his word, and "on <day>" alone reads as a balance a document recorded.
 */
function beforeRow(input: CoverageDetailInput, before: BeforeFirstBalance): string {
  // every unchecked day it has: `beforeFirstBalance` says why none is past its first balance
  const n = input.unverifiedDays;
  const first = dayWithYear(before.firstBalanceOn);
  const balance = before.firstBalanceIsCount ? `the one you counted on ${first}` : `on ${first}`;
  const days = `the ${n} ${plural(n, "day", "days")} before its first balance, ${balance}`;
  const why = `replayed backwards from it, with nothing earlier to check ${plural(n, "it", "them")} against`;
  return `${closesClause(input)}; ${days}, ${plural(n, "is", "are")} unchecked — ${why}`;
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
      /*
       * ⚖️ An account whose only balance is the opening of a statement he un-imported (owner decision 20,
       * 2026-09-17): Wells Fargo Everyday Checking, once 2026-08-25-everyday-checking.pdf is un-imported, keeps its
       * rows under the Rocket Money export and replays them from the $0.00 that statement printed for Jul 26, 2026.
       * Every day is unchecked, and the row says on what, never "closes".
       */
      if (input.keptOpeningOn !== null) {
        const n = input.unverifiedDays;
        return `nothing closes to the cent: it rests on the opening balance of a statement you un-imported, printed for ${dayWithYear(input.keptOpeningOn)} — ${n} ${plural(n, "day rests", "days rest")} on it, and nothing checks ${plural(n, "it", "them")}`;
      }
      /*
       * ⛔ WHY the days are unchecked depends on what the account HAS. Robinhood
       * Cash has 33 statement anchors and its loose days really do rest on an
       * export that carried no closing figure. Cash on Hand has no document of
       * any kind — its days rest on the entries the owner typed, and naming a
       * document there invents one.
       */
      const because = input.hasStatements
        ? "on an export with no closing balance"
        : "on entries alone, with no document to check them against";
      // the unchecked days a row names, and the prehistory they leave out, so this row and the
      // trust card's "26 days unchecked, of 52 in all" reconcile
      const resting = (n: number): string =>
        `${n} ${plural(n, "day rests", "days rest")} ${because}` +
        (n === input.unverifiedDays ? "" : `, of ${input.unverifiedDays} unchecked in all`);
      const restsOn = countFooting(input);
      if (restsOn !== null) return countedRow(input, restsOn, resting);
      // ⚖️ the days before its first balance alone are a `verified` account's (§6A 35), worded there
      const run = input.uncheckedRunDays > 0;
      const n = run ? input.uncheckedRunDays : input.unverifiedDays;
      const since = run ? input.uncheckedSince : input.unverifiedSince;
      const first = since === null ? "a day the record does not name" : dayWithYear(since);
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
      const heldFrom = input.verifiedThrough;
      const carried = heldFrom === null || since === null ? 0 : Math.max(0, diffDays(heldFrom, since) - 1);
      const carriedDays = `${carried} ${plural(carried, "day", "days")}`;
      const held = carried === 0 ? "" : `, then carries that balance forward for ${carriedDays}`;
      return `${closesClause(input)}${held}; the first day it does not is ${first} — ${resting(n)}`;
    }
    case "market_value":
      return input.pricedFromHoldings
        ? "priced from holdings; statements here set a value, they never prove the transactions add up"
        : "held at its recorded balance; no holdings price it, and no transaction arithmetic checks it";
    case "manual":
      return input.lastManualUpdate
        ? `you are the statement — last counted ${dayWithYear(input.lastManualUpdate)}`
        : "you are the statement — no balance recorded yet";
    case "unknown":
      return "no balances derived yet — import a statement to start the chain";
    case "verified": {
      /*
       * Deliberately says nothing about whether the NEXT statement is late. It
       * used to, off a flat 45-day rule, which is not a fact about any
       * particular account: a cycle closing on the 2nd is 45 days quiet every
       * month by construction. The Statement schedule panel answers that from
       * each account's own close dates, and two panels asserting "overdue"
       * against different definitions is the shape that lets them drift apart.
       *
       * ⚖️ What closes, then the days before its first balance when it has any: Robinhood Agentic's
       * row reads word for word as it did while those days alone graded it `unverified` (§6A 35–36).
       */
      const before = beforeFirstBalance(input);
      return before === null ? closesClause(input) : beforeRow(input, before);
    }
  }
}
