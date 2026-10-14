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
  /** 'YYYY-MM': the last complete calendar month, or the last one every account you spend from is read to the end of */
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
 * (`paceMonths`) end here. 🔴 Review of cbee36b: the six obeyed his decision and the threes did not — measured on his
 * ledger copy at 2026-10-13, /recurring averaged Food over Jul–Sep ("3-mo avg $1,030.43 + trend -$827.43") while
 * Chase Checking was read only through Aug 12, beside a /budgets guide that left Aug and Sep out for exactly that.
 */
export function averagesEndAt(db: AppDatabase, today: string = todayIso()): AveragesEnd {
  const lastComplete = monthKey(addCalendarMonths(`${monthKey(today)}-01`, -1));
  const through = spendingCoverageThrough(db, today);
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
