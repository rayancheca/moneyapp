import { cache } from "react";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts, type AccountType } from "@/db/schema/accounts";
import { KEPT_OPENING_SOURCE, balanceAnchors, dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { countFooting } from "@/lib/coverage-detail";
import { addDays, diffDays, todayIso } from "@/lib/dates";
import { ACCOUNT_ORDER } from "./account-order";
import { handTypedDays, keptOpeningOf, pickWinners } from "./anchor-winners";

/**
 * Per-account answer to "is this account's money actually checked, and through
 * when?" — deliberately a DIFFERENT question from "does it have statements".
 *
 * The app already showed statement coverage and nothing else, which reads as a
 * hole wherever the owner uploads irregularly and reads as fine wherever an
 * account has no arbiter at all. Both readings are wrong, in opposite
 * directions:
 *
 *  - Chase Checking has a 22-month stretch with no statement, yet every one of
 *    its days is `derived` and none is `gap` — its CSV closes the anchor chain
 *    exactly (derivation.ts:209), so the money IS checked, just coarsely.
 *  - Robinhood Brokerage has no arbiter of any kind, yet every day reads
 *    `derived` — because for investment accounts that word is written by
 *    crypto-history.ts:124 and means "prices were fresh", nothing more.
 *
 * Hence the type branch below: `daily_balances.basis` is only evidence of
 * arithmetic for accounts whose basis comes from the transaction walk.
 */

export type CoverageGrade =
  /** the transaction walk closes on every anchor, right up to `verifiedThrough` */
  | "verified"
  /** replayed past the last anchor with nothing left to check against */
  | "unverified"
  /** the walk did NOT land on an anchor — money is provably missing or doubled */
  | "broken"
  /** investment: value is marked to market and reconciliation cannot fail */
  | "market_value"
  /** no transactions ever — the owner is the statement */
  | "manual"
  /** no derived cache yet (new or never imported) */
  | "unknown";

/**
 * Whether a day's balance is CHECKED — the one place that decides, because two
 * surfaces already answered it differently.
 *
 * ⛔ `carried` is checked. `deriveForward` writes `sawTxn ? "derived_unverified"
 * : "carried"`, so a carried day means nothing posted since the last recorded
 * balance and the number is exactly as proven as the anchor it came from;
 * between two anchors it is written only when the two AGREE.
 * `provenance.ts::BASIS_VERDICT` grades it `derived` for that reason and its
 * docstring says reading it as weak is "the first thing this service got
 * wrong". The dashboard says the same in words: "786 days had no activity to
 * replay, so the balance before them was carried forward — as proven as that
 * balance, and not a gap."
 *
 * 🔴 `/accounts/[id]` kept its own copy as `{anchored, derived}` and dropped
 * `carried` with it. The confirmation for removing a recorded balance —
 * destructive, with no undo — then offered "Days that stop being verified: 1
 * day" for Cash on Hand's 2026-08-03 anchor, whose span is 1 anchored day, 7
 * carried and 1 unverified: the answer is 8, and /imports says so on the same
 * ledger ("…then carries that balance forward for 7 days"). Measured
 * 2026-09-08: 24 of the 220 recorded balances on cash accounts understated their
 * own blast radius, the worst by 61 days.
 *
 * ⚠️ "Checked" here means the day RESTS on something — it is not a claim that
 * anything closed. That Aug 3 balance is one he typed, and `closedChainDays`
 * decides that it closes nothing.
 */
export function basisIsChecked(basis: BalanceBasis): boolean {
  return basis === "anchored" || basis === "derived" || basis === "carried";
}

/**
 * Whether a chart may draw one account's day as an exact figure — solid, not
 * broken or dashed. `basisIsChecked`, behind the type branch `accountCoverage`
 * takes first.
 *
 * ⛔ An investment account's `carried` is not a cash account's. There it is a
 * CARRIED PRICE: `rebuildInvestmentHistory` writes it when a held symbol had no
 * close that day, and value-anchor step-hold writes it for a recorded value held
 * flat across a market that moved. Only `anchored` and `derived` (every close
 * real) are exact figures there, and even those are market value rather than
 * arithmetic, which is `accountCoverage`'s question, not this one.
 *
 * 🔴 The dashboard's chart modes kept a third local `{anchored, derived}` set,
 * and /accounts/[id]'s balance chart a fourth. Measured 2026-09-15 on the
 * owner's ledger: the terrain announced "118 spans are drawn broken, because the
 * ledger cannot verify them" at 104 columns, Chase Sapphire's rail read "+$82.72
 * since Feb 2025 · 1 unverified" and its Sep 15 slug "this day is estimated",
 * and the Owed line went dashed Sep 3 – 15 — all over 13 stored `carried` days
 * resting on the Sep 2 statement with nothing posted since. The trust card on
 * the same page calls those days "as proven as that balance, and not a gap",
 * and the hero's own net-worth series already drew them solid.
 */
export function balanceDayIsExact(accountType: AccountType, basis: BalanceBasis): boolean {
  if (accountType === "investment") return basis === "anchored" || basis === "derived";
  return basisIsChecked(basis);
}

/**
 * The days whose balance rests on a CLOSED chain — `derived`, or `anchored` by a
 * balance something other than the owner's own count stands behind.
 *
 * 🔴 EVERY `anchored` DAY COUNTED, including one he typed. Measured 2026-09-16
 * on a copy of the real ledger: Cash on Hand's only balance is the $5,000.00 he
 * typed for Aug 3, 2026 (no statement period, no import file), and nothing was
 * ever replayed onto it — yet it was `verifiedThrough` 2026-08-03, so /imports
 * read "closes to the cent through Aug 3, 2026 (44 days ago)" and the account's
 * balance popover "Checked through 2026-08-03". A count is his evidence
 * (`manual`, "you entered it"); it is not a check.
 *
 * ⛔ A typed balance IS checked when a closed span reaches it: the replay from
 * the previous balance landed exactly on his number (`derived` the day before),
 * or nothing posted and the previous balance agreed (`carried` the day before —
 * which only ever sits between two recorded balances that agree) — AND, either
 * way, that previous balance was itself checked. Two counts of his agreeing
 * check nothing. A day `pickWinners` gives to a statement or a bank export is
 * theirs, not his.
 *
 * ⚠️ Conservative where the cache cannot say: when his balance is recorded the
 * day right after another one (no day between), `deriveCashSpans` writes no
 * row that shows whether the replay landed, so the day is not counted.
 *
 * Reads the stored rows as given, oldest first; the row before a day is the
 * previous stored day. `chainFooting` is the rule; this is its closed half.
 */
export function closedChainDays(
  balances: readonly { day: string; basis: BalanceBasis }[],
  handTyped: ReadonlySet<string>,
): Set<string> {
  return chainFooting(balances, handTyped).closed;
}

/** What a cash account's stored days stand on — see `chainFooting`. */
export interface ChainFooting {
  /** days on a closed chain, oldest first — `closedChainDays` */
  closed: Set<string>;
  /**
   * Days that stand on a count of his and nothing else: a count no closed span
   * reaches, a replay from such a count onto another count of his, and a day
   * carried from such a count. `carried` from a balance that closes is in
   * neither set: it is checked (`basisIsChecked`) without being a closed day.
   */
  counted: Set<string>;
}

/**
 * The ONE walk that decides which days close and which rest only on his count.
 *
 * 🔴 A SPAN BETWEEN TWO OF HIS COUNTS CLOSED. Every `derived` day counted, and
 * so did his count at its end, so a count, a row he entered and a second count
 * agreeing with them read as a checked chain. Measured 2026-09-16 on a copy of
 * the real ledger: recording Cash on Hand at $0.00 for Aug 12, 2026 through
 * `addManualAnchor` (after the $5,000.00 car down payment he entered by hand on
 * Aug 11) made Aug 4–11 `derived`, and the account read `verified` through Aug
 * 12 — "closes to the cent through Aug 12, 2026" on /imports, "8 of 13 accounts
 * add up against a document" in net worth — with no document at all.
 *
 * ⛔ Decided per span, not per row: a replay closes unless it runs from a count
 * of his that nothing closes onto another count of his — a balance he typed
 * never reads "checked" on his own word, however many times he gives it. A
 * replay onto a statement closes whatever it starts from; a replay from a
 * balance that closed carries that check to the count it lands on — the rule
 * `carried` already followed.
 *
 * ❓ The owner's call, still open: whether rows IMPORTED from a document between
 * two of his counts make the span a check. This takes the conservative answer
 * (they do not); the other is to close a span with at least one imported row.
 *
 * ⚠️ A replay with no recorded balance after it in the rows given (a sparse
 * fixture; the rebuild never writes one) closes, as every `derived` day did.
 */
export function chainFooting(
  balances: readonly { day: string; basis: BalanceBasis }[],
  handTyped: ReadonlySet<string>,
): ChainFooting {
  const closed = new Set<string>();
  const counted = new Set<string>();
  // whether the newest recorded balance closes; null before the first one
  let anchorClosed: boolean | null = null;
  let before: BalanceBasis | undefined;
  let replay: string[] = [];
  for (const b of balances) {
    if (b.basis === "derived") {
      replay = [...replay, b.day];
      before = b.basis;
      continue;
    }
    const onCount = b.basis === "anchored" && handTyped.has(b.day);
    const replayCloses: boolean = !(anchorClosed === false && onCount);
    for (const day of replay) (replayCloses ? closed : counted).add(day);
    replay = [];
    if (b.basis === "anchored") {
      const isClosed: boolean =
        !onCount || (before === "derived" && replayCloses) || (before === "carried" && anchorClosed === true);
      (isClosed ? closed : counted).add(b.day);
      anchorClosed = isClosed;
    } else if (b.basis === "carried" && anchorClosed === false) {
      counted.add(b.day);
    }
    before = b.basis;
  }
  for (const day of replay) closed.add(day);
  return { closed, counted };
}

/** Where a figure resting on one account stops being checked — `footingThrough`. */
export interface Footing {
  /** the last day the account's balances still stand on something */
  day: string;
  /**
   * The day of the balance he TYPED that `day` stands on, when nothing closes on it — his word, not a check; null
   * when `day` is a check's.
   *
   * 🔴 A boolean once, and the sentence said "the balance you counted" of whichever count the reader had in mind: a
   * wallet he recounted read it beside a proof naming his OTHER count (temp ledger 2026-10-06 — Aug 20's proof "…from
   * the balance you counted on Aug 3, 2026 and landed exactly on the one you counted on Sep 1, 2026", then "…is the
   * last day Cash on Hand rests on the balance you counted"; Sep 9 stands on Sep 1's). Named by its day, as /imports'
   * row names it ("it rests on the balance you counted on Aug 3, 2026").
   */
  countedOn: string | null;
  /**
   * The day the account stopped adding up, when that is why the figure stops at `day`, the day before; null
   * otherwise. A count's only: a chain that closed stops at its own `verifiedThrough`, a check.
   */
  brokeOn: string | null;
}

/**
 * The last day an account's balances still stand on something, for a figure
 * that "stops being proven at the first account that stops being checked" —
 * whether that day is his count's rather than a check's, and the day his count
 * broke when that is why it stops there. Null for an account with no chain to
 * stop (`market_value`, `manual`, `unknown`), and for one nothing ever stood under.
 *
 * 🔴 A COUNT LEFT THE COMPARISON ALTOGETHER. Once his count stopped being a
 * `verifiedThrough`, net worth filtered Cash on Hand out of "the oldest
 * account" and its date ran past the day the same popover calls unchecked.
 * Measured 2026-09-16 on a copy of the real ledger with SoFi (the Jul 31 bound)
 * set aside: "Checked through 2026-08-12" beside "Cash on Hand — you counted it
 * on Aug 3, 2026, and nothing checks it since Aug 11, 2026".
 *
 * ⛔ A count bounds the picture at the day before nothing stands under it, and
 * the sentence that prints the date says that day is his word (`netWorth`). An
 * account resting on his count to its newest day bounds nothing, exactly as an
 * account he counts outright (`manual`) does not — unless it broke (below).
 *
 * ❓ The owner's call, still open: the other answer keeps the count out of the
 * date and has the sentence say an account nothing ever checked is left out.
 * This one is taken because it never dates the picture past a day the same
 * popover calls unchecked.
 *
 * 🔴 TWO RULES FOR ONE WALLET. The count branch took a `broken` account as if his
 * count still stood, while `countFooting` — the reading every sentence about his
 * count is worded from — refuses one. Measured 2026-10-05 on a temp ledger
 * through the real services ($5,000.00 counted for Aug 3, −$5,000.00 on Aug 11, a
 * $40.00 recount for Sep 1, −$10.00 on Sep 10): "2 transactions landed", net
 * worth and the trust card read "Checked through 2026-09-09 … rests on the balance
 * you counted" beside net worth's own line "stopped adding up on Aug 4, 2026",
 * and its balance proof printed no date. With nothing spent past the recount, the
 * wallet bounded nothing at all.
 *
 * ⚖️ His answer, 2026-10-05: a typed-balance account that BREAKS bounds every
 * "checked through" date the day before it broke, and the sentence says it broke
 * after that — as a statement chain's `verifiedThrough` stops before its break.
 * ⛔ Only where nothing ever closed (a closed chain has its own `verifiedThrough`):
 * then every balance is a count of his, and a `gap` span lies strictly between two
 * of them, so the day before `brokenSince` is his count's own day.
 */
export function footingThrough(c: AccountCoverage): Footing | null {
  if (c.grade !== "verified" && c.grade !== "unverified" && c.grade !== "broken") return null;
  if (c.verifiedThrough !== null) return { day: c.verifiedThrough, countedOn: null, brokeOn: null };
  if (c.grade === "broken") {
    if (c.countedOn === null || c.brokenSince === null) return null;
    // the day before the break is his count's own (above) — NOT `countedOn`, his newest, the recount it missed
    const day = addDays(c.brokenSince, -1);
    return { day, countedOn: day, brokeOn: c.brokenSince };
  }
  // his count, as every sentence about it reads it: it stands until the run still open past it
  const count = countFooting(c);
  if (count === null || count.uncheckedSince === null) return null;
  return { day: addDays(count.uncheckedSince, -1), countedOn: count.countedOn, brokeOn: null };
}

export interface AccountCoverage {
  accountId: string;
  accountName: string;
  accountType: string;
  grade: CoverageGrade;
  /** last day whose balance rests on a closed arithmetic chain — never a balance he typed that nothing checks */
  verifiedThrough: string | null;
  /**
   * The balance he TYPED that the account's newest days stand on, when no closed
   * chain reaches it and nothing closes after it — the day he counted it. Null
   * otherwise, and always for `manual`, `market_value` and `unknown` grades.
   *
   * Published so a sentence that used to say "closes to the cent through <day>"
   * of that count can say what the day is instead (see `closedChainDays`).
   */
  countedOn: string | null;
  /**
   * The day of the opening balance kept from a statement he un-imported that the account's days stand on — the only
   * balance it records (`keptOpeningOf`, owner decision 20). Every day it carries is `derived_unverified`, so the
   * grade is `unverified` and nothing is `verifiedThrough`; this names what the days rest on. Null otherwise.
   */
  keptOpeningOn: string | null;
  /**
   * The day the checked chain opens on: the account's first trusted day — its
   * first recorded balance, unless that balance is his count, which closes
   * nothing (see `firstBalanceOn`). Null when nothing is checked at all.
   *
   * 🔴 Days BEFORE it are prehistory, replayed backwards from that balance with
   * nothing earlier to check them against — and `verifiedThrough` below
   * deliberately does not call them a break, so a row there sat "on or before
   * verifiedThrough" and a total counted it checked. Measured 2026-09-15:
   * Robinhood Cash opens 2023-12-05, its first recorded balance is 2023-12-31,
   * and `/accounts/<Robinhood Cash>` read "2,387 of 2,392 checked" while the Dec
   * 6 and Dec 7, 2023 rows each read "nothing checks the total it sits in" on
   * their own sheet. `provenance.rowGrade` reads this so the two agree.
   *
   * ⚠️ Inclusive, like `verifiedThrough`: a row ON the opening day counts as
   * checked. No such row exists on the real ledger or the e2e fixture
   * (2026-09-15), so the stricter reading has nothing to decide yet.
   */
  chainOpensOn: string | null;
  /**
   * The account's first recorded balance: its first `anchored` day, the endpoint the rebuild
   * replays backwards from (`deriveBackward`), so every day before it is replayed from THIS
   * balance. Null when no day is `anchored` (an opening kept from a statement he un-imported is
   * not, `keptOpeningOn`), and always for `manual`, `market_value` and `unknown` grades.
   *
   * 🔴 Not `chainOpensOn`, the first day that CLOSES. A balance he typed closes nothing when the
   * day before it is replayed backwards from it (`chainFooting` counts it as his word), so with
   * his count first and statements after, the chain opens on the next statement — or, when a
   * replay from his count lands on one, on the day after his count, which records no balance at
   * all. /imports named that day as the balance the days before his count were replayed from
   * (review of the first-balance row, 2026-10-01; no such account on his ledger that day).
   */
  firstBalanceOn: string | null;
  /** whether `firstBalanceOn` is a balance he TYPED (`handTypedDays`) — a count is named as his */
  firstBalanceIsCount: boolean;
  /** first day the chain stopped being checkable */
  unverifiedSince: string | null;
  /**
   * First day the walk actually MISSED an anchor — the start of `days.gap`,
   * which is a different population from `unverifiedSince`.
   *
   * `unverifiedSince` is the first day that is `derived_unverified` OR `gap`,
   * so on an account that was replayed past its earliest anchor before any
   * break, the two are years apart: Robinhood Cash reports `unverifiedSince`
   * 2023-12-05 (26 days of prehistory before its first anchor) while every one
   * of its 264 gap days is 2025-11 or later. Pairing the first date with the
   * second count — which is exactly what the coverage panel printed — names an
   * innocent date as the moment the money stopped adding up.
   */
  brokenSince: string | null;
  /**
   * First day of the CURRENT run of unchecked days — the one that reaches the
   * newest day the account has a balance for. Null when the newest day is
   * checked.
   *
   * 🔴 The same trap `brokenSince` was written for, one field over and still
   * live. `unverifiedSince` is the FIRST unchecked day the account ever had, and
   * the coverage row pairs it with a count of every unchecked day:
   *
   *     Robinhood Cash — nothing checks it since Dec 5, 2023 · 52 days unchecked
   *
   * read on 2026-09-04 of an account with 32 statement anchors, the newest
   * closing 2026-07-31 — 35 days earlier. Its 52 unchecked days fall in two
   * runs with 946 checked days between them: 2023-12-05→2023-12-30, which is
   * prehistory before its very first anchor, and 2026-08-03→2026-08-28. The
   * sentence claimed a 1,004-day blackout, and its own neighbour on the card
   * ("Cash on Hand — nothing checks it since Aug 11, 2026 · 1 day unchecked")
   * was coherent, so the two rows were built from dates that meant different
   * things.
   */
  uncheckedSince: string | null;
  /** length of that run — what "since" is actually about */
  uncheckedRunDays: number;
  /**
   * The newest day the account has a stored balance for — where the derived cache ends. Null
   * with no balances.
   *
   * 🔴 Published because nothing said where the days carried on his count END. With no run
   * open past the count, they run from it to this day, and /imports' row named a day BEFORE
   * the count instead — "the first day past that count is Jul 27, 2026" of a card counted on
   * Aug 1 — and dropped the 9 days the count carried (§6A 28 review). `countFooting` reads it.
   */
  balancesThrough: string | null;
  /** newest statement period end, or null if the account has never had one */
  statementsThrough: string | null;
  /** when the owner last typed a balance in by hand (manual accounts) */
  lastManualUpdate: string | null;
  /** days between `verifiedThrough` and today; null when nothing is verified */
  daysSinceVerified: number | null;
  days: Record<BalanceBasis, number>;
}

function emptyDays(): Record<BalanceBasis, number> {
  return { anchored: 0, derived: 0, derived_unverified: 0, carried: 0, gap: 0 };
}

/**
 * ⚡ MEMOISED FOR ONE SERVER RENDER — see `buildPortfolio` in
 * `services/portfolio` for why `react`'s `cache` and not a module-level Map.
 * Measured seven calls at 2.8ms per dashboard render on the owner's ledger.
 */
const accountCoverageCached = cache(function accountCoverageCached(
  db: AppDatabase,
  today: string,
): AccountCoverage[] {
  const rows = db
    .select({ id: accounts.id, name: accounts.name, type: accounts.type })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.isActive, true))
    // THE order: the net-worth popover and ConcentrationCard print these as they come
    .orderBy(...ACCOUNT_ORDER)
    .all();

  return rows.map((account) => {
    // ordered in SQL rather than by compareDates: ISO dates sort lexicographically
    // the same way they sort chronologically, and compareDates was measured at
    // 92.7% of dashboard CPU in pass 31 — no reason to re-enter it here
    const balances = db
      .select({ day: dailyBalances.day, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, account.id))
      .orderBy(dailyBalances.day)
      .all();

    const days = emptyDays();
    for (const b of balances) days[b.basis] += 1;

    const statementsThrough =
      db
        .select({ periodEnd: statementPeriods.periodEnd })
        .from(statementPeriods)
        .where(eq(statementPeriods.accountId, account.id))
        .orderBy(desc(statementPeriods.periodEnd))
        .limit(1)
        .get()?.periodEnd ?? null;

    // every recorded balance, newest first: the newest dates `lastManualUpdate`,
    // and the day winners say which days rest on a balance he typed
    const anchorRows = db
      .select({ anchoredOn: balanceAnchors.anchoredOn, source: balanceAnchors.source })
      .from(balanceAnchors)
      .where(eq(balanceAnchors.accountId, account.id))
      .orderBy(desc(balanceAnchors.anchoredOn))
      .all();
    // ⛔ an opening kept from a statement he un-imported is nobody's update
    const lastManualUpdate = anchorRows.find((a) => a.source !== KEPT_OPENING_SOURCE)?.anchoredOn ?? null;

    const base = {
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      statementsThrough,
      lastManualUpdate,
      days,
      // ordered by day above, so the last row is the newest
      balancesThrough: balances.at(-1)?.day ?? null,
      countedOn: null,
      keptOpeningOn: keptOpeningOf(pickWinners(anchorRows))?.anchoredOn ?? null,
    };

    /*
     * Investment first, and unconditionally. reconcileAccounts (service.ts:1190)
     * returns `value_anchor` for type='investment' without any pass/fail — a
     * discrepancy is absorbed into market_change_cents rather than reported —
     * so no arithmetic gate exists to be verified BY. Grading these off `basis`
     * would report the two least-checked accounts in the ledger as the
     * healthiest.
     */
    if (account.type === "investment") {
      return {
        ...base,
        grade: "market_value" as const,
        verifiedThrough: null,
        chainOpensOn: null,
        firstBalanceOn: null,
        firstBalanceIsCount: false,
        unverifiedSince: null,
        brokenSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
        daysSinceVerified: null,
      };
    }

    if (balances.length === 0) {
      return {
        ...base,
        grade: "unknown" as const,
        verifiedThrough: null,
        chainOpensOn: null,
        firstBalanceOn: null,
        firstBalanceIsCount: false,
        unverifiedSince: null,
        brokenSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
        daysSinceVerified: null,
      };
    }

    // an account that has never had a transaction is not "verified" by having
    // no contradictions — the owner is its only source, so say that instead
    const hasTxn =
      db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.accountId, account.id))
        .limit(1)
        .get() !== undefined;

    const isUnchecked = (basis: BalanceBasis): boolean => !basisIsChecked(basis);
    const firstUntrusted = balances.find((b) => isUnchecked(b.basis));
    const firstGap = balances.find((b) => b.basis === "gap");

    // walk back from the newest day for as long as it is unchecked: the run
    // that is still open, which is what a sentence beginning "since" is about
    let runStart = balances.length;
    while (runStart > 0 && isUnchecked(balances[runStart - 1]!.basis)) runStart -= 1;
    const uncheckedRunDays = balances.length - runStart;
    const uncheckedSince = uncheckedRunDays > 0 ? balances[runStart]!.day : null;

    /*
     * `verifiedThrough` must not run past the point the chain BROKE: a later
     * `anchored` day is a fresh starting point, not proof of the span before it.
     *
     * 🔴 …but a run of untrusted days BEFORE the account's first trusted day is
     * not a break. Nothing broke; the chain simply starts later. Robinhood Cash
     * opens on 2023-12-05 with 26 days of prehistory before its very first
     * anchor, so `firstUntrusted` was its opening day, every trusted day failed
     * `b.day < firstUntrusted.day`, and `verifiedThrough` came back null — of an
     * account with 32 statement anchors and 32 reconciled periods, the newest
     * closing 2026-07-31. `/imports` then printed, on ONE row:
     *
     *     Robinhood Cash · Unverified · statements → 2026-07-31
     *     nothing closes to the cent from its first day; …
     *
     * The break test is measured from the first TRUSTED day, so a mid-chain gap
     * still stops the walk exactly where it did.
     */
    const handTyped = handTypedDays(pickWinners(anchorRows));
    const closed = closedChainDays(balances, handTyped);
    const firstTrusted = balances.find((b) => closed.has(b.day));
    const firstBreak = firstTrusted
      ? balances.find(
          (b) =>
            b.day > firstTrusted.day &&
            (b.basis === "derived_unverified" || b.basis === "gap"),
        )
      : firstUntrusted;
    const verifiedThrough =
      balances
        .filter((b) => closed.has(b.day) && (!firstBreak || b.day < firstBreak.day))
        .at(-1)?.day ?? null;
    // the newest count of his that nothing closes onto, when nothing closes after it
    const lastClosed = [...closed].at(-1) ?? null;
    const countedOn =
      [...handTyped]
        .filter((day) => !closed.has(day) && (lastClosed === null || day > lastClosed))
        .sort()
        .at(-1) ?? null;

    if (!hasTxn) {
      return {
        ...base,
        grade: "manual" as const,
        verifiedThrough: null,
        chainOpensOn: null,
        firstBalanceOn: null,
        firstBalanceIsCount: false,
        unverifiedSince: null,
        brokenSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
        daysSinceVerified: null,
      };
    }

    /*
     * ⛔ Nothing closed at all is not "verified" — an account whose only balance
     * is one he typed, with rows only on that day, read "adds up against a
     * document" in the net-worth count. With no unchecked day to point at, it is
     * his count and nothing else (`countedOn`).
     */
    const grade: CoverageGrade =
      days.gap > 0 ? "broken" : days.derived_unverified > 0 || closed.size === 0 ? "unverified" : "verified";
    // the rebuild writes every endpoint `anchored` and replays backwards from the first of them
    const firstBalanceOn = balances.find((b) => b.basis === "anchored")?.day ?? null;

    return {
      ...base,
      grade,
      verifiedThrough,
      countedOn,
      chainOpensOn: firstTrusted?.day ?? null,
      firstBalanceOn,
      firstBalanceIsCount: firstBalanceOn !== null && handTyped.has(firstBalanceOn),
      unverifiedSince: firstUntrusted?.day ?? null,
      brokenSince: firstGap?.day ?? null,
      uncheckedSince,
      uncheckedRunDays,
      daysSinceVerified: verifiedThrough ? diffDays(verifiedThrough, today) : null,
    };
  });
});

/** ⛔ A COPY, so one caller sorting the shared array cannot rewrite another's. */
export function accountCoverage(db: AppDatabase, today: string = todayIso()): AccountCoverage[] {
  return accountCoverageCached(db, today).slice();
}
