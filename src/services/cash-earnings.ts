import { and, asc, eq, isNotNull } from "drizzle-orm";
import { cache } from "react";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { compareDates, todayIso } from "@/lib/dates";
import { cashEarnings, type CashEarnings, type PaySeries } from "@/lib/cash-earnings";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isAgentsIncomeSeries } from "./analytics";
import { accountsAwaitingStatements } from "./cash-wallet-rule";
import { accountCoverage } from "./coverage";

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
 * the silence by a month, so this reads the rows.
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
   * The last day every account this pay lands in now (`landingAccountsBySeries`) has been read through —
   * `checkedThroughBySeries`: null when one of them has no checked record, today when it lands only where no
   * statement is coming. Present only when the caller asked (`withChecked`).
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
}

export interface CashEarningsWindow {
  from: string;
  to: string;
  today?: string;
  /** see `lib/cash-earnings`: `today` is a fully-read day, not the running one */
  todayIsComplete?: boolean;
  /**
   * Also measure each reading against how far its landing accounts have been
   * read. Off by default: it reads every account's coverage, and the dashboard
   * card that calls this several times computes its own frontier once.
   */
  withChecked?: boolean;
}

/**
 * How many of its newest posting DAYS say where a series that names no account posts now. One charge elsewhere
 * can be a one-off — his $1,000 early insurance payment left Wells Fargo on Sep 3, while the bill charges Venture
 * X — but two in a row is a move: the rent, on Wells Fargo Aug 4 and Sep 2 after Venture X and Chase Checking.
 */
const POSTING_DAYS_THAT_SAY_WHERE = 2;

/**
 * Where each series' next deposit — or charge — is looked for: where it lands NOW — the series' own `account_id`
 * when it names one, otherwise every account its newest `POSTING_DAYS_THAT_SAY_WHERE` posting days posted to.
 *
 * 🔴 Every account pay had EVER landed in, measured on a copy of the owner's
 * ledger 2026-10-07: It America LLC's weekly payroll names Wells Fargo, checked
 * through Sep 24 (he moved the series there 2026-09-28), but two Jun 4–5 ATM
 * deposits sit in Chase Checking, checked through Aug 12 — and `earliestVerified`
 * took Aug 12. The dashboard called seven paydays in a read account unread, and
 * /recurring and /budgets said Oct 1 "falls after Wed, Aug 12, 2026". A pay
 * series that names its account has told the app where to look.
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
 * ⛔ ONE rule for every caller — the dashboard's income card, /spending's note
 * (`cashEarningsReadings`), the passed-payday sentence on /budgets and
 * /recurring (`unbankedIncomeForSeries`) and whether a series is running late
 * (`checkedThroughBySeries`) — so no two can name a different day.
 *
 * ⚖️ `awaitsStatements` keeps only the accounts a statement is still coming for (`checkedThroughBySeries`): where it
 * posts now AMONG them, so a card he has archived cannot stand in front of the live one it also charged. A series
 * whose accounts are all left out maps to an EMPTY set — it posts, but nowhere a statement will cover — and one that
 * has never posted and names no account is absent, as before.
 */
export function landingAccountsBySeries(
  db: AppDatabase,
  awaitsStatements: (accountId: string) => boolean = () => true,
): Map<string, Set<string>> {
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
    const list = postings.get(r.seriesId) ?? [];
    if (awaitsStatements(r.accountId)) list.push({ day: r.postedOn, accountId: r.accountId });
    postings.set(r.seriesId, list);
  }
  const out = new Map<string, Set<string>>(
    [...postings].map(([id, list]) => [id, accountsItPostsToNow(list)] as const),
  );
  // a named account replaces the history: that is where the pay lands now — or where nothing is read any more
  for (const s of db
    .select({ id: recurringSeries.id, accountId: recurringSeries.accountId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.accountId))
    .all()) {
    if (s.accountId === null) continue;
    out.set(s.id, awaitsStatements(s.accountId) ? new Set([s.accountId]) : new Set<string>());
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
 * ⚠️ The series frontier passes it only the accounts a statement is still coming for (`checkedThroughBySeries`): an
 * archived account or a cash wallet is never asked, and cannot collapse it.
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

/**
 * Per series, the last day the ledger has checked every account it posts to NOW — `earliestVerified` over
 * `landingAccountsBySeries` and `accountCoverage` — or null when one of them has no checked record, or when the series
 * names no account and nothing linked to it says where it lands; TODAY when it posts only where no statement is
 * coming.
 *
 * ⛔ ONE frontier for every sentence about whether the ledger has looked: the passed paydays (/budgets, /recurring),
 * the dashboard's income card, /spending's note, and whether a series is running late (`seriesStaleness`). 🔴 The
 * pay sentence said "the ledger has not looked for its deposit" of Oct 1 while the forecast beside it, measuring to
 * today, said "all of it running late" (his ledger, 2026-10-08).
 *
 * ⚖️ Only an account a statement is still COMING for (`accountsAwaitingStatements` — not archived, not a cash
 * wallet) holds a series back; one no statement will ever cover is read through today, as every account was before
 * §6A 57 (2026-10-08, review of 98acbeb). His rule is that an upload arriving late can never make a bill vanish, and
 * for these none is coming. A series that also posts to an account still awaited is measured there
 * (`landingAccountsBySeries`' `awaitsStatements`). 🔴 Archived, Venture X's checked day froze at Sep 13: every series
 * on it still inside its line was forecast for good as "Awaiting statements" — the car insurance a committed bill and
 * $357.58 of the runway's arrears every month, a year on — and a series that had also charged on Wells Fargo was
 * pinned to that Sep 13 however far Wells Fargo was read.
 *
 * ⚠️ An awaited account with NO checked record still holds its series where nothing has been read (null), as the
 * income card, the passed paydays and /spending's reading all require: a statement can still come for it, and a
 * deposit could be sitting in it unseen (`earliestVerified`).
 *
 * ⚡ The coverage read is memoised for the render (`accountCoverage`); the closure only takes an earliest.
 * ⚡ …and so is the whole frontier, for the reason `accountCoverage` gives (`react`'s `cache`, one request, never a
 * module-level Map): since the lapse is measured to it (§6A 57) every budget's tail and arrears walk asks it, and
 * measured on a copy of his ledger 2026-10-08 one call is 2.65ms past the cached coverage — 24 of them per /budgets.
 */
export const checkedThroughBySeries = cache(function checkedThroughBySeries(
  db: AppDatabase,
  today: string,
): (seriesId: string) => string | null {
  // the accounts a statement is still coming for, each with the day statements have checked it through (or null)
  const awaiting = accountsAwaitingStatements(db);
  const verifiedThroughByAccount = new Map(
    accountCoverage(db, today)
      .filter((c) => awaiting.has(c.accountId))
      .map((c) => [c.accountId, c.verifiedThrough] as const),
  );
  const landings = landingAccountsBySeries(db, (accountId) => awaiting.has(accountId));
  return (seriesId) => {
    const landing = landings.get(seriesId);
    if (landing === undefined) return null;
    // it posts, but only where no statement will ever read: nothing is coming to wait for
    return landing.size === 0 ? today : earliestVerified(landing, verifiedThroughByAccount, today);
  };
});

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
      amountCentsAvg: recurringSeries.amountCentsAvg,
      userAmountCents: recurringSeries.userAmountCents,
      userEndsOn: recurringSeries.userEndsOn,
      anchorDay: recurringSeries.anchorDay,
    })
    .from(recurringSeries)
    .where(and(eq(recurringSeries.kind, "income"), eq(recurringSeries.status, "confirmed")))
    .orderBy(asc(recurringSeries.name))
    .all()
    .filter((s) => !isAgentsIncomeSeries(agentsCash, s));

  if (series.length === 0) return [];

  const linked = db
    .select({
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(isNotNull(transactions.recurringSeriesId), eq(transactions.status, "active")))
    .orderBy(asc(transactions.postedOn))
    .all();

  const readings: CashEarningsReading[] = [];
  const checkedOf = withChecked ? checkedThroughBySeries(db, today) : null;

  for (const s of series) {
    const banked = linked
      .filter((r) => r.seriesId === s.id)
      .map((r) => ({ postedOn: r.postedOn, amountCents: r.amountCents }));

    /*
     * A schedule with no evidence at all has no life to bound, so it implies
     * nothing rather than implying everything since the epoch. `startedOn` is
     * the first deposit the owner actually attributed to it — the earliest
     * moment we can say the arrangement existed.
     */
    const firstBanked = banked[0];
    if (firstBanked === undefined) continue;

    const amountCents = s.userAmountCents ?? s.amountCentsAvg;
    if (amountCents === null || amountCents <= 0) continue;

    const pay: PaySeries = {
      cadence: s.userCadence ?? s.cadence,
      // a user-set cadence replaces the measured gap: the owner declaring
      // "weekly" outranks an average taken over two deposits a day apart
      intervalDaysAvg: s.userCadence ? null : s.intervalDaysAvg,
      anchorDay: s.anchorDay ?? null,
      amountCents,
      startedOn: firstBanked.postedOn,
      endedOn: s.userEndsOn ?? null,
    };

    const reading: CashEarningsReading = {
      seriesId: s.id,
      seriesName: s.name,
      ...cashEarnings({ series: pay, banked, from, to, today, todayIsComplete }),
    };
    if (checkedOf === null) {
      readings.push(reading);
      continue;
    }
    const checkedThrough = checkedOf(s.id);
    if (checkedThrough === null) {
      readings.push({ ...reading, checkedThrough, checkedPeriodsCovered: 0, checkedPeriodsSinceBanked: 0 });
      continue;
    }
    /*
     * The same schedule, read AS OF the frontier: a day the records have read
     * through is complete, so a payday dated on it is checked — unless the
     * frontier IS the running day, where a deposit may still post.
     */
    const asChecked = cashEarnings({
      series: pay,
      banked,
      from,
      to: compareDates(to, checkedThrough) < 0 ? to : checkedThrough,
      today: checkedThrough,
      todayIsComplete: compareDates(checkedThrough, today) < 0,
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
    });
  }

  return readings;
}
