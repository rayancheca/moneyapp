import { and, asc, eq, isNotNull } from "drizzle-orm";
import { cache } from "react";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { compareDates, todayIso } from "@/lib/dates";
import { cashEarnings, type CashEarnings, type PaySeries } from "@/lib/cash-earnings";
import {
  paydaysNoDepositPaidInFull,
  payShortfall,
  silentPaydaysNotBankedYet,
  type PayShortfall,
  type WentBackOut,
  type WindowEarnings,
} from "@/lib/pay-shortfall";
import { firstPaydayOn } from "@/lib/payday-settlement";
import type { ExpectedDay, UnattachedMatch } from "@/lib/unattached-match";
import { stepPlan, walkDayOfMonth } from "@/lib/recurring-step";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isAgentsIncomeSeries, loadCategoryIndex, payDayRows } from "./analytics";
import { billingCarriers } from "./billing-carriers";
import { accountsAwaitingStatements, silenceReadThrough } from "./cash-wallet-rule";
import { accountCoverage, archivedAccountCoverage } from "./coverage";
import { paydaySettlement } from "./payday-settlement";
import { effectiveSeries } from "./recurring";
import { unattachedMatchesBySeries } from "./unattached-match";

/**
 * Earned versus banked, read off the real ledger.
 *
 * Feeds `lib/cash-earnings`, whose docstring carries the reasoning. What this
 * layer owns is the choice of EVIDENCE, and there are two decisions in it that
 * a reader will otherwise think are arbitrary.
 *
 * **1. The series' life comes from its linked rows, not from `last_matched_on`.**
 * That column is written at detection time and nothing revisits it — the same
 * shape of defect as the stored reconciliation verdicts of pass 59, and it is
 * already wrong on the live database. Measured 2026-08-21: "Cash job (weekly
 * pay)" carries `last_matched_on = 2026-07-06`, but no transaction links to the
 * series on that day; the $150 row that was once matched there has since been
 * re-categorised to `Transfers > Internal Transfer` and unlinked. The newest
 * genuinely linked deposit is 2026-06-05. Reading the cache would understate
 * the silence by a month, so this reads the rows. ⚖️ The life opens on the
 * series' FIRST PAYDAY (`firstPaydayOn`, §6A 55 step B): its schedule's rhythm
 * walked back to the first linked deposit — the day the settlement, the
 * recurring calendar and /budgets open on too.
 *
 * **2. Only ATTRIBUTED deposits count as banked.** A row counts when it carries
 * `recurring_series_id`, never merely because it looks like a cash deposit. The
 * 2026-07-21 pair of ATM deposits totalling $6,900 is his mother's money, and a
 * heuristic wide enough to catch a payday would have swept it into wages — the
 * exact mistake pass 59 had to undo by hand.
 *
 * ⚠️ Not to be confused with `lib/income-forecast`'s `projectOngoingIncome`,
 * which looks FORWARD from trailing history to estimate next month. This looks
 * BACKWARD from a confirmed schedule at a window that has already happened.
 * Merging them would be a category error: one projects, one reconciles.
 */

export interface CashEarningsReading extends CashEarnings {
  seriesId: string;
  seriesName: string;
  /**
   * The series' days to land (`toleranceDays`): a payday checked on its day but not through these, that no deposit
   * settled, is "not banked yet" — never "never reached a bank" (`paydaysNotBankedYet`, `unbankedSplit`).
   */
  toleranceDays: number;
  /**
   * The last day every account this pay lands in now (`landingAccountsBySeries`) has been read through —
   * `checkedThroughBySeries` — or null when one of them has no checked record. Present only when the caller asked
   * (`withChecked`).
   *
   * 🔴 The /spending note said "none of it reached an account" of September's
   * paydays while Chase Checking, the only account that pay has ever landed in,
   * was read through Aug 12 (measured 2026-09-14). The calendar says a payday
   * passed; only this says whether anyone has looked for the deposit.
   */
  checkedThrough?: string | null;
  /** of `periodsCovered`, the paydays on or before `checkedThrough` (0 when it is null) */
  checkedPeriodsCovered?: number;
  /** of `periodsSinceBanked`, the ones on or before `checkedThrough` (0 when it is null) */
  checkedPeriodsSinceBanked?: number;
  /**
   * Of the silence, the paydays not banked yet (`silentPaydaysNotBankedYet`), oldest first — schedule-wide like
   * `periodsSinceBanked`, never the window's (`shortfall.notBankedYetPaydays`): what /spending's note for a stale
   * schedule names, as Earned vs banked's verdict does (`IncomePayLine.checkedSilentNotBankedYet`). Present only with
   * `withChecked`.
   */
  checkedSilentNotBankedYet?: readonly string[];
  /**
   * Of the schedule's passed paydays the ledger has checked that no deposit paid in full — those a sentence would call
   * absent (`paydaysNoDepositPaidInFull`): "with no deposit", "not banked yet" inside their days to land, "did not
   * reach a bank" past them, and the rest of one paid short — the ones a row matches to the cent that sits unattached
   * (`unattachedMatchesBySeries`), over the schedule's whole life, oldest first: each reader takes its own window's or
   * its silence's, and says a row of a payday still inside its days to land where it would have said "not banked yet".
   * Never banked by it — still in the difference, still unpaid — and never called absent. 🔴 His ledger copy 2026-10-29
   * (before his filing): "so the pay did not reach a bank" and "none of it reached an account" of Oct 1, 8, 15 and 22
   * beside four +$1,141.92 payroll rows on Wells Fargo, unattached. Present only with `withChecked`, and empty when
   * nothing is checked.
   */
  unattachedPaydays?: readonly UnattachedMatch[];
  /**
   * The window's pay against the series' settlement (`payShortfall`) — /spending's shortfall note and the split of its
   * surplus note: what the READ paydays came to beyond what was banked inside the window, what deposits outside it
   * paid of them, what no deposit made up, and the window's money that paid a later payday early. Present only with
   * `withChecked`, since "read" is that frontier's word.
   *
   * ⛔ The figures are this reading's own — `payGap` over its implied and banked, read as of the checked day, the
   * dashboard's subtraction — and who paid what is the settlement's (`paydaySettlement`), so the note names Aug 27 paid
   * by the deposit of Sep 24 exactly where the calendar draws it — never a second walk of this reading's schedule.
   */
  shortfall?: PayShortfall;
  /**
   * ⚖️ The money that went back out on a day of its own inside the window, each day whole, that the window's money
   * paying no read payday could not net — the one rule (`moneyOutOfWindow`, decision 75) — and, with it, this reading's
   * `bankedCents` and `unbankedCents` are that rule's: the days that banked less the money out it netted. Present only
   * with `withChecked`, since "read" is that frontier's word — and every reader that PRINTS a banked figure asks with
   * it: Earned vs banked's card and /spending's notes.
   */
  wentBackOut?: readonly WentBackOut[];
}

export interface CashEarningsWindow {
  from: string;
  to: string;
  today?: string;
  /** see `lib/cash-earnings`: `today` is a fully-read day, not the running one */
  todayIsComplete?: boolean;
  /**
   * Also measure each reading against how far its landing accounts have been
   * read — and so read its banked figure by the rule for money out on a day of
   * its own (`wentBackOut`), which needs that frontier. Off by default: it reads
   * every account's coverage and walks the settlement, and the dashboard card's
   * as-of readings, which print no banked figure, do without.
   */
  withChecked?: boolean;
}

/**
 * How many of its newest posting DAYS say where a series posts now — beside the account it names, when it names one
 * (his decision 66). One charge elsewhere can be a one-off — his $1,000 early insurance payment left Wells Fargo on
 * Sep 3, while the bill charges Venture X — but two in a row is a move: the rent, on Wells Fargo Aug 4 and Sep 2 after
 * Venture X and Chase Checking.
 */
const POSTING_DAYS_THAT_SAY_WHERE = 2;

/**
 * Where each series' next deposit — or charge — is looked for: where it lands NOW — every account its newest
 * `POSTING_DAYS_THAT_SAY_WHERE` posting days posted to, AND the series' own `account_id` when it names one (his
 * decision 66, 2026-10-12). A series that has never posted is looked for where it names alone, or nowhere.
 *
 * 🔴 Every account pay had EVER landed in, measured on a copy of the owner's
 * ledger 2026-10-07: It America LLC's weekly payroll names Wells Fargo, checked
 * through Sep 24 (he moved the series there 2026-09-28), but two Jun 4–5 ATM
 * deposits sit in Chase Checking, checked through Aug 12 — and `earliestVerified`
 * took Aug 12. The dashboard called seven paydays in a read account unread, and
 * /recurring and /budgets said Oct 1 "falls after Wed, Aug 12, 2026". A pay
 * series that names its account has told the app where to look — and its last
 * two deposits, on Wells Fargo, say the same: the June ones are history.
 *
 * 🔴 AND A SERIES THAT NAMES NONE has told it by where it has posted lately. Measured on a copy of his ledger
 * 2026-10-08: Flamingo South Beach (rent) posted on Venture X (Jun 16), Chase Checking (Jul 8), then Wells Fargo
 * (Aug 4, Sep 2), and every account it ever touched gave Chase's Aug 12 — before its own last charge, on an account
 * it left. At today = Oct 21 /recurring said "nothing has matched since Sep 2, 2026 (49 days), but its account has
 * been checked only through Aug 12, 2026", and a rent that truly missed on Wells Fargo's checked days could not read
 * late until Chase, 43 days behind, caught up.
 *
 * ⚠️ Not only the newest day: one charge elsewhere does not move a series (`POSTING_DAYS_THAT_SAY_WHERE`), and
 * while it might still land in either account, both are looked at — the earlier frontier stands, as for any account
 * it could land in (`earliestVerified`).
 *
 * ⚖️ A NAMED account is ADDED to them, never put in their place — read on both, and the earlier frontier stands
 * (`earliestVerified`), his decision 66 (2026-10-12). The account it names is where he says it lands; its last two
 * payment days are where it has landed; while they differ a charge could sit in either. 🔴 "A named account replaces
 * the history" read a bill naming one account and paying from another only where it does not pay: on a copy of his
 * ledger 2026-10-12 the dismissed PURA VIDA BAY ROAD MIAMI BEACH names Venture X, read through Sep 13, and paid its
 * last two (Jul 19, Jul 21) on Chase Sapphire, read through Sep 2 — Venture X alone could badge its page "Running late"
 * or "Lapsed" on days no Sapphire statement had read. (Dismissed, it reaches no calendar and no arrears, so no ✕ and no
 * "not posted": measured on his ledger copy 2026-10-13, its page reads "Lapsed" and Jul–Oct draw it on no day.) It
 * alone reads a different day (Sep 13 → Sep 2); the pay, the rent, its utilities and every live bill read the same day
 * as before.
 *
 * ⛔ ONE rule for every caller — the dashboard's income card, /spending's note
 * (`cashEarningsReadings`), the passed-payday sentence on /budgets and
 * /recurring (`unbankedIncomeForSeries`), whether a series is running late
 * (`silenceMeasuredThroughBySeries`) and — ⚖️ his decision 62 (2026-10-12) — whether a bill's due day is read, the
 * calendar's ✕ and every "not posted" (`dueDayReadings`) — so no two can name a different day.
 *
 * ⛔ Chosen over EVERY account it posted to, archived ones too — whether a statement is still coming for one is the
 * frontier's question (`silenceMeasuredThroughBySeries`), never this one's. 🔴 Chosen among the accounts still
 * awaited (review of 82d75d7), a series whose newest charges sit on an archived account fell back to the accounts it
 * had LEFT: on a copy of his ledger with Wells Fargo archived the rent was measured to Chase's Aug 12 again — before
 * its own last charge — and read "Awaiting statements" on 2026-12-07 beside the car lease, the same Wells Fargo and
 * the same Sep 2, lapsed.
 */
export function landingAccountsBySeries(db: AppDatabase): Map<string, Set<string>> {
  const rows = db
    .select({
      seriesId: transactions.recurringSeriesId,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
    })
    .from(transactions)
    .where(and(isNotNull(transactions.recurringSeriesId), eq(transactions.status, "active")))
    .all();

  const postings = new Map<string, Posting[]>();
  for (const r of rows) {
    if (r.seriesId === null) continue;
    const posting = { day: r.postedOn, accountId: r.accountId };
    const list = postings.get(r.seriesId);
    if (list === undefined) postings.set(r.seriesId, [posting]);
    else list.push(posting);
  }
  const out = new Map<string, Set<string>>(
    [...postings].map(([id, list]) => [id, accountsItPostsToNow(list)] as const),
  );
  // ⚖️ a named account is ADDED to where its last two posting days posted — never put in their place (his decision 66)
  for (const s of db
    .select({ id: recurringSeries.id, accountId: recurringSeries.accountId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.accountId))
    .all()) {
    if (s.accountId !== null) out.set(s.id, new Set([s.accountId, ...(out.get(s.id) ?? [])]));
  }
  /*
   * ⚖️ A series BILLED INSIDE another's payment (§6A 59) posts where its carrier posts: its evidence is the carrier's
   * postings (`lastSeenOn`), so the days read for that evidence are the carrier's accounts' — added to its own, and
   * the earlier frontier stands (`earliestVerified`). 🔴 Without them `Rent utilities & fees`, no row and no account of
   * its own, was measured to nothing checked: never late and never lapsed — "Awaiting statements" for good — while the
   * rent it is paid inside read late on Wells Fargo's checked days and lapsed 93 days after Sep 2 (§6A 57 composed with
   * §6A 59). The carrier is the live series, followed through any merge (`billingCarriers`).
   */
  for (const [id, carrier] of billingCarriers(db)) {
    const borrowed = out.get(carrier.id);
    if (borrowed === undefined) continue;
    out.set(id, new Set([...(out.get(id) ?? []), ...borrowed]));
  }
  return out;
}

interface Posting {
  day: string;
  accountId: string;
}

/** Every account a series' newest `POSTING_DAYS_THAT_SAY_WHERE` posting days posted to — all of a day's rows. */
function accountsItPostsToNow(postings: readonly Posting[]): Set<string> {
  const days = [...new Set(postings.map((p) => p.day))]
    .sort((a, b) => compareDates(b, a))
    .slice(0, POSTING_DAYS_THAT_SAY_WHERE);
  return new Set(postings.filter((p) => days.includes(p.day)).map((p) => p.accountId));
}

/**
 * Of a schedule's silent paydays — those since its last deposit — how many fall
 * on or before `checkedThrough`, given the silence read AS OF that day.
 *
 * ⛔ Never more than the silence itself. The as-of reading counts from the last
 * deposit BEFORE the frontier, so a frontier earlier than the last deposit gave
 * a larger silence than the real one (9 against 1 on the owner's ledger copy,
 * 2026-10-07) and every sentence comparing the two broke. Every silent payday
 * falls after the last deposit, so with the frontier before it none is read.
 */
export function checkedSilence(
  asOfSilence: number,
  silentPeriods: number,
  lastBankedOn: string | null,
  checkedThrough: string | null,
): number {
  if (checkedThrough === null) return 0;
  if (lastBankedOn !== null && compareDates(checkedThrough, lastBankedOn) < 0) return 0;
  return Math.min(Math.max(0, asOfSilence), silentPeriods);
}

/**
 * The EARLIEST `verifiedThrough` across every account a series' pay has landed
 * in — the last day the ledger has checked every place a payday could arrive.
 *
 * A single account with nothing verified collapses the whole thing to null,
 * which is the honest answer rather than the convenient one: if one possible
 * landing place is unchecked, a deposit could be sitting in it unseen and no
 * surface may claim the ledger looked.
 *
 * ⚠️ The day a series' SILENCE is measured to reads an account no statement is coming for as checked through today
 * (`silenceMeasuredThroughBySeries`): there it never collapses, and never holds a series back.
 */
export function earliestVerified(
  accountIds: ReadonlySet<string>,
  verifiedThroughByAccount: ReadonlyMap<string, string | null>,
  today: string,
): string | null {
  if (accountIds.size === 0) return null;
  let earliest: string | null = null;
  for (const id of accountIds) {
    const through = verifiedThroughByAccount.get(id) ?? null;
    if (through === null) return null;
    if (earliest === null || compareDates(through, earliest) < 0) earliest = through;
  }
  // a record reaching past today still cannot have been read against today
  if (earliest !== null && compareDates(earliest, today) > 0) return today;
  return earliest;
}

/** Where each series posts now, and how far each account's statements reach — the one reading both frontiers take. */
interface FrontierReading {
  landings: Map<string, Set<string>>;
  verifiedThroughByAccount: ReadonlyMap<string, string | null>;
}

/** ⚡ Memoised for the render, as `accountCoverage` is: both frontiers below, and every caller of each, share it. */
const frontierReading = cache(function frontierReading(db: AppDatabase, today: string): FrontierReading {
  return {
    landings: landingAccountsBySeries(db),
    // archived accounts too: the days a statement covered stay covered when he archives the account
    verifiedThroughByAccount: new Map(
      [...accountCoverage(db, today), ...archivedAccountCoverage(db, today)].map(
        (c) => [c.accountId, c.verifiedThrough] as const,
      ),
    ),
  };
});

/**
 * Per series, the last day the ledger has checked every account it posts to NOW — `earliestVerified` over
 * `landingAccountsBySeries` and every account's checked record, archived ones included — or null when one of them has
 * no checked record, or when the series names no account and nothing linked to it says where it lands.
 *
 * ⛔ ONE frontier for every sentence about whether the ledger has LOOKED: the passed paydays (/budgets, the forecast on
 * /recurring, the pay series' own page), the calendar's payday marks (`paydayIsRead`), the dashboard's income card and
 * /spending's note. 🔴 The pay sentence said "the ledger has not looked for its
 * deposit" of Oct 1 while the forecast beside it, measuring to today, said "all of it running late" (his ledger,
 * 2026-10-08) — so on every account a statement is still coming for, a series' silence is measured to this same day
 * (`silenceMeasuredThroughBySeries`).
 *
 * ⚠️ Never today for a day no statement has read. An archived account's record stops where its statements did, and a
 * deposit could sit in it unseen after that — no surface may claim the ledger looked. 🔴 Measured to today (review of
 * 82d75d7), the income card said of four paydays after Wells Fargo's last statement (archived, on a copy of his
 * ledger) "4 of them fall on days the records already cover, through Oct 29 — so the pay did not reach a bank", and
 * /recurring warned "Cash pay that never reaches a bank". The decision that measures his bills to today moved the
 * LAPSE (2026-10-08), not what the ledger has read.
 *
 * ⚡ The coverage read is memoised for the render (`frontierReading`); the closure only takes an earliest.
 */
export const checkedThroughBySeries = cache(function checkedThroughBySeries(
  db: AppDatabase,
  today: string,
): (seriesId: string) => string | null {
  const { landings, verifiedThroughByAccount } = frontierReading(db, today);
  return (seriesId) => earliestVerified(landings.get(seriesId) ?? new Set<string>(), verifiedThroughByAccount, today);
});

/**
 * Per series, the day its silence is measured to — whether it is running late, "Awaiting statements" or lapsed
 * (`seriesStaleness`, `seriesHasLapsed`, §6A 57): `checkedThroughBySeries`' day, except that an account no statement
 * is coming for counts as read through TODAY — `silenceReadThrough`. ⚖️ The very day the calendar's ✕ and the runway's
 * arrears grade a past bill against (`dueDayReadings`, his decision 62, 2026-10-12, review of 9940f1c).
 *
 * ⚖️ An account a statement is still COMING for (`accountsAwaitingStatements` — not archived, not a cash wallet)
 * holds a series back to the day its statements have covered; one no statement will ever cover does not (2026-10-08,
 * review of 98acbeb). His rule is that an upload arriving late can never make a bill vanish, and for these none is
 * coming. A series that posts now only where nothing is coming is measured to today, as every series was before
 * §6A 57; one that also posts to an account still awaited, to that account's day. 🔴 Read to an archived card's
 * frozen day, every series on it still inside its line was forecast for good as "Awaiting statements" — the car
 * insurance a committed bill and $357.58 of the runway's arrears every month, a year on.
 *
 * ⛔ The SAME landing accounts as `checkedThroughBySeries`: where it posts now is chosen over every account, and only
 * then is an archived one read through today. 🔴 Chosen among the accounts still awaited, the rent fell back to the
 * accounts it had left (`landingAccountsBySeries`).
 *
 * ⚠️ An awaited account with NO checked record still holds its series where nothing has been read (null), as the
 * income card, the passed paydays and /spending's reading all require: a statement can still come for it.
 *
 * ⚡ Memoised for the reason `accountCoverage` gives (`react`'s `cache`, one request, never a module-level Map): every
 * budget's tail and arrears walk asks it, and measured on a copy of his ledger 2026-10-08 one call is 2.65ms past the
 * cached coverage — 24 of them per /budgets.
 */
export const silenceMeasuredThroughBySeries = cache(function silenceMeasuredThroughBySeries(
  db: AppDatabase,
  today: string,
): (seriesId: string) => string | null {
  const { landings, verifiedThroughByAccount } = frontierReading(db, today);
  const awaiting = accountsAwaitingStatements(db);
  const readThrough = new Map(
    [...landings.values()]
      .flatMap((ids) => [...ids])
      .map((id) => [id, silenceReadThrough(awaiting, id, verifiedThroughByAccount.get(id) ?? null, today)] as const),
  );
  return (seriesId) => earliestVerified(landings.get(seriesId) ?? new Set<string>(), readThrough, today);
});

/**
 * Per series, the day its silence WILL be measured to once a statement has checked every account it posts to now
 * through `today` — `silenceMeasuredThroughBySeries` with nothing left unchecked: today, or null where it posts to no
 * account the ledger knows, which no statement can ever check. What a lapse still open can come to: the arrears walk
 * asks it whether a bill it owes may still be let go as its statements land (`OverdueSeries.mayStillLapse`).
 *
 * ⛔ The same landing accounts (`frontierReading`, memoised for the render). ⚠️ Not today for every series: a bill last
 * seen in March with no row and no account to post to would read as about to lapse, while its silence, measured on no
 * account, never can be (pinned in `budgets.test.ts`).
 */
export function silenceOnceCheckedBySeries(db: AppDatabase, today: string): (seriesId: string) => string | null {
  const { landings } = frontierReading(db, today);
  return (seriesId) => ((landings.get(seriesId)?.size ?? 0) > 0 ? today : null);
}

/**
 * One reading per confirmed income series — never a single aggregate.
 *
 * Summing them would produce a total whose `basis` is meaningless: one live
 * schedule and one long-dead one average out to a number that describes
 * neither. The caller renders what it wants and each row keeps its own verdict.
 *
 * `confirmed` only, deliberately. A `detected` income series is a hypothesis the
 * owner has not agreed to, and implying earnings from an unconfirmed guess is
 * the fabrication this whole module exists to avoid.
 *
 * ⚖️ And his pay only: what the agent's cash is paid is not his income
 * (`isAgentsIncomeSeries`, owner decision 2026-09-28, §6A 27). 🔴 Confirmed and
 * linked, the agent's month-end interest was a pay line of the dashboard's
 * income card — "Pay is arriving: the last deposit landed on Sep 30" — and
 * $0.04 of what the card says reached a bank.
 */
export function cashEarningsReadings(
  db: AppDatabase,
  { from, to, today = todayIso(), todayIsComplete = false, withChecked = false }: CashEarningsWindow,
): CashEarningsReading[] {
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const series = db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      kind: recurringSeries.kind,
      accountId: recurringSeries.accountId,
      cadence: recurringSeries.cadence,
      userCadence: recurringSeries.userCadence,
      intervalDaysAvg: recurringSeries.intervalDaysAvg,
      nextExpectedOn: recurringSeries.nextExpectedOn,
      userNextExpectedOn: recurringSeries.userNextExpectedOn,
      toleranceDays: recurringSeries.toleranceDays,
      nextExpectedAmountCents: recurringSeries.nextExpectedAmountCents,
      userAmountCents: recurringSeries.userAmountCents,
      userAmountHistory: recurringSeries.userAmountHistory,
      userEndsOn: recurringSeries.userEndsOn,
      anchorDay: recurringSeries.anchorDay,
    })
    .from(recurringSeries)
    .where(and(eq(recurringSeries.kind, "income"), eq(recurringSeries.status, "confirmed")))
    .orderBy(asc(recurringSeries.name))
    .all()
    .filter((s) => !isAgentsIncomeSeries(agentsCash, s));

  if (series.length === 0) return [];

  const idx = loadCategoryIndex(db);
  const linked = db
    .select({
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(and(isNotNull(transactions.recurringSeriesId), eq(transactions.status, "active")))
    .orderBy(asc(transactions.postedOn))
    .all();

  const readings: CashEarningsReading[] = [];
  const checkedOf = withChecked ? checkedThroughBySeries(db, today) : null;
  // each schedule's paydays it would call absent, asked the one rule together below
  const absentBySeries = new Map<string, readonly ExpectedDay[]>();

  for (const s of series) {
    /*
     * ⚖️ Its pay days' rows only (`payDayRows`) — the rows settlement spends and every Income figure reads: his
     * spending linked to his pay is in Spent, never in what his pay banked (orchestrator's default 2026-10-14, his call
     * open), and money on a day no row of it is filed as his pay is the review queue's or a transfer's. 🔴 Read with
     * the rest, an unfiled $1,141.92 back beside Sep 17's payroll banked nothing that day here while "Income recorded"
     * counted the payroll; and an unfiled $1,141.92 alone banked here while no Income figure counted it.
     */
    const banked = payDayRows(idx, linked.filter((r) => r.seriesId === s.id)).map((r) => ({
      postedOn: r.postedOn,
      amountCents: r.amountCents,
    }));

    /*
     * THE schedule every projection of this series walks (`effectiveSeries`): the owner's cadence, date and amount
     * over detection's, and its past rates read strictly (§6A 55) — a history it cannot read refuses the reading
     * rather than implying his cash weeks at today's rate. 🔴 The amount was the owner's, else the POSTED AVERAGE: a
     * second spelling of "the amount", implied at one rate here and projected at another by the calendar, the forecast
     * and the payday settlement.
     */
    const eff = effectiveSeries(s);
    const amountCents = eff.nextExpectedAmountCents;
    if (amountCents === null || amountCents <= 0) continue;

    /*
     * ⚖️ The series' FIRST PAYDAY (`firstPaydayOn`, §6A 55 step B): its schedule's rhythm walked back to the first
     * deposit attributed to it — the earliest moment we can say the arrangement existed, on the day the settlement,
     * the recurring calendar and /budgets open on. A schedule with no evidence at all has no life to bound, so it
     * implies nothing rather than implying everything since the epoch.
     *
     * 🔴 It was the first deposit's own date, walked by the deposits' rhythm. On the e2e fixture, whose Paycheck was
     * then anchored Fri Jul 10 — a week off its deposits' Fridays (their own Jul 17 since 8ef2fc5) — this card counted
     * "14 paydays, Jan 2 – Jul 3" while the calendar drew Jan 9 … Jun 26 and the settlement walked only from Jul 10. On
     * his ledger the card counted his cash weeks from Jun 4 and no other page drew one before Jul 23.
     */
    const startedOn = firstPaydayOn(eff, s.toleranceDays, banked, today);
    if (startedOn === null) continue;

    const plan = stepPlan(eff.cadence, eff.intervalDaysAvg, eff.anchorDay);
    const pay: PaySeries = {
      cadence: eff.cadence,
      intervalDaysAvg: eff.intervalDaysAvg,
      // the anchor's day, not the first payday's: walked back into a short month, that one may have been clamped
      anchorDay: eff.nextExpectedOn === null ? eff.anchorDay : walkDayOfMonth(eff.nextExpectedOn, plan),
      amountCents,
      amountHistory: eff.amountHistory,
      startedOn,
      endedOn: eff.userEndsOn,
    };

    /*
     * ⚖️ Who paid what, when the reading names a silence (`withChecked`): a payday a deposit paid — early or late — is
     * no part of it (`settledPaydays`), as the calendar draws it paid. 🔴 Review of 27ca437: Earned vs banked said "1
     * falls on a day already checked, with no deposit" of Thu Oct 1, which Wed Sep 30's payroll paid early.
     */
    const settlement = checkedOf === null ? null : paydaySettlement(db, s.id, today, idx);
    const settledPaydays = new Set(settlement?.settledBy.keys() ?? []);
    const reading: CashEarningsReading = {
      seriesId: s.id,
      seriesName: s.name,
      toleranceDays: s.toleranceDays,
      ...cashEarnings({ series: pay, banked, from, to, today, todayIsComplete, settledPaydays }),
    };
    if (checkedOf === null || settlement === null) {
      readings.push(reading);
      continue;
    }
    const checkedThrough = checkedOf(s.id);
    // ⛔ the window's figures are this reading's — Earned vs banked's — and only who paid what is the settlement's
    const shortfallOf = (read: WindowEarnings["read"]): PayShortfall =>
      payShortfall(
        settlement,
        { from, to, today, checkedThrough, toleranceDays: s.toleranceDays },
        { impliedCents: reading.impliedCents, bankedCents: reading.bankedCents, read },
      );
    /*
     * ⛔ ONE reading of the rule for money out on a day of its own (`moneyOutOfWindow`): the shortfall's — so the card's
     * banked figure, /spending's surplus and stale notes and its shortfall note read one figure, and name one day.
     * 🔴 The card took nothing off for a later day's money out and named none, while /spending netted it or named it
     * (merge of d75-banked and the shortfall branch, 2026-10-21).
     */
    const ruled = (shortfall: PayShortfall) => ({
      bankedCents: shortfall.bankedCents,
      unbankedCents: reading.impliedCents - shortfall.bankedCents,
      wentBackOut: shortfall.wentBackOut,
      shortfall,
    });
    // ⛔ the silence's, whatever the window — the verdict's own call (`silentPaydaysNotBankedYet`)
    const checkedSilentNotBankedYet = silentPaydaysNotBankedYet(settlement, {
      lastBankedOn: reading.lastBankedOn,
      startedOn,
      today,
      checkedThrough,
      toleranceDays: s.toleranceDays,
    });
    if (checkedThrough === null) {
      const shortfall = shortfallOf({ paydays: 0, cents: 0, firstOn: null, lastOn: null });
      readings.push({
        ...reading,
        checkedThrough,
        checkedPeriodsCovered: 0,
        checkedPeriodsSinceBanked: 0,
        checkedSilentNotBankedYet,
        unattachedPaydays: [],
        ...ruled(shortfall),
      });
      continue;
    }
    // ⛔ the one rule, asked of every payday the schedule would call absent — checked, and paid in full by no deposit
    // (`paydaysNoDepositPaidInFull`) — below, with every other schedule's (`unattachedMatchesBySeries`)
    absentBySeries.set(
      s.id,
      paydaysNoDepositPaidInFull(settlement, {
        from: startedOn,
        to: today,
        today,
        checkedThrough,
        toleranceDays: s.toleranceDays,
      }),
    );
    /*
     * The same schedule, read AS OF the frontier: a day the records have read
     * through is complete, so a payday dated on it is checked — unless the
     * frontier IS the running day, where a deposit may still post. ⛔ Its silence is the same one's: none a deposit paid.
     */
    const asChecked = cashEarnings({
      series: pay,
      banked,
      from,
      to: compareDates(to, checkedThrough) < 0 ? to : checkedThrough,
      today: checkedThrough,
      todayIsComplete: compareDates(checkedThrough, today) < 0,
      settledPaydays,
    });
    const shortfall = shortfallOf({
      paydays: asChecked.periodsCovered,
      cents: asChecked.impliedCents,
      firstOn: asChecked.firstPeriodOn,
      lastOn: asChecked.lastPeriodOn,
    });
    readings.push({
      ...reading,
      checkedThrough,
      checkedPeriodsCovered: asChecked.periodsCovered,
      checkedPeriodsSinceBanked: checkedSilence(
        asChecked.periodsSinceBanked,
        reading.periodsSinceBanked,
        reading.lastBankedOn,
        checkedThrough,
      ),
      checkedSilentNotBankedYet,
      unattachedPaydays: [],
      ...ruled(shortfall),
    });
  }

  /*
   * ⛔ The one rule asked ONCE, of every schedule read here (`unattachedMatchesBySeries`): one row answers one payday of
   * one schedule. 🔴 Review of e6ad55a (MEDIUM): asked schedule by schedule, two pay schedules of one amount on one
   * account each took the one row both could answer, and Earned vs banked named it under both lines.
   */
  const unattachedOf = unattachedMatchesBySeries(db, absentBySeries, today);
  if (unattachedOf.size === 0) return readings;
  return readings.map((r) =>
    absentBySeries.has(r.seriesId) ? { ...r, unattachedPaydays: unattachedOf.get(r.seriesId) ?? [] } : r,
  );
}
