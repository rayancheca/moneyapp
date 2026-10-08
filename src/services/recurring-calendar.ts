import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { daysInMonthOf } from "@/lib/calendar-math";
import { isCategoryHueName, type CategoryHueName } from "@/lib/category-palette";
import { compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { flowEntryOf, monthFlow, type MonthFlow, type MonthFlowEntry } from "@/lib/month-flow";
import { hasArrived, portionsAcross, type SettlementPortion } from "@/lib/payday-settlement";
import {
  comparableCents,
  expectedCentsOf,
  spreadResidualCents,
  type PaydayReading,
  type PerPayday,
} from "@/lib/per-payday";
import { RECURRING_HISTORY_STATUSES } from "@/lib/series-evidence";
import { billedWithPhrase } from "@/lib/billed-with";
import {
  forecastConfidence,
  settledVerdict,
  STATE_ATTENTION_ORDER,
  type ForecastConfidence,
  type OccurrenceState,
  type UnsettledReason,
} from "@/lib/occurrence-verdict";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isAgentsSeries, loadCategoryIndex } from "./analytics";
import { withBillingCarriers } from "./billing-carriers";
import { frontierForSeries, observationFrontier, seriesAccountIds } from "./observation-frontier";
import {
  paydayProjectable,
  paydayReadingsBySeries,
  paydaySettlementsBySeries,
  readsPerPayday,
} from "./payday-settlement";
import {
  effectiveSeries,
  hasStoppedForecasting,
  MIN_OCCURRENCES,
  populationStddev,
  projectOccurrences,
  seriesEvidence,
} from "./recurring";
import { seriesCategoryIds } from "./series-category";

/**
 * Recurring calendar month (ux-overhaul-plan §4.1.3). One month of the
 * day-state grammar [MM]:
 *   - paid            green ✓ — a tagged charge posted, amount matches expected
 *   - paid_different  amber ! — a tagged charge posted, amount drifted (a pay
 *                               deposit: what it paid per payday, `lib/per-payday`)
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
 *  - **Nor does the agent's money**: a series on the agent's cash
 *    (`isAgentsSeries`) schedules income or costs that are not his, by his
 *    decisions of 2026-09-28 and 2026-10-02 — see `recurringCalendar`.
 *
 * Because detection advances next_expected_on past every posted charge, an
 * expected occurrence never overlaps a posting it already represents; a user
 * next-expected override could, so an expected date within ±tolerance of one of
 * the series' own postings this month is treated as that posting (not doubled).
 * A PAYDAY is the exception: which deposit paid it is settlement's answer
 * (`services/payday-settlement`), and a row merely lying near it is not.
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
   * The `posted_on` of each deposit whose MONEY paid this payday down, oldest
   * first, on an entry that carries no posting of its own. Non-empty exactly
   * when this is a settled payday drawn as a mark of its own
   * (`services/payday-settlement`, his decision of 2026-09-28).
   *
   * ⛔ IT HAS TO BE NAMED, because the word beside it is borrowed. `paid` is
   * defined in the legend as "a charge for this bill turned up on the expected
   * day" (RECURRING_JARGON.paid) and nothing turned up on Aug 27 — the money
   * landed Sep 24. The date makes the chip's own claim checkable: the cell's
   * aria-label and the Day Sheet both print it, and the reader can go to that
   * day and find the row.
   *
   * ⛔ WHOSE MONEY, not whose walk. Settlement says which deposit's walk retired
   * a payday (`settledBy`) and whose money paid it (`portions`), and the two
   * part when change carried over from an earlier deposit is spent. Measured on
   * his ledger 2026-10-01: the lump of Sep 23 walked to Aug 27 on June's money —
   * its own $4,567.68 paid Sep 3 through Sep 24 — so a chip naming the lump
   * claimed five weeks out of a four-week deposit, while /budgets named the June
   * deposits. A list, because pooled money can come from more than one day.
   */
  settledByDepositsOn: readonly string[];
  /**
   * The paydays OUTSIDE this month that a posted deposit's money paid down,
   * oldest first — the mirror of `settledByDepositsOn`, on the row whose money
   * it was. Empty on every other entry.
   *
   * 🔴 Without it a deposit drawn on a payday read as that payday's pay while
   * another month's chip named it too. Wed Sep 30's lump pays Thu Oct 1, and the
   * Oct 1 deposit — its own payday already paid — pays Aug 27: October drew
   * that row green on Oct 1 and August chipped Aug 27 "paid by the deposit of
   * Oct 1", one deposit for two paydays. /budgets names the same money ("went
   * toward 1 payday outside this month (Thu, Aug 27, 2026)"); so does the row.
   */
  settlesPaydaysOn: readonly string[];
  /**
   * On a posted pay row whose money paid two or more paydays on its own — a
   * lump — those paydays and what it paid each (`lib/per-payday`); null on
   * every other entry. `state` grades `cents` against the expectation, so a
   * lump of four weeks at $1,141.92 is `paid`, and its cell and Day Sheet say
   * "4 paydays at $1,141.92 each" rather than leave $4,567.68 standing beside a
   * $1,141.92 week.
   */
  perPayday: PerPayday | null;
  /**
   * On a posted pay row whose day's money paid NO payday at all (`PaydayReading.towardNoPayday`): left over past the
   * paydays it could reach (owner decision 2026-10-08, §6A 55b — a deposit's money pays nothing after its own date
   * plus the tolerance), or landed before the first payday the ledger draws. Its words say "toward no payday", and it
   * is not graded — `state` is `paid`, never `paid_different`, because it answers no week whose amount it could
   * have changed. False on every other entry.
   *
   * 🔴 Before the reach bound June's $1,047.00 and $400.00 rode forward through the summer and read "paid (toward
   * the payday of Aug 27, 2026)" — June's money named as the pay of a week eleven weeks later.
   */
  towardNoPayday: boolean;
  /**
   * What this mark adds to the month's Settled figure, or null for a mark that
   * has not settled (upcoming, missed, not yet known). The footer's Settled
   * total and the flow strip's posted line are both the sum of these, and each
   * day's cell, heat and "Day total" read them too (`dayTotalCents`).
   *
   * ⛔ EACH CENT IN ONE MONTH: the month of the payday it paid. A posted row
   * carries its amount less the money settlement spent on another month's
   * paydays (`settlesPaydaysOn` — that month's chip counts it); a payday chip
   * carries the money ANOTHER month's deposits put into it, since no row this
   * month draws holds it; a chip paid from a deposit inside the month carries
   * nothing, because that deposit's own row already does.
   *
   * 🔴 Measured on his ledger 2026-10-01: the Sep 24 deposit paid Aug 20 and
   * two June deposits paid Aug 27, and those $2,283.84 were in August's Settled
   * figure (as chips) AND in September's and June's (as rows) — $9,440.44 of
   * Settled across the three months for $7,156.60 of pay.
   */
  settledCents: number | null;
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
   * ⚖️ "billed with the rent" — the series is paid inside another series' payment (`billedWithPhrase`, owner decision
   * 2026-10-08, §6A 59), so its evidence is the carrier's. Only on a future entry, like `neverBilled`; null otherwise.
   * Printed where "never billed" stood: "Rent utilities & fees upcoming (scheduled, billed with the rent)".
   */
  billedWith: string | null;
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
 * The month strip's two running totals (`lib/month-flow`), over exactly the entries the grid draws: its "as
 * scheduled" is `endCents`, the figure printed directly under the forecast card's net. Here rather than inside the
 * component so a test reads the number the page prints, not a copy of how the page computes it.
 *
 * `settled` is the POSTED flag, not "is it in the past". The two are not the same thing and the difference is the
 * whole point of the second line: August 2026 has three cash paydays behind today that never reached the ledger, so a
 * line split by date climbed confidently to +$3,141 directly above a footer reading "SETTLED $0.00". Each mark climbs
 * by its own `settledCents` (`flowEntryOf`) — the figure the footer's Settled total sums, so a payday whose money
 * landed on another day or in another month is counted once, where settlement says it was paid.
 *
 * ⚖️ A transfer's mark adds nothing to either line (`flowEntryOf`): the card's net leaves transfer series out
 * (`seriesIsIncomeOrSpending`), and a strip that summed them printed a different month directly under it.
 */
export function calendarMonthFlow(month: RecurringCalendarMonth, today: string): MonthFlow {
  const flowEntries: Record<string, MonthFlowEntry[]> = {};
  for (const [iso, entries] of Object.entries(month.entriesByDay)) flowEntries[iso] = entries.map(flowEntryOf);
  return monthFlow(daysInMonthOf(month.monthKey), month.monthKey, flowEntries, today);
}

export interface RecurringCalendarMonth {
  /** "YYYY-MM" */
  monthKey: string;
  today: string;
  /** iso date ("YYYY-MM-DD") → that day's entries, sorted */
  entriesByDay: Record<string, CalendarEntry[]>;
  /** total entries across the month (drives the tab badge) */
  entryCount: number;
  /**
   * net-worth-signed sum of what settled — every entry's `settledCents`, so a
   * deposit's money is counted in the month of the payday it paid, once; a
   * transfer's adds nothing (`flowEntryOf`)
   */
  postedNetCents: number;
  /** net-worth-signed sum of future (upcoming) expected charges, transfers' left out (`flowEntryOf`) */
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
 * Each series' category hue — the top-level colour of the category it is named by (`seriesCategoryIds`: the owner's
 * first, then the one most of its rows are filed in), the same category its page's chip names and the forecast's band
 * reads.
 *
 * Modal rather than first or newest: a series' rows can disagree (a rent payment once filed under Transfers), and the
 * majority is the honest read of where the ledger thinks this money goes. 🔴 A private modal here counted a row on the
 * system "Uncategorized" category as a vote, so rows filed [Uncategorized, Uncategorized, Fees] drew no hue while the
 * page named Fees, and it broke a tie by the order its scan met the rows rather than by id.
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

  const out = new Map<string, CategoryHueName>();
  for (const [seriesId, categoryId] of seriesCategoryIds(db, index)) {
    if (!index.byId.has(categoryId)) continue;
    const color = colorById.get(index.topLevelOf(categoryId).id);
    if (isCategoryHueName(color)) out.set(seriesId, color);
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

/*
 * ⚖️ A PAY SERIES' SPREAD IS MEASURED PER PAYDAY, as its rows are held to it
 * (`readings`, `lib/per-payday`): a lump is a sample of one week's pay, and money
 * that was only part of a payday's pay — or paid no payday at all — is no sample
 * of one. 🔴 On raw amounts his lump of four weeks was a sample of its own — σ
 * $1,629.39 on his ledger — and inside that ±$3,258.78 band a $1,200.00 raise
 * read `paid`.
 *
 * ⚖️ AND ON RESIDUALS — each sample less what its row is held to
 * (`spreadResidualCents`, `expectedCentsOf`) — so a dated rate change is not
 * variance (§6A 55). At a constant rate that is the samples' own spread, to the
 * cent. 🔴 On raw samples — his Jun 4 cash week of $1,047.00 beside four payroll
 * weeks at $1,141.92 and a $1,200.00 week, on paydays drawn from his first
 * deposit — the band was ±$98.43 and the $1,200.00 week read `paid`; on
 * residuals it is ±$46.46 and the week reads a raise of $58.08.
 */
function measuredStddevs(
  db: AppDatabase,
  series: readonly (typeof recurringSeries.$inferSelect)[],
  readings: ReadonlyMap<string, ReadonlyMap<string, PaydayReading>>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (series.length === 0) return out;
  const schedules = new Map(series.map((s) => [s.id, effectiveSeries(s)] as const));

  const byId = new Map<string, number[]>();
  for (const r of db
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
        inArray(transactions.recurringSeriesId, [...schedules.keys()]),
      ),
    )
    .all()) {
    const schedule = r.seriesId ? schedules.get(r.seriesId) : undefined;
    if (!r.seriesId || !schedule) continue;
    const reading = readings.get(r.seriesId)?.get(r.id);
    const residual = spreadResidualCents(r.amountCents, reading, expectedCentsOf(reading, schedule, r.postedOn));
    if (residual === null) continue;
    const list = byId.get(r.seriesId);
    if (list) list.push(residual);
    else byId.set(r.seriesId, [residual]);
  }

  for (const [id, amounts] of byId) {
    if (amounts.length < MIN_OCCURRENCES) continue;
    out.set(id, populationStddev(amounts));
  }
  return out;
}

/**
 * Whether a settled payday is drawn as the posted row that paid it — no mark of
 * its own — rather than as a chip naming its payer.
 *
 * ⛔ The merged drawing IS a claim: "the deposit beside this payday paid it".
 * So it is made only when that is settlement's whole answer — one day's
 * deposits paid all of it, drawn on this grid within the series' tolerance —
 * AND no other of the series' rows here sits as near the payday, which a
 * reader would take for its pay. His ledger, 2026-10-01: the lump of Wed Sep 23
 * paid Thu Sep 24, and the deposit dated Sep 24 itself paid Aug 20. Merged,
 * Sep 24 read as paid by its own day's deposit, which August's chip also named.
 */
export function payerStandsForPayday(
  depositDays: readonly string[],
  payday: string,
  rowDays: readonly string[],
  toleranceDays: number,
): boolean {
  if (depositDays.length !== 1) return false;
  const payer = depositDays[0]!;
  if (!rowDays.includes(payer)) return false;
  const reach = Math.abs(diffDays(payer, payday));
  if (reach > toleranceDays) return false;
  return rowDays.every((day) => day === payer || Math.abs(diffDays(day, payday)) > reach);
}

/**
 * Charges one posted row with the money its day's deposits spent on ANOTHER
 * month's paydays, taking from `owed` until the row's own money runs out — so
 * two deposits on one day split the charge rather than one going negative.
 * Consumes `owed`, which is this month's queue for that day and nothing else's.
 */
function chargeRow(owed: SettlementPortion[] | undefined, amountCents: number): { cents: number; paydays: string[] } {
  if (!owed || amountCents <= 0) return { cents: 0, paydays: [] };
  let room = amountCents;
  let cents = 0;
  const paydays = new Set<string>();
  while (room > 0 && owed.length > 0) {
    const head = owed[0]!;
    const part = Math.min(room, head.cents);
    cents += part;
    room -= part;
    paydays.add(head.paydayOn);
    if (part === head.cents) owed.shift();
    else owed[0] = { ...head, cents: head.cents - part };
  }
  return { cents, paydays: [...paydays].sort(compareDates) };
}

export function recurringCalendar(
  db: AppDatabase,
  month: string = monthKey(todayIso()),
  today: string = todayIso(),
): RecurringCalendarMonth {
  const { start: monthStart, end: monthEnd } = periodBounds(`${month}-01`, "monthly");

  // Two populations (see the module docstring): everything that may draw
  // HISTORY, and the subset of it whose FUTURE is real.
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const historyRows = db
    .select()
    .from(recurringSeries)
    // every status `seriesDrawsAsRecurring` draws — dismissed is not one
    .where(inArray(recurringSeries.status, [...RECURRING_HISTORY_STATUSES]))
    .all()
    /*
     * ⚖️ What the agent's cash is paid is not his income (`isAgentsIncomeSeries`,
     * owner decision 2026-09-28, §6A 27): no mark on his grid, no cent of the
     * footer, no step of the strip — posted or expected.
     *
     * 🔴 The forecast card had learned it and the strip printed directly under
     * it had not: the card's net leaves the agent's interest out
     * (`MonthForecast.committed`) while "as scheduled" summed every entry drawn
     * here, so the two halves of one screen differed by exactly the agent's
     * amount — on a fixture, November's strip read $0.04 over the card.
     *
     * ⛔ Not hidden from net worth: the bridge names that money on a band of its
     * own, and the forecast's EOM net worth still counts what the series pays.
     *
     * ⚖️ …nor what it pays (`isAgentsSeries`, owner decision 2026-10-02, §6A 34):
     * the agent's Gold fee is no bill on his grid, his strip or his footer.
     */
    .filter((s) => !isAgentsSeries(agentsCash, s));
  const seriesById = new Map(historyRows.map((s) => [s.id, s]));
  // ⚖️ each with the carrier it is billed with — its evidence (`lastSeenOn`, §6A 59)
  const forecastRows = withBillingCarriers(
    db,
    historyRows.filter((s) => s.status === "detected" || s.status === "confirmed"),
  );
  const postingCounts = postingCountBySeries(db);
  const hues = seriesHues(db);

  const entriesByDay: Record<string, CalendarEntry[]> = {};
  const pushEntry = (date: string, entry: CalendarEntry): void => {
    (entriesByDay[date] ??= []).push(entry);
  };

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
   * own is how this codebase came to say two things about one Thursday — and it
   * did again (§6A 29 review): a payday with a row of its own within tolerance
   * was drawn as paid by that row BEFORE settlement was asked, so a deposit
   * settlement had spent on another payday was drawn paying two. Settlement now
   * names every payday's payer (step 2) and every deposit's money (step 1).
   * Income only: settlement speaks about deposits, and a bill's absence is
   * still graded by `settledVerdict` exactly as before.
   */
  const settlements = paydaySettlementsBySeries(db, historyRows.filter(readsPerPayday).map((s) => s.id), today);
  /** per series, per row: how a pay series' row reads per payday — what it is graded as, and measured against */
  const readings = paydayReadingsBySeries(db, settlements);
  const measured = measuredStddevs(
    db,
    historyRows.filter((s) => s.amountCentsStddev === null),
    readings,
  );
  const insideMonth = (day: string): boolean =>
    compareDates(day, monthStart) >= 0 && compareDates(day, monthEnd) <= 0;
  /** per series, per deposit day: this month's money that paid ANOTHER month's paydays, still to charge to a row */
  const owedElsewhere = new Map<string, Map<string, SettlementPortion[]>>();
  /** per series, per payday in this month: the money ANOTHER month's deposits put into it */
  const paidFromElsewhere = new Map<string, Map<string, number>>();
  for (const [seriesId, settlement] of settlements) {
    const across = portionsAcross(settlement.portions, { paydayInside: insideMonth, depositInside: insideMonth });
    const owed = new Map<string, SettlementPortion[]>();
    for (const p of across.paidForAnotherWindow) owed.set(p.depositOn, [...(owed.get(p.depositOn) ?? []), p]);
    owedElsewhere.set(seriesId, owed);
    const paid = new Map<string, number>();
    for (const p of across.paidByAnotherWindow) paid.set(p.paydayOn, (paid.get(p.paydayOn) ?? 0) + p.cents);
    paidFromElsewhere.set(seriesId, paid);
  }

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
      // tagged to a DISMISSED series — the owner said not recurring — or to the agent's income, which is not his
      if (!s) continue;
      /*
       * ⛔ NOTHING AFTER TODAY HAS ARRIVED, on a pay series settlement speaks
       * about — settlement's own boundary (`hasArrived`), so a row it did not
       * read neither stands beside a payday it left owed nor counts as Settled.
       *
       * 🔴 Drawn, it did both: a deposit dated Oct 2, read on Oct 1, was drawn
       * paid beside the Oct 1 payday step 2 grades "upcoming" — the week in
       * Settled and in Expected, six weeks for October's five paydays where
       * /budgets counts five. On main the tolerance merge hid that payday
       * instead; settlement first, nothing did. The day it arrives, settlement
       * reads it, and it is drawn as the payday's pay.
       */
      if (settlements.has(s.id) && !hasArrived(p.postedOn, today)) continue;
      const stddev = s.amountCentsStddev ?? measured.get(s.id) ?? null;
      /*
       * ⚖️ A PAY ROW IS GRADED PER PAYDAY (`lib/per-payday`): a lump whose money
       * paid N paydays on its own is held to the week at what it paid each. A
       * bill — or money settlement does not speak about — has no reading, and is
       * graded as the one charge it is.
       *
       * ⚖️ …against its OWN time's rate (§6A 55, `expectedCentsOf`): a pay row
       * against the rate of the payday its money paid, any other row against the
       * rate on its own day — so `paid_different`, and the notice that reads it
       * ("rose by …"), compare a week with its own era. And money that paid no
       * payday at all is not graded: it answers no week (`towardNoPayday`).
       */
      const reading = readings.get(s.id)?.get(p.id);
      const expected = expectedCentsOf(reading, effectiveSeries(s), p.postedOn);
      const state: DayStateKind =
        expected === null || reading?.towardNoPayday
          ? "paid"
          : classifyPostedAmount(comparableCents(p.amountCents, reading), expected, stddev);
      // the money this deposit spent on another month's paydays is THAT month's
      // Settled figure, where the chip naming this day stands
      const elsewhere = chargeRow(owedElsewhere.get(s.id)?.get(p.postedOn), p.amountCents);
      pushEntry(p.postedOn, {
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        state,
        amountCents: p.amountCents,
        expectedAmountCents: expected,
        transactionId: p.id,
        settledByDepositsOn: [],
        settlesPaydaysOn: elsewhere.paydays,
        perPayday: reading?.perPayday ?? null,
        towardNoPayday: reading?.towardNoPayday ?? false,
        settledCents: p.amountCents - elsewhere.cents,
        unsettledReason: null,
        confidence: null,
        isStale: false,
        neverBilled: false,
        billedWith: null,
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

  for (const s of forecastRows) {
    if (hasStoppedForecasting(s, today)) continue;
    /*
     * ⚖️ A pay series' paydays from its FIRST PAYDAY — the one its settlement walked from (`paydayProjectable`, §6A 55
     * step B), the one Earned vs banked counts from. 🔴 Projected from the stored anchor, his June drew no payday at
     * all: Jun 4's $1,047.00 read "toward no payday" beside an income card that had earned four cash weeks that month.
     */
    const occurrences = projectOccurrences(paydayProjectable(s, settlements.get(s.id)), monthStart, monthEnd);
    const postedDates = postedDatesBySeries.get(s.id) ?? [];
    const confidence = forecastConfidence(s);
    // ONE evidence word, the one the All tab files the series under: a series
    // that never charged is "never billed", not stale (see `CalendarEntry.isStale`).
    // A lapsed money-out series was skipped above and money in never lapses, so
    // "running-late" is exactly "stale, having charged before".
    const evidence = seriesEvidence(s, today);
    const isStale = evidence === "running-late";
    const neverBilled = evidence === "never-billed";
    // ⚖️ paid inside another series' payment — whose postings its evidence is (§6A 59)
    const billedWith = s.billedWith === null ? null : billedWithPhrase(s.billedWith);
    const settlement = settlements.get(s.id);
    for (const o of occurrences) {
      /*
       * ⛔ A PAYDAY'S PAYER IS SETTLEMENT'S ANSWER, asked FIRST. Every payday it
       * speaks about — money in, on a pay series — is paid by the deposits whose
       * money it spent there, or by none. A row merely lying within tolerance
       * paid nothing settlement did not spend on it.
       *
       * 🔴 This asked "is there a row of its own within tolerance?" first, and
       * settlement only for what that left. His lump-then-weekly shifted one
       * week (§6A 29 review) — Wed Sep 30 $4,567.68, Thu Oct 1 $1,141.92 —
       * settles Oct 1 to the lump and the Oct 1 deposit to Aug 27. October drew
       * Oct 1 paid by the Oct 1 row, and August chipped Aug 27 "paid by the
       * deposit of Oct 1": one deposit, two paydays, beside a /budgets that said
       * Sep 30 paid Oct 1.
       */
      if (settlement && o.amountCents > 0) {
        const paidBy = settlement.portions.filter((p) => p.paydayOn === o.date);
        if (paidBy.length > 0) {
          const depositDays = [...new Set(paidBy.map((p) => p.depositOn))].sort(compareDates);
          // its own deposit beside it, drawn on this grid: the row is the mark
          if (payerStandsForPayday(depositDays, o.date, postedDates, s.toleranceDays)) continue;
          /*
           * A payday paid by a deposit drawn elsewhere — another day, or another
           * month. It draws paid and carries no transaction of its own: the
           * money is on that deposit's row, drawn on the day it landed, and
           * `settledByDepositsOn` names that day so the chip's claim can be
           * checked. Its figure is the MONEY those deposits put in, as /budgets
           * states it — a $1,100.00 deposit that settles a $1,141.92 week under
           * the anchor clause paid $1,100.00 — and it counts in this month's
           * Settled figure only for money no row here holds.
           */
          pushEntry(o.date, {
            seriesId: s.id,
            name: s.name,
            kind: s.kind,
            state: "paid",
            amountCents: paidBy.reduce((sum, p) => sum + p.cents, 0),
            expectedAmountCents: o.amountCents,
            transactionId: null,
            settledByDepositsOn: depositDays,
            settlesPaydaysOn: [],
            perPayday: null,
            towardNoPayday: false,
            settledCents: paidFromElsewhere.get(s.id)?.get(o.date) ?? 0,
            unsettledReason: null,
            confidence: null,
            isStale: false,
            neverBilled: false,
            billedWith: null,
            hue: hues.get(s.id) ?? null,
          });
          continue;
        }
        // nothing paid it, whatever lies near it: graded below like any payday
      } else if (postedDates.some((p) => Math.abs(diffDays(p, o.date)) <= s.toleranceDays)) {
        // a bill, or money settlement does not speak about: a posting within
        // the series' tolerance is this occurrence, drawn on the day it landed
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
        settledByDepositsOn: [],
        settlesPaydaysOn: [],
        perPayday: null,
        towardNoPayday: false,
        settledCents: null,
        unsettledReason: verdict?.reason ?? null,
        confidence: isFuture ? confidence : null,
        isStale: isFuture && isStale,
        neverBilled: isFuture && neverBilled,
        billedWith: isFuture ? billedWith : null,
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
      /*
       * ⛔ WHAT SETTLED IS EVERY MARK'S `settledCents`, which puts each cent of
       * pay in the month of the payday it paid.
       *
       * 🔴 A payday whose money landed in ANOTHER month once stood in no figure:
       * August 2026, read 2026-09-28, drew Aug 27 green "Paid $1,141.92" over a
       * footer reading SETTLED $0.00. Its chip carries that money now.
       *
       * ⚠️ And only money no row here holds. Sep 3, Sep 10 and Sep 17 were paid
       * by the lump of Sep 23, which September draws as a row of its own:
       * counting them here as well would publish $9,135.36 of pay in a month
       * that received $5,709.60.
       *
       * 🔴 And the other way: a row whose money paid another month's payday
       * carries only what is left. Counted whole, the Sep 24 deposit that paid
       * Aug 20 sat in September's figure AND, through Aug 20's chip, August's.
       *
       * ⚖️ Each mark adds what `flowEntryOf` says it adds, the reading the strip
       * above sums — so a transfer, drawn like any mark, adds nothing to Settled
       * or Expected (`seriesIsIncomeOrSpending`). "Not yet known" is not a net:
       * it counts the marks drawn unsettled and their gross, a transfer's too,
       * or it would print a $0.00 beside a count of one.
       */
      if (e.settledCents !== null) postedNetCents += flowEntryOf(e).amountCents;
      else if (e.state === "upcoming") upcomingNetCents += flowEntryOf(e).amountCents;
      else if (e.state === "unsettled") {
        unsettledCount += 1;
        unsettledGrossCents += Math.abs(e.amountCents);
      }
      /*
       * ⛔ A SETTLED PAYDAY CARRIES NO TRANSACTION OF ITS OWN, and a chip paid
       * from inside the month settles $0.00 here — so neither may fall through
       * to the missed tally, which would count a payday as missed on the very
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
