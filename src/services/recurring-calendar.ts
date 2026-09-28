import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { isCategoryHueName, type CategoryHueName } from "@/lib/category-palette";
import { compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { RECURRING_HISTORY_STATUSES } from "@/lib/series-evidence";
import {
  forecastConfidence,
  settledVerdict,
  STATE_ATTENTION_ORDER,
  type ForecastConfidence,
  type OccurrenceState,
  type UnsettledReason,
} from "@/lib/occurrence-verdict";
import { loadCategoryIndex } from "./analytics";
import { frontierForSeries, observationFrontier, seriesAccountIds } from "./observation-frontier";
import { settledPaydaysBySeries } from "./payday-settlement";
import {
  effectiveSeries,
  lapsedSeriesShouldStopForecasting,
  MIN_OCCURRENCES,
  populationStddev,
  projectOccurrences,
  seriesEvidence,
  seriesHasLapsed,
  toProjectable,
} from "./recurring";

/**
 * Recurring calendar month (ux-overhaul-plan §4.1.3). One month of the
 * day-state grammar [MM]:
 *   - paid            green ✓ — a tagged charge posted, amount matches expected
 *   - paid_different  amber ! — a tagged charge posted, amount drifted
 *   - upcoming        blue •  — an expected occurrence on/after today, unposted
 *   - missed          red ✕   — expected before today, unposted, day IS imported
 *   - unsettled       grey ?  — expected before today, unposted, and the ledger
 *                               cannot yet say (see `occurrence-verdict`)
 *
 * ## Which series contribute, and to WHAT
 *
 * Two populations, not one — the single `status IN ('detected','confirmed')`
 * filter this used to apply was answering two different questions with one rule,
 * and got one of them badly wrong.
 *
 *  - **History** (posted charges): detected | confirmed | **ended**.
 *    An `ended` series did not stop having existed. Fordham work-study and Knack
 *    tutoring really did pay him, 116 times between 2023-03 and 2026-05, and
 *    every one of those rows was already tagged and already correct — they were
 *    erased from the calendar for the sole reason that the jobs have since
 *    ended. Measured on the real ledger: 172 of 274 tagged rows, which is why
 *    every month before 2025-09 drew literally nothing.
 *
 *  - **Forecast** (upcoming / missed / unsettled): detected | confirmed only.
 *    An ended series' future is not real, and projecting one would invent
 *    charges. Its history shows; its forecast does not.
 *
 *  - **`dismissed` contributes to NEITHER**, and this is not an oversight.
 *    Dismiss is labelled "Not recurring" in the UI (SeriesDetail.tsx) — it is the
 *    owner saying the detector was wrong, and the 45 rows behind it are real
 *    transactions that are not a series. Showing them on a recurring calendar
 *    would re-assert exactly the claim he rejected.
 *
 * Because detection advances next_expected_on past every posted charge, an
 * expected occurrence never overlaps a posting it already represents; a user
 * next-expected override could, so an expected date within ±tolerance of one of
 * the series' own postings this month is treated as that posting (not doubled).
 */
/** The calendar's day-state grammar — see `occurrence-verdict` for the split. */
export type DayStateKind = OccurrenceState;

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
  /**
   * The `posted_on` of the deposit that paid this payday down, on an entry that
   * carries no posting of its own. Non-null exactly when this is a settled
   * payday (`services/payday-settlement`, his decision of 2026-09-28).
   *
   * ⛔ IT HAS TO BE NAMED, because the word beside it is borrowed. `paid` is
   * defined in the legend as "a charge for this bill turned up on the expected
   * day" (RECURRING_JARGON.paid) and nothing turned up on Aug 27 — the money
   * landed Sep 24. The date makes the chip's own claim checkable: the cell's
   * aria-label and the Day Sheet both print it, and the reader can go to that
   * day and find the row.
   *
   * ⛔ AND IT DECIDES WHICH FOOTER FIGURE OWNS THE MONEY. A payday settled by a
   * deposit from ANOTHER month is in no posted row this month draws, so the
   * month's Settled total counts it here; one settled by a deposit inside the
   * month is already inside that deposit's own row and must not be added again.
   */
  settledByDepositOn: string | null;
  /**
   * Why the ledger cannot settle this. Non-null exactly when `state` is
   * "unsettled" — the state and its reason come from ONE `settledVerdict` call
   * so a cell can never print a verdict beside the wrong explanation.
   */
  unsettledReason: UnsettledReason | null;
  /**
   * How firmly this forecast is asserted. Non-null exactly when `state` is
   * "upcoming" — a settled day needs no confidence, it has an outcome.
   */
  confidence: ForecastConfidence | null;
  /**
   * Whether the SERIES is running late: it has charged before, and its newest
   * charge is older than its own tolerance (`seriesEvidence` says
   * "running-late"). Only on a future entry.
   *
   * A third axis, and deliberately not a third visual channel. `confidence`
   * answers "who said this?" and staleness answers "when was it last seen?" —
   * both true at once, and the owner's cash job is the case that proves they are
   * independent: he typed the amount himself, which makes it `scheduled` and
   * correctly the firmest claim on the page, while it has not posted in 81 days.
   * Crossing five states by three confidences by two stalenesses is thirty
   * swatches, so this one rides in WORDS — the Day Sheet and the cell's
   * aria-label, where a reader has already asked for detail and there is room to
   * answer properly.
   *
   * 🔴 A series that has NEVER charged is not stale — there is no evidence for
   * it to be stale from. This read `seriesStaleness(s).isStale`, which is true
   * for nothing-matched by design; `staleSummaryLabel` and `stalePartLabel`
   * (components/recurring/labels) had already split that union, and the
   * calendar was the one reader that never did. Measured on the real ledger
   * 2026-09-14: `/recurring?tab=calendar` printed "Car lease upcoming
   * (scheduled, evidence stale) -$695.04" and "Gym upcoming (scheduled, evidence
   * stale) -$100.00" on the page that also said "3 have never charged" — and
   * 39 of the 123 upcoming entries flagged stale across 2023-01..2027-08 were
   * series that had never charged at all. Those carry `neverBilled` instead.
   */
  isStale: boolean;
  /**
   * The series has never charged: a commitment registered by hand that the bank
   * has not billed yet (`seriesEvidence` says "never-billed"). Only on a future
   * entry, and never together with `isStale`.
   *
   * Printed in the All tab's own word, `SERIES_EVIDENCE_LABEL["never-billed"]`
   * — "Car lease upcoming (scheduled, never billed)", and a "Never billed" badge
   * in the Day Sheet. The owner's decision, 2026-09-14.
   */
  neverBilled: boolean;
  /**
   * The series' category hue, for the mark drawn beside it.
   *
   * Colour here is IDENTITY, not state — the same 12-hue ramp `/categories` and
   * every chip in the app already use, so a violet tile means Travel on this
   * page exactly as it does everywhere else. `null` for a series whose category
   * cannot be determined, which draws a neutral tile rather than a guessed one.
   */
  hue: CategoryHueName | null;
}

/**
 * A payday settled by a deposit that landed OUTSIDE the month being drawn.
 *
 * ⛔ ONE SPELLING, because two readers need the answer and they publish figures
 * that sit beside each other: the month footer's Settled total counts this
 * entry (no row this month draws contains its money), and the flow strip above
 * that footer has to climb by the same money or the page repeats pass 58's
 * failure — a line climbing to +$3,141 directly above "SETTLED $0.00".
 */
export function paidByAnotherMonth(e: CalendarEntry, monthKey: string): boolean {
  return e.settledByDepositOn !== null && !e.settledByDepositOn.startsWith(`${monthKey}-`);
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
  /** count of missed expected occurrences — days the ledger HAS been shown */
  missedCount: number;
  /** count of past occurrences the ledger cannot yet speak to */
  unsettledCount: number;
  /**
   * GROSS magnitude of those unsettled occurrences — the sum of absolutes.
   *
   * Published because the footer used to pair "Posted $0.00" with six red marks,
   * which reads as a month in which nothing happened and everything failed. The
   * money is not zero; it is unmeasured, and that is a different sentence.
   *
   * ⚠️ Gross and not net, which is the opposite of every other total on this
   * page and is the whole point. A net cancels: August 2026 holds three
   * ungradeable paydays of $1,047.00 and one $6.00 subscription, and a month
   * whose unknown income happened to balance its unknown bills would publish
   * "$0.00 not yet known (2)" — a measured zero standing over money nobody has
   * measured. That is pass 62's defect exactly, where a total was drawn as a
   * 77.97px bar labelled "$0.00". This figure answers "how much of this month is
   * unaccounted for", which is an exposure rather than a movement, and it cannot
   * read zero while the count is non-zero.
   */
  unsettledGrossCents: number;
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
 *
 * ## `stddevCents === null` means UNKNOWN, and unknown is not zero
 *
 * This read `stddevCents ?? 0`, which quietly asserted that a series nobody had
 * ever measured has no variation at all — collapsing the band to the $1/2%
 * hairline and calling every ordinary fluctuation a price change.
 *
 * It only became visible once `ended` series brought three years of history
 * back onto the grid, and then it was everywhere. `amount_cents_stddev` is null
 * on exactly the eight hand-created series — the ones the owner's own
 * clarification scripts wrote, which never ran detection's statistics — and two
 * of those are his variable-income jobs:
 *
 * | series | postings | real range | cached σ | 2% band |
 * |---|---|---|---|---|
 * | Knack Tutoring | 60 | $24.00 – $918.00 | *null* | ±$3.34 |
 * | Fordham Payroll | 56 | $87.17 – $1,744.41 | *null* | ±$15.24 |
 *
 * April 2026 drew eight of its nine marks amber on that basis: a tutoring
 * session of $173.25 against a $167.05 average was reported as an amount
 * CHANGE. It is not a change, it is a shorter lesson — and "the amount changed"
 * is a claim about a series' normal, which is precisely the thing not measured
 * here.
 *
 * So the band is measured from the postings when there are enough of them, and
 * when there are not, no drift is claimed at all. `MIN_OCCURRENCES` is
 * detection's own threshold for having a statistic rather than an anecdote, and
 * reusing it keeps one definition of "enough points" in the codebase.
 */
export function classifyPostedAmount(
  postedCents: number,
  expectedCents: number,
  stddevCents: number | null,
): "paid" | "paid_different" {
  // No measured variance → no entitlement to call anything a change.
  if (stddevCents === null) return "paid";
  const tolerance = Math.max(
    AMOUNT_MATCH_FLOOR_CENTS,
    Math.round(Math.abs(expectedCents) * AMOUNT_MATCH_PCT),
    Math.round(stddevCents * AMOUNT_MATCH_SIGMA),
  );
  return Math.abs(postedCents - expectedCents) <= tolerance ? "paid" : "paid_different";
}

/**
 * Each series' amount spread, measured from its own tagged postings, for the
 * series whose cached `amount_cents_stddev` is null.
 *
 * Read-time rather than a backfill: tagging is derived data and a write would
 * need the pass-24 guarded-write playbook to add a column detection will
 * recompute for itself the next time it runs. One query over 229 rows is
 * cheaper than a migration and cannot drift from the rows it summarises.
 *
 * Series under `MIN_OCCURRENCES` postings are deliberately left OUT of the map,
 * so they keep reading `null` and keep making no claim — three points is
 * detection's own floor for calling something a statistic.
 */
/**
 * How many active rows are tagged to each series — the input to
 * `ScheduleProven`, which is the only thing this is used for.
 *
 * Counted from the rows rather than read from a column, because there is no
 * column: `listSeries` derives the same number the same way. Compared against
 * `MIN_OCCURRENCES`, so the codebase keeps ONE definition of "enough
 * occurrences to be a statistic" — the same threshold `measuredStddevs` uses
 * below for the same reason.
 */
/**
 * Is this series' expected DATE worth holding a biller to? See `ScheduleProven`
 * for the full argument — in short, the count is a proxy for where the date came
 * from: zero postings means a human authored it, one or two means detection
 * extrapolated it from too little, and `MIN_OCCURRENCES` or more means it was
 * measured.
 *
 * ⚠️ A date typed by hand with one or two charges linked to it by hand also
 * lands in the middle band — Car insurance did on 2026-09-03 — so the reason
 * this produces is worded for what is COUNTED, "too few charges to grade yet"
 * (`unsettledReasonWord`), not "due date not established". See `ScheduleProven`
 * for why the gate itself must not be widened to trust that date.
 */
export function scheduleIsProven(postingCount: number): boolean {
  return postingCount === 0 || postingCount >= MIN_OCCURRENCES;
}

/**
 * Each series' category hue — its `user_category_id` where the owner set one,
 * otherwise the top-level category most of its postings landed in.
 *
 * Modal rather than first or newest: a series' rows can disagree (a rent payment
 * once filed under Transfers), and the majority is the honest read of where the
 * ledger thinks this money goes. Ties keep whichever the scan met first, which
 * is deterministic because the rows are ordered by the query.
 *
 * ⚠️ `loadCategoryIndex` rather than a self-join. `aliasedTable` breaks drizzle's
 * row inference — the rows type as `never` while working perfectly at runtime,
 * so `tsc` fails on code the tests all pass.
 */
function seriesHues(db: AppDatabase): Map<string, CategoryHueName> {
  const index = loadCategoryIndex(db);
  const colorById = new Map(
    db.select({ id: categories.id, color: categories.color }).from(categories).all()
      .map((c) => [c.id, c.color] as const),
  );

  const hueOf = (categoryId: string | null): CategoryHueName | null => {
    if (!categoryId || !index.byId.has(categoryId)) return null;
    const color = colorById.get(index.topLevelOf(categoryId).id);
    return isCategoryHueName(color) ? color : null;
  };

  const out = new Map<string, CategoryHueName>();
  const tally = new Map<string, Map<string, number>>();
  for (const r of db
    .select({
      seriesId: transactions.recurringSeriesId,
      categoryId: transactions.categoryId,
      n: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), isNotNull(transactions.recurringSeriesId)))
    .groupBy(transactions.recurringSeriesId, transactions.categoryId)
    .all()) {
    if (!r.seriesId || !r.categoryId) continue;
    const forSeries = tally.get(r.seriesId) ?? new Map<string, number>();
    forSeries.set(r.categoryId, Number(r.n));
    tally.set(r.seriesId, forSeries);
  }
  for (const [seriesId, counts] of tally) {
    let best: string | null = null;
    let bestN = 0;
    for (const [categoryId, n] of counts) {
      if (n > bestN) {
        best = categoryId;
        bestN = n;
      }
    }
    const hue = hueOf(best);
    if (hue) out.set(seriesId, hue);
  }

  // The owner's own answer wins over anything derived from postings — the same
  // OVERRIDE-not-union rule `budgetTail` follows for this column.
  for (const s of db
    .select({ id: recurringSeries.id, userCategoryId: recurringSeries.userCategoryId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userCategoryId))
    .all()) {
    const hue = hueOf(s.userCategoryId);
    if (hue) out.set(s.id, hue);
    else out.delete(s.id);
  }

  return out;
}

function postingCountBySeries(db: AppDatabase): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db
    .select({ seriesId: transactions.recurringSeriesId, n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), isNotNull(transactions.recurringSeriesId)))
    .groupBy(transactions.recurringSeriesId)
    .all()) {
    if (r.seriesId) out.set(r.seriesId, Number(r.n));
  }
  return out;
}

function measuredStddevs(db: AppDatabase, seriesIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (seriesIds.length === 0) return out;

  const byId = new Map<string, number[]>();
  for (const r of db
    .select({ seriesId: transactions.recurringSeriesId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        inArray(transactions.recurringSeriesId, [...seriesIds]),
      ),
    )
    .all()) {
    if (!r.seriesId) continue;
    const list = byId.get(r.seriesId);
    if (list) list.push(r.amountCents);
    else byId.set(r.seriesId, [r.amountCents]);
  }

  for (const [id, amounts] of byId) {
    if (amounts.length < MIN_OCCURRENCES) continue;
    out.set(id, populationStddev(amounts));
  }
  return out;
}

export function recurringCalendar(
  db: AppDatabase,
  month: string = monthKey(todayIso()),
  today: string = todayIso(),
): RecurringCalendarMonth {
  const { start: monthStart, end: monthEnd } = periodBounds(`${month}-01`, "monthly");

  // Two populations (see the module docstring): everything that may draw
  // HISTORY, and the subset of it whose FUTURE is real.
  const historyRows = db
    .select()
    .from(recurringSeries)
    // every status `seriesDrawsAsRecurring` draws — dismissed is not one
    .where(inArray(recurringSeries.status, [...RECURRING_HISTORY_STATUSES]))
    .all();
  const seriesById = new Map(historyRows.map((s) => [s.id, s]));
  const forecastRows = historyRows.filter((s) => s.status === "detected" || s.status === "confirmed");
  const measured = measuredStddevs(
    db,
    historyRows.filter((s) => s.amountCentsStddev === null).map((s) => s.id),
  );
  const postingCounts = postingCountBySeries(db);
  const hues = seriesHues(db);

  const entriesByDay: Record<string, CalendarEntry[]> = {};
  const pushEntry = (date: string, entry: CalendarEntry): void => {
    (entriesByDay[date] ??= []).push(entry);
  };

  // 1) posted charges tagged to a drawable series, inside the month
  const postedDatesBySeries = new Map<string, string[]>();
  if (historyRows.length > 0) {
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
      if (!s) continue; // tagged to a DISMISSED series — the owner said not recurring
      const expected = effectiveSeries(s).nextExpectedAmountCents;
      const stddev = s.amountCentsStddev ?? measured.get(s.id) ?? null;
      const state: DayStateKind =
        expected === null ? "paid" : classifyPostedAmount(p.amountCents, expected, stddev);
      pushEntry(p.postedOn, {
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        state,
        amountCents: p.amountCents,
        expectedAmountCents: expected,
        transactionId: p.id,
        settledByDepositOn: null,
        unsettledReason: null,
        confidence: null,
        isStale: false,
        neverBilled: false,
        hue: hues.get(s.id) ?? null,
      });
      const dates = postedDatesBySeries.get(s.id) ?? [];
      dates.push(p.postedOn);
      postedDatesBySeries.set(s.id, dates);
    }
  }

  // 2) expected occurrences (upcoming / missed / unsettled) not already covered
  // by a posting. A series whose evidence has RUN OUT must not litter the month
  // with charges it will never make (its historical postings in step 1 still
  // show); a new charge auto-restores it, because re-detection moves
  // lastMatchedOn.
  //
  // ⚠️ `seriesHasLapsed`, not `isSeriesActive`. The two differ on exactly one
  // population and it is the one that matters here: a series that has NEVER
  // posted. `isSeriesActive` calls it inactive — the right answer to "is there
  // evidence for this?" and the wrong gate for a forecast. Measured on the real
  // ledger: the owner's Car lease ($559.89) and Car insurance ($361.49), both
  // registered for 2026-09-11 with no postings yet, were absent from every
  // calendar month under the old gate. Lapsed means "it stopped", which only a
  // series that once started can do.
  //
  // The frontier lookups are hoisted out of the loop and skipped entirely for a
  // month that ends on or after today: a wholly-future month has no past
  // occurrence to grade, so it needs no coverage query at all.
  const needsFrontier = compareDates(monthStart, today) < 0;
  const frontier = needsFrontier ? observationFrontier(db) : null;
  const accountsBySeries = needsFrontier ? seriesAccountIds(db) : null;

  /*
   * ⚖️ SETTLE BACKWARDS, his decision of 2026-09-28: a deposit attributed to a
   * pay series pays down the paydays behind it up to its amount, so a payday a
   * later lump retired draws PAID rather than a red "unsettled (unbanked)".
   *
   * 🔴 Without it those marks were permanent. Measured on his ledger the same
   * day, with $4,567.68 banked on Sep 23 and $1,141.92 on Sep 24, Sep 3, Sep 10,
   * Sep 17 and all four August paydays were still drawn unsettled — and no
   * future deposit could ever have cleared them, because one deposit met
   * exactly one payday.
   *
   * `services/payday-settlement` is the only place that answers this, shared
   * with /budgets and `unbankedIncomeForSeries`. A calendar with a rule of its
   * own is how this codebase came to say two things about one Thursday.
   * Income only: settlement speaks about deposits, and a bill's absence is
   * still graded by `settledVerdict` exactly as before.
   */
  const settledPaydays = settledPaydaysBySeries(
    db,
    forecastRows.filter((s) => s.kind === "income").map((s) => s.id),
    today,
  );

  for (const s of forecastRows) {
    if (lapsedSeriesShouldStopForecasting(s.kind) && seriesHasLapsed(s, today)) continue;
    const occurrences = projectOccurrences(toProjectable(s), monthStart, monthEnd);
    const postedDates = postedDatesBySeries.get(s.id) ?? [];
    const confidence = forecastConfidence(s);
    // ONE evidence word, the one the All tab files the series under: a series
    // that never charged is "never billed", not stale (see `CalendarEntry.isStale`).
    // A lapsed money-out series was skipped above and money in never lapses, so
    // "running-late" is exactly "stale, having charged before".
    const evidence = seriesEvidence(s, today);
    const isStale = evidence === "running-late";
    const neverBilled = evidence === "never-billed";
    for (const o of occurrences) {
      const alreadyPosted = postedDates.some((p) => Math.abs(diffDays(p, o.date)) <= s.toleranceDays);
      if (alreadyPosted) continue;

      /*
       * A payday a deposit has already paid down. It draws paid and carries no
       * transaction of its own: the money is on the lump's row, which is drawn
       * on the day it actually landed — and `settledByDepositOn` says which day
       * that was, so the chip's claim can be checked and the footer knows
       * whether this month's Settled total already contains the money.
       */
      const settledOn = settledPaydays.get(s.id)?.get(o.date);
      if (settledOn !== undefined) {
        pushEntry(o.date, {
          seriesId: s.id,
          name: s.name,
          kind: s.kind,
          state: "paid",
          amountCents: o.amountCents,
          expectedAmountCents: o.amountCents,
          transactionId: null,
          settledByDepositOn: settledOn,
          unsettledReason: null,
          confidence: null,
          isStale: false,
          neverBilled: false,
          hue: hues.get(s.id) ?? null,
        });
        continue;
      }

      const isFuture = compareDates(o.date, today) >= 0;
      // The state and its reason are one decision, taken once. Splitting them
      // is how `budgetVerdict` came to print a headline beside a definition that
      // contradicted it.
      const verdict = isFuture
        ? null
        : settledVerdict(
            s.kind,
            o.date,
            frontier ? frontierForSeries(frontier, accountsBySeries?.get(s.id)) : null,
            scheduleIsProven(postingCounts.get(s.id) ?? 0),
          );

      pushEntry(o.date, {
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        state: verdict?.state ?? "upcoming",
        amountCents: o.amountCents,
        expectedAmountCents: o.amountCents,
        transactionId: null,
        settledByDepositOn: null,
        unsettledReason: verdict?.reason ?? null,
        confidence: isFuture ? confidence : null,
        isStale: isFuture && isStale,
        neverBilled: isFuture && neverBilled,
        hue: hues.get(s.id) ?? null,
      });
    }
  }

  let entryCount = 0;
  let postedNetCents = 0;
  let upcomingNetCents = 0;
  let missedCount = 0;
  let unsettledCount = 0;
  let unsettledGrossCents = 0;
  for (const date of Object.keys(entriesByDay)) {
    entriesByDay[date]!.sort(
      (a, b) => STATE_ATTENTION_ORDER[a.state] - STATE_ATTENTION_ORDER[b.state] || a.name.localeCompare(b.name),
    );
    for (const e of entriesByDay[date]!) {
      entryCount += 1;
      if (e.transactionId !== null) postedNetCents += e.amountCents;
      /*
       * ⛔ A SETTLED PAYDAY WHOSE MONEY LANDED IN ANOTHER MONTH BELONGS TO THIS
       * MONTH'S SETTLED TOTAL, because no row this month draws contains it.
       *
       * 🔴 Without this the chip stood in no figure at all. August 2026, read
       * 2026-09-28: Aug 27 drawn green "Paid $1,141.92" directly above a footer
       * reading SETTLED $0.00, EXPECTED $0.00 — the headline-contradicts-its-own
       * -footer failure this file's own comments warn about twice. September
       * drew three more such chips ($3,425.76) that appeared in no total.
       *
       * ⚠️ And only when it landed elsewhere. Sep 3, Sep 10 and Sep 17 were paid
       * by the lump of Sep 23, which September already draws as a row of its
       * own: counting them here as well would publish $9,135.36 of pay in a
       * month that received $5,709.60.
       */
      else if (paidByAnotherMonth(e, month)) postedNetCents += e.amountCents;
      else if (e.state === "upcoming") upcomingNetCents += e.amountCents;
      else if (e.state === "unsettled") {
        unsettledCount += 1;
        unsettledGrossCents += Math.abs(e.amountCents);
      }
      /*
       * ⛔ A SETTLED PAYDAY CARRIES NO TRANSACTION OF ITS OWN — the deposit that
       * paid it is drawn on the day it landed — so it must not fall through to
       * the missed tally, which would count a payday as missed on the very
       * reading that says it was paid.
       */
      else if (e.state !== "paid" && e.state !== "paid_different") missedCount += 1;
    }
  }

  return {
    monthKey: month,
    today,
    entriesByDay,
    entryCount,
    postedNetCents,
    upcomingNetCents,
    missedCount,
    unsettledCount,
    unsettledGrossCents,
  };
}
