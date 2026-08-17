import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import {
  effectiveSeries,
  lapsedSeriesShouldStopForecasting,
  projectOccurrences,
  seriesHasLapsed,
  toProjectable,
} from "./recurring";

/**
 * Recurring calendar month (ux-overhaul-plan §4.1.3). One month of the
 * day-state grammar [MM]:
 *   - paid            green ✓ — a tagged charge posted, amount matches expected
 *   - paid_different  amber ✓ — a tagged charge posted, amount drifted
 *   - upcoming        blue    — an expected occurrence on/after today, unposted
 *   - missed          red ✗   — an expected occurrence before today, unposted
 *
 * Only detected|confirmed series contribute — dismissed/ended ones drop off the
 * calendar entirely (their tagged rows and projections are ignored). Because
 * detection advances next_expected_on past every posted charge, an expected
 * occurrence never overlaps a posting it already represents; a user
 * next-expected override could, so an expected date within ±tolerance of one of
 * the series' own postings this month is treated as that posting (not doubled).
 */

export type DayStateKind = "paid" | "paid_different" | "upcoming" | "missed";

export interface CalendarEntry {
  seriesId: string;
  name: string;
  kind: SeriesKind;
  state: DayStateKind;
  /** the posted actual amount, or the expected amount for upcoming/missed */
  amountCents: number;
  /** the series' effective per-occurrence expectation (paid_different context) */
  expectedAmountCents: number | null;
  /** present only for posted charges (paid / paid_different) */
  transactionId: string | null;
}

export interface RecurringCalendarMonth {
  /** "YYYY-MM" */
  monthKey: string;
  today: string;
  /** iso date ("YYYY-MM-DD") → that day's entries, sorted */
  entriesByDay: Record<string, CalendarEntry[]>;
  /** total entries across the month (drives the tab badge) */
  entryCount: number;
  /** net-worth-signed sum of posted charges */
  postedNetCents: number;
  /** net-worth-signed sum of future (upcoming) expected charges */
  upcomingNetCents: number;
  /** count of missed expected occurrences */
  missedCount: number;
}

/** $1 floor so a cent of rounding never reads as a price change. */
const AMOUNT_MATCH_FLOOR_CENTS = 100;
/** …or 2% of the expected magnitude, whichever is larger. */
const AMOUNT_MATCH_PCT = 0.02;
/** …or two standard deviations of the series' own amount history. */
const AMOUNT_MATCH_SIGMA = 2;

/**
 * A posted charge is "paid" when it lands within the series' own noise band of
 * the expected amount, else "paid_different" (a real price change worth seeing).
 * The band is the widest of a $1 floor, 2% of the expected magnitude, and 2σ —
 * so a series that has always varied a little does not flag every charge amber.
 */
export function classifyPostedAmount(
  postedCents: number,
  expectedCents: number,
  stddevCents: number | null,
): "paid" | "paid_different" {
  const tolerance = Math.max(
    AMOUNT_MATCH_FLOOR_CENTS,
    Math.round(Math.abs(expectedCents) * AMOUNT_MATCH_PCT),
    Math.round((stddevCents ?? 0) * AMOUNT_MATCH_SIGMA),
  );
  return Math.abs(postedCents - expectedCents) <= tolerance ? "paid" : "paid_different";
}

/** Missed first (needs attention), then drift, then paid, then upcoming. */
const DAY_STATE_ORDER: Record<DayStateKind, number> = {
  missed: 0,
  paid_different: 1,
  paid: 2,
  upcoming: 3,
};

export function recurringCalendar(
  db: AppDatabase,
  month: string = monthKey(todayIso()),
  today: string = todayIso(),
): RecurringCalendarMonth {
  const { start: monthStart, end: monthEnd } = periodBounds(`${month}-01`, "monthly");

  const seriesRows = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();
  const seriesById = new Map(seriesRows.map((s) => [s.id, s]));

  const entriesByDay: Record<string, CalendarEntry[]> = {};
  const pushEntry = (date: string, entry: CalendarEntry): void => {
    (entriesByDay[date] ??= []).push(entry);
  };

  // 1) posted charges tagged to an active series, inside the month
  const postedDatesBySeries = new Map<string, string[]>();
  if (seriesRows.length > 0) {
    const posted = db
      .select({
        id: transactions.id,
        seriesId: transactions.recurringSeriesId,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, "active"),
          isNotNull(transactions.recurringSeriesId),
          gte(transactions.postedOn, monthStart),
          lte(transactions.postedOn, monthEnd),
        ),
      )
      .all();

    for (const p of posted) {
      const s = p.seriesId ? seriesById.get(p.seriesId) : undefined;
      if (!s) continue; // tagged to a dismissed/ended series → not on this calendar
      const expected = effectiveSeries(s).nextExpectedAmountCents;
      const state: DayStateKind =
        expected === null ? "paid" : classifyPostedAmount(p.amountCents, expected, s.amountCentsStddev);
      pushEntry(p.postedOn, {
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        state,
        amountCents: p.amountCents,
        expectedAmountCents: expected,
        transactionId: p.id,
      });
      const dates = postedDatesBySeries.get(s.id) ?? [];
      dates.push(p.postedOn);
      postedDatesBySeries.set(s.id, dates);
    }
  }

  // 2) expected occurrences (upcoming / missed) not already covered by a posting.
  // A series whose evidence has RUN OUT must not litter the month with charges
  // it will never make (its historical postings in step 1 still show); a new
  // charge auto-restores it, because re-detection moves lastMatchedOn.
  //
  // ⚠️ `seriesHasLapsed`, not `isSeriesActive`. The two differ on exactly one
  // population and it is the one that matters here: a series that has NEVER
  // posted. `isSeriesActive` calls it inactive — the right answer to "is there
  // evidence for this?" and the wrong gate for a forecast. Measured on the real
  // ledger: the owner's Car lease ($559.89) and Car insurance ($361.49), both
  // registered for 2026-09-11 with no postings yet, were absent from every
  // calendar month under the old gate. Lapsed means "it stopped", which only a
  // series that once started can do.
  for (const s of seriesRows) {
    if (lapsedSeriesShouldStopForecasting(s.kind) && seriesHasLapsed(s, today)) continue;
    const occurrences = projectOccurrences(toProjectable(s), monthStart, monthEnd);
    const postedDates = postedDatesBySeries.get(s.id) ?? [];
    for (const o of occurrences) {
      const alreadyPosted = postedDates.some((p) => Math.abs(diffDays(p, o.date)) <= s.toleranceDays);
      if (alreadyPosted) continue;
      const state: DayStateKind = compareDates(o.date, today) >= 0 ? "upcoming" : "missed";
      pushEntry(o.date, {
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        state,
        amountCents: o.amountCents,
        expectedAmountCents: o.amountCents,
        transactionId: null,
      });
    }
  }

  let entryCount = 0;
  let postedNetCents = 0;
  let upcomingNetCents = 0;
  let missedCount = 0;
  for (const date of Object.keys(entriesByDay)) {
    entriesByDay[date]!.sort(
      (a, b) => DAY_STATE_ORDER[a.state] - DAY_STATE_ORDER[b.state] || a.name.localeCompare(b.name),
    );
    for (const e of entriesByDay[date]!) {
      entryCount += 1;
      if (e.transactionId !== null) postedNetCents += e.amountCents;
      else if (e.state === "upcoming") upcomingNetCents += e.amountCents;
      else missedCount += 1;
    }
  }

  return { monthKey: month, today, entriesByDay, entryCount, postedNetCents, upcomingNetCents, missedCount };
}
