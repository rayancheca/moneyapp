import type { AppDatabase } from "@/db/client";
import { lastFullyReadMonth, type UnreadMonths } from "@/lib/committed";
import { addCalendarMonths, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { spendingCoverageThrough } from "./movers-card";
import { ledgerOpens } from "./observation-frontier";

/**
 * The first calendar month the ledger covers IN FULL — its opening month when it opened on that month's first day,
 * else the month after; null for an empty ledger. A stub month is not a month: `baselineWindow`'s floor.
 */
export function firstWholeMonth(db: AppDatabase): string | null {
  const opens = ledgerOpens(db);
  if (opens === null) return null;
  return periodBounds(opens, "monthly").start === opens
    ? monthKey(opens)
    : monthKey(addCalendarMonths(`${monthKey(opens)}-01`, 1));
}

/** Where an average of whole months ends today (`averagesEndAt`). */
export interface AveragesEnd {
  /**
   * 'YYYY-MM': the last complete calendar month, or the last one every account you spend from is read to the end of —
   * for the income pace, every account your income lands in (`averagesEndThrough`)
   */
  month: string;
  /**
   * The complete months after `month`, before the running one, that the frontier leaves out — never one before the
   * ledger's first whole month, which it cannot speak for at all — with that day; null when it leaves none out.
   */
  unread: UnreadMonths | null;
}

/**
 * The month every AVERAGE of whole months ends at today.
 *
 * ⚖️ His decision 71 (2026-10-13, asked as an either/or, the recommended option): an average uses only months EVERY
 * account he spends from has been read through to the END of — the day /spending's What-moved and the year summary
 * already cut at (`spendingCoverageThrough`). A month read to its 12th is not a twelfth of a measurement, it is none.
 * With no account you spend from there is no frontier, and the calendar's last complete month stands.
 *
 * ⛔ ONE END FOR EVERY AVERAGE. The dashboard's six months (`baselineWindow`) and /recurring's and /spending's three
 * (`paceMonths`) end here, and the income pace by the same rule at its own day (`averagesEndThrough`). 🔴 Review of
 * cbee36b: the six obeyed his decision and the threes did not — measured on his ledger copy at 2026-10-13, /recurring
 * averaged Food over Jul–Sep ("3-mo avg $1,030.43 + trend -$827.43") while Chase Checking was read only through Aug
 * 12, beside a /budgets guide that left Aug and Sep out for exactly that.
 */
export function averagesEndAt(db: AppDatabase, today: string = todayIso()): AveragesEnd {
  return averagesEndThrough(db, today, spendingCoverageThrough(db, today));
}

/**
 * `averagesEndAt` for any figure's frontier — the day every account its own rows come in on is read to (`through`;
 * null where it has none, and the calendar's last complete month stands): the INCOME pace's, `incomeCoverageThrough`.
 * ⛔ One end, one floor, one left-out list for every average: only whose day differs.
 */
export function averagesEndThrough(db: AppDatabase, today: string, through: string | null): AveragesEnd {
  const lastComplete = lastCompleteMonth(today);
  const fullyRead = through === null ? lastComplete : lastFullyReadMonth(through);
  // 'YYYY-MM' compares as text: never the running month, however far into it the accounts are read
  const month = fullyRead < lastComplete ? fullyRead : lastComplete;
  const floor = firstWholeMonth(db);
  const left: string[] = [];
  for (let m = month; m < lastComplete; ) {
    m = monthKey(addCalendarMonths(`${m}-01`, 1));
    if (floor !== null && m >= floor) left.push(m);
  }
  return { month, unread: through === null || left.length === 0 ? null : { months: left, through } };
}

/** The months an average of whole months reads today (`averagedMonths`). */
export interface AveragedMonths {
  /** 'YYYY-MM', oldest first — fewer than asked where the ledger is young, and none where it covers no whole month */
  keys: string[];
  /** `AveragesEnd.unread` */
  unread: UnreadMonths | null;
}

/**
 * The `count` calendar months an AVERAGE of whole months reads today: they end at `averagesEndAt`'s month, and none of
 * them is before the ledger's first whole month (`firstWholeMonth`).
 *
 * ⛔ ONE RULE FOR EVERY AVERAGE, ITS FLOOR TOO. `baselineWindow` (the dashboard's six, /budgets' guide) and `paceMonths`
 * (/recurring's three, /spending's and Predict budgets' three) read their months here, and the income pace its own
 * day's (`averagedMonthsThrough`, `incomePaceMonths`). A month before the ledger began
 * is not a month of nothing, it is no measurement at all (`baselineWindow` holds the 🔴 that found it), and the window
 * keeps its length by sliding back, so where the ledger is young it shortens rather than reach before the floor.
 *
 * 🔴 Review of 6d11c4d: the floor lived in `baselineWindow` alone, and `paceMonths` slid back behind the frontier past
 * it. On a ledger opening Jun 1 with one account read only to Jun 12, at 2026-08-27 /recurring paced spending over
 * Mar–May — three months before the first record — and read "Spending $0.00 … EOM cash $322.58" at the pace, under a
 * note naming those months, beside a runway saying "No month has been read in full yet".
 */
export function averagedMonths(db: AppDatabase, today: string, count: number): AveragedMonths {
  return averagedMonthsThrough(db, today, count, spendingCoverageThrough(db, today));
}

/**
 * `averagedMonths` ending at any figure's own day (`averagesEndThrough`): the `count` months the INCOME pace averages
 * today end at the last one every account his income lands in is read to the end of (`incomeCoverageThrough`), slide
 * back rather than shrink, and — like every average — none is before the ledger's first whole month.
 *
 * ⚖️ Default built, not asked (2026-10-23) — his decision 71 (2026-10-13), "a month read to its 12th is not a twelfth
 * of a measurement", carried to the income pace (batch 6's option A; he said "no more questions, follow the
 * instructions"). It once kept the calendar's months, exempt from spending's day — the accounts he SPENDS from are not
 * the ones his income lands in — and so averaged what no import had read. 🔴 Measured on his ledger copy (batch 6, at
 * 2026-10-21): every Dividends and Interest row the pace reads lands on Robinhood Cash, read to Sep 9, and the pace
 * averaged Jul–Sep — September's $0.07 of dividends as a whole month's; read in full, Jun–Aug, the rest of October
 * $11.49 → $18.02 and November $32.38 → $50.79. It returns to the calendar's months by itself as statements land.
 *
 * 🔴 Review of 06a5d3e (the floor): `variableIncomeComponents` averaged the calendar's three with no floor, and on a
 * ledger opening Jun 1 banking $3,000.00 of Salary each month, at 2026-08-27 /recurring's math read "Salary | avg of
 * last 3 periods, present 2/3 mo, × 5/31 days | +$322.58" — May, before the first record, averaged as a month of no
 * pay; the two months the ledger has say $483.87.
 */
export function averagedMonthsThrough(
  db: AppDatabase,
  today: string,
  count: number,
  through: string | null,
): AveragedMonths {
  const end = averagesEndThrough(db, today, through);
  return { keys: flooredMonths(db, end.month, count), unread: end.unread };
}

/** 'YYYY-MM': the calendar month before the one `today` is in — the last one an average could read in full. */
function lastCompleteMonth(today: string): string {
  return monthKey(addCalendarMonths(`${monthKey(today)}-01`, -1));
}

/** The `count` calendar months ending with `lastMonth` ('YYYY-MM'), oldest first, none before `firstWholeMonth`. */
function flooredMonths(db: AppDatabase, lastMonth: string, count: number): string[] {
  const floor = firstWholeMonth(db);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const key = monthKey(addCalendarMonths(`${lastMonth}-01`, -i));
    if (floor !== null && key >= floor) keys.push(key);
  }
  return keys;
}
