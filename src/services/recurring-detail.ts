import { and, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SeriesEvidence } from "@/lib/series-evidence";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import {
  recurringSeries,
  type Cadence,
  type SeriesKind,
  type SeriesStatus,
} from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, isValidIsoDate, todayIso } from "@/lib/dates";
import { expectedCentsOf, paydayReadings, type PaydayReading, type PerPayday } from "@/lib/per-payday";
import { stepFrom, stepPlan } from "@/lib/recurring-step";
import { loadCategoryIndex } from "./analytics";
import { arrearsThisMonth } from "./arrears";
import { paydaySettlement, readsPerPayday, stillToCome } from "./payday-settlement";
import { postedAveragesBySeries } from "./posted-average";
import {
  annualizedCentsOf,
  effectiveSeries,
  isSeriesActive,
  projectOccurrences,
  rollForwardNextExpected,
  toProjectable,
  type SeriesOccurrence,
  seriesEvidence,
  seriesIsForecast,
} from "./recurring";
import { mergeFilings, type MergeFiling } from "./recurring-links";
import { seriesCategoryIds } from "./series-category";

/**
 * Series-detail read + write services (ux-overhaul-plan §4.2). The detail page
 * closes the merchant⇄category chain, exposes the detected statistics as
 * editable user overrides, and hosts the attach / merge / detach flows whose
 * transactional core already lives in recurring-links.ts.
 */

export interface SeriesLinkedTxn {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  accountName: string;
  /** who owns this link: detection, the user, or (defensively) neither */
  linkSource: "detected" | "user" | null;
}

export interface AmountHistoryPoint {
  date: string;
  amountCents: number;
  /**
   * A lump of pay — a deposit whose money paid two or more paydays on its own —
   * read as the calendar grades it (`lib/per-payday`): those paydays and what it
   * paid each. Null for every other posting. 🔴 Without it the history drew his
   * Sep 23 deposit as a bar four weeks tall and read it "vs expected +$3,425.76"
   * beside a calendar drawing the same row `paid`.
   */
  perPayday: PerPayday | null;
  /**
   * What this row is held to (`rateOn`): the rate of the payday a pay row's money paid (`PaydayReading`), else the
   * series' rate on the row's own day. ⚖️ Each against its own time's rate (owner decision 2026-10-08, §6A 55): his
   * cash weeks at $1,047.00, his payroll weeks at $1,141.92. 🔴 One expectation for all time read his Jun 4 cash
   * week "vs expected -$94.92". Null when the series has no rate.
   */
  expectedCents: number | null;
}

export interface SeriesCategoryRef {
  id: string;
  name: string;
  hue: string | null;
  icon: string | null;
}

export interface SeriesMergeCandidate {
  id: string;
  name: string;
  kind: SeriesKind;
  /**
   * ⚖️ §6A 54 (2026-10-08): what merging it in would file under this series' category — the count and path the
   * confirmation names before he presses; null when it files nothing. The reading `mergeSeries` writes by.
   */
  filing: MergeFiling | null;
}

export interface SeriesDetail {
  id: string;
  name: string;
  kind: SeriesKind;
  status: SeriesStatus;
  merchant: { id: string; name: string } | null;
  /** set when this series was merged away — its editing is closed, it links on */
  mergedInto: { id: string; name: string } | null;
  /** modal category of the linked charges — the chain's other end */
  category: SeriesCategoryRef | null;
  accountName: string | null;
  // effective (override-first) values the sentence reads
  cadence: Cadence;
  /**
   * The SCHEDULE's next date, rolled forward off a stale stored value — never a
   * date in the past. The sentence's day token reads its weekday or day-of-month,
   * and its date editor opens on it and saves it back as `userNextExpectedOn`.
   *
   * ⛔ Not `nextStillToCome`, though `listSeries` reads that: a payday a deposit
   * paid early is still ON the schedule, and the anchor this editor writes floors
   * every projection, settlement's included. What is still to come is
   * `nextExpected`.
   */
  nextExpectedOn: string | null;
  /** the un-rolled stored value, so the UI can distinguish shown from saved */
  storedNextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  // the raw override columns, so the UI can show "detected: X" and offer reset
  userCadence: Cadence | null;
  userNextExpectedOn: string | null;
  userAmountCents: number | null;
  // detected statistics
  detectedCadence: Cadence;
  detectedNextExpectedOn: string | null;
  amountCentsAvg: number | null;
  amountCentsStddev: number | null;
  /**
   * The spread of the LINKED postings — null under two of them, because a
   * spread needs something to spread over.
   *
   * 🔴 `Per charge` printed `recurring_series.amount_cents_stddev`, the
   * detector's seed from creation. On 2026-09-04 that rendered "±5.48" on
   * `/recurring/<ZELLE PAYMENT TO ENRIQUE RODRIGUEZ>` beside a badge reading
   * "no basis yet" and "Linked transactions · 0", and "±18.45" on
   * `/recurring/<Hoffman LL>` beside "seen once" — around a centre that
   * excludes the single charge the page lists underneath it. Same seed, same
   * defect as `postedAvgCents` in `listSeries`.
   */
  postedStddevCents: number | null;
  /**
   * The MEAN of the linked postings — the centre `postedStddevCents` is the
   * spread of. Null with nothing linked.
   *
   * 🔴 The page printed the FORECAST amount with the POSTINGS' spread beside
   * it: a ± around a number that is not what it measures. Measured on the
   * owner's ledger 2026-09-08 — `/recurring/<Flamingo South Beach (rent)>`
   * read "-$2,109.00 ± 610.65" over four charges averaging -$1,739.40,
   * `<Cash job (weekly pay)>` "+$1,047.00 ± 457.50" over $400.00 and
   * $1,047.00, and `<Breezeline (internet)>` "-$50.00 ± 5.59" over three
   * averaging -$46.77. `/recurring?tab=all` already prints the honest pair on
   * the same rows ("-$50.00 · posted avg -$46.77") from `listSeries`'
   * `postedAvgCents`; the page that OWNS the series had the spread and not the
   * centre. Owner's call, 2026-09-08: name the average, and hang the ± on it.
   *
   * ⚖️ A pay series' is what a PAYDAY paid at the rate in force now (`lib/posted-average`, §6A 55) — one reading with
   * the All tab and the popover. 🔴 The raw mean, his page read "posted avg +$1,789.15 ± 1881.46" under "+$1,141.92".
   */
  postedAvgCents: number | null;
  intervalDaysAvg: number | null;
  toleranceDays: number;
  confidence: number | null;
  lastMatchedOn: string | null;
  isActive: boolean;
  /** the word every surface uses for its evidence — see `lib/series-evidence` */
  evidence: SeriesEvidence;
  /**
   * The day this series stops, or null when it runs on — `userEndsOn`, the only
   * end day the ledger holds and the one `projectOccurrences` clamps its walk
   * on.
   *
   * 🔴 It was on no surface a reader would go looking. Measured 2026-09-02:
   * `/recurring/<car insurance>` showed "ANNUALIZED ~$4,337.88/yr", three
   * upcoming charges and no hint that the series is evidenced only through
   * 2027-01-11 — while the runway card and the car card both said so. The page
   * that OWNS the series was the one place its end was invisible, and the
   * annualised figure it headlines is exactly the number that end invalidates.
   */
  endsOn: string | null;
  annualizedCents: number | null;
  /** the next few projected occurrences (override-aware) */
  nextExpected: SeriesOccurrence[];
  /**
   * What this series ALREADY owed this month and nothing has covered — the
   * backward half of `nextExpected`.
   *
   * 🔴 `/recurring/<Flamingo South Beach (rent)>` on 2026-09-04 read "Next
   * expected — Oct 1, 2026" and nothing else. Its September charge came due on
   * the 1st and never posted: the forecast counts it as a component ("came due
   * 2026-09-01 and has not posted"), /budgets says "2 bills totalling $2,291.21
   * due by today and no import has covered them yet", the runway says "A
   * further $2,291.21 came due earlier this month and never posted", and the
   * calendar marks Sep 1 with a "?". The page that is ABOUT that bill was the
   * only one that skipped to October.
   *
   * ⛔ Same call the forecast makes — `arrearsThisMonth`, over the calendar
   * month, closing the day before today, so a bill due TODAY is due rather than
   * late. Arrears are scoped to the calendar month by the owner's decision of
   * 2026-09-02; a wider leg here would disagree with every other surface.
   */
  overdue: { date: string; amountCents: number; occurrenceCount: number } | null;
  /** full linked history, newest first */
  linkedTxns: SeriesLinkedTxn[];
  /** linked charge amounts oldest → newest, for the drift chart */
  amountHistory: AmountHistoryPoint[];
  /** other live series this one can merge in */
  mergeCandidates: SeriesMergeCandidate[];
}

interface CatRow {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  icon: string | null;
}

/** A category as the series page names it — hue and icon inherited from its parent. */
function categoryRef(id: string, catById: ReadonlyMap<string, CatRow>): SeriesCategoryRef | null {
  const cat = catById.get(id);
  if (!cat) return null;
  const parent = cat.parentId ? catById.get(cat.parentId) : undefined;
  return {
    id: cat.id,
    name: cat.name,
    hue: cat.color ?? parent?.color ?? null,
    icon: cat.icon ?? parent?.icon ?? null,
  };
}

const NEXT_EXPECTED_COUNT = 3;

export function seriesDetail(
  db: AppDatabase,
  seriesId: string,
  today: string = todayIso(),
): SeriesDetail {
  const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!s) throw new Error(`Unknown recurring series ${seriesId}`);

  const merchant = s.merchantId
    ? db
        .select({ id: merchants.id, name: merchants.canonicalName })
        .from(merchants)
        .where(eq(merchants.id, s.merchantId))
        .get() ?? null
    : null;

  const accountName = s.accountId
    ? db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, s.accountId)).get()?.name ??
      null
    : null;

  const mergedInto = s.mergedIntoId
    ? db
        .select({ id: recurringSeries.id, name: recurringSeries.name })
        .from(recurringSeries)
        .where(eq(recurringSeries.id, s.mergedIntoId))
        .get() ?? null
    : null;

  // full linked history (active rows), newest first
  const linked = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      description: sql<string>`coalesce(nullif(${transactions.normalizedDescription}, ''), ${transactions.rawDescription})`,
      linkSource: transactions.seriesLinkSource,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.recurringSeriesId, seriesId), eq(transactions.status, "active")))
    .orderBy(desc(transactions.postedOn), desc(transactions.amountCents), desc(transactions.id))
    .all();

  const catById = new Map<string, CatRow>(
    db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        color: categories.color,
        icon: categories.icon,
      })
      .from(categories)
      .all()
      .map((c) => [c.id, c]),
  );

  const linkedTxns: SeriesLinkedTxn[] = linked.map((t) => ({
    id: t.id,
    postedOn: t.postedOn,
    amountCents: t.amountCents,
    description: t.description,
    accountName: t.accountName,
    linkSource: t.linkSource,
  }));
  const eff = effectiveSeries(s);
  // the calendar's reading of a pay series' rows, behind the calendar's own gate
  const readings = readsPerPayday(s)
    ? paydayReadings(linked, paydaySettlement(db, s.id, today).portions, eff)
    : new Map<string, PaydayReading>();
  const amountHistory: AmountHistoryPoint[] = [...linked].reverse().map((t) => {
    const reading = readings.get(t.id);
    return {
      date: t.postedOn,
      amountCents: t.amountCents,
      perPayday: reading?.perPayday ?? null,
      // ⚖️ each row against its own time's rate (§6A 55), by the calendar's own rule — a pay row, the rate of the
      // payday it paid; any other row, its own day's
      expectedCents: expectedCentsOf(reading, eff, t.postedOn),
    };
  });

  /*
   * What posted, averaged, and its sample standard deviation — the reading `listSeries` publishes to the All tab and
   * the popover names (`postedAveragesBySeries`): a pay series' is what a payday paid at the rate in force now. Two
   * samples is the floor of a spread: with one there is nothing to vary, and the seed that used to be printed here
   * claimed a spread for series with none at all.
   */
  const posted = postedAveragesBySeries(db, [s], today).get(s.id)!;

  /*
   * 🔴 ONLY THE STATUSES THE FORECAST PROJECTS, and the rule was already
   * written four lines below for `nextExpectedOn`: "rolling a dismissed/ended
   * series forward would invent a future charge." The occurrence LIST beside it
   * ignored it, so on 2026-09-04 `/recurring/<Hoffman LL>` carried the badge
   * "Ended · Bill" over "Next expected — Sep 8, 2026 -$1,786.46 · Oct 8 ·
   * Nov 8" for a series whose one linked charge is dated 2025-06-02, and
   * `/recurring/<YA-FIT Smoothie Bar>` read "Dismissed · Bill" over three more.
   *
   * ⛔ `dismissed` is the owner saying a pattern is NOT recurring, and it is
   * also the detector's re-detection sink — a dated future charge under that
   * badge is the app arguing with him. `ended` really did bill and stopped; its
   * history stays, its future does not.
   *
   * ⛔ …AND ONLY WHILE THE FORECAST STILL CARRIES IT (`seriesIsForecast`, the rule every forward leg asks). 🔴 This
   * read the status alone, so on a copy of the owner's ledger 2026-10-08 `/recurring/<Amazon Prime>` showed its
   * "Lapsed" badge ("no longer forecast") over "Next expected Nov 5 · Dec 5 · Jan 5", and its End dialog said "every
   * charge from Nov 5 on" — while the subscriptions card said "STOPPED BEING FORECAST", the Upcoming tab left it out
   * and its category card hid the very same Nov 5.
   */
  const projects = seriesIsForecast(s, today);

  // Size the projection window off the series' own step so even a long-interval
  // annual series reaches NEXT_EXPECTED_COUNT occurrences: the first can land up
  // to one whole step out, so (count+1) steps covers count of them with slack.
  // Stepped by the SAME plan the projection walks, or a calendar-monthly series
  // whose months run long could have its last occurrence fall outside a window
  // sized in 30-day units.
  //
  // ⛔ Less the paydays a deposit has already paid down (`stillToCome`, the
  // forecast's reading of settlement). 🔴 Read on Sep 30, his pay series listed
  // "Next expected — Oct 1" for the payday Wed Sep 30's deposit paid early.
  // Settlement reaches `toleranceDays` past today, so the window reaches that
  // much further and a payday it drops still leaves NEXT_EXPECTED_COUNT behind.
  const nextExpected = projects
    ? stillToCome(
        db,
        s,
        projectOccurrences(
          toProjectable(s),
          today,
          addDays(
            stepFrom(today, stepPlan(eff.cadence, eff.intervalDaysAvg), NEXT_EXPECTED_COUNT + 1),
            s.toleranceDays,
          ),
        ),
        today,
      ).slice(0, NEXT_EXPECTED_COUNT)
    : [];

  const late = projects ? (arrearsThisMonth(db, new Set([seriesId]), today).series[0] ?? null) : null;
  const overdue = late
    ? { date: late.nextDate, amountCents: -late.amountCents, occurrenceCount: late.occurrenceCount }
    : null;

  const namedCategoryId = seriesCategoryIds(db, loadCategoryIndex(db), [s.id]).get(s.id);

  const liveOthers = db
    .select({ id: recurringSeries.id, name: recurringSeries.name, kind: recurringSeries.kind })
    .from(recurringSeries)
    .where(
      and(
        ne(recurringSeries.id, seriesId),
        isNull(recurringSeries.mergedIntoId),
        or(eq(recurringSeries.status, "detected"), eq(recurringSeries.status, "confirmed")),
      ),
    )
    .orderBy(recurringSeries.name)
    .all();
  // one reading with the merge's own write (`mergeFilings`), so the confirmation names exactly what it files
  const filings = mergeFilings(db, seriesId, liveOthers.map((c) => c.id));
  const mergeCandidates: SeriesMergeCandidate[] = liveOthers.map((c) => ({ ...c, filing: filings.get(c.id) ?? null }));

  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    merchant,
    mergedInto,
    // ⛔ the owner's category first, then the rows' — one rule with the
    // calendar's hue and the forecast's band (`seriesCategoryIds`). A
    // commitment that has never charged has no rows, so its chip back to the
    // category page was missing while that page listed it (Car lease, Gym,
    // Parking, Rent utilities & fees). 🔴 Its own modal counted a row on the
    // system "Uncategorized" category and skipped a NULL one: rows filed
    // [Uncategorized, Uncategorized, Fees] read "Uncategorized" here while the
    // forecast named the stream Fees.
    category: namedCategoryId === undefined ? null : categoryRef(namedCategoryId, catById),
    accountName,
    cadence: eff.cadence,
    // Rolled forward so the sentence never reads a date in the past. Only the
    // series the forecast still projects roll — see `projects` above.
    // ⛔ The schedule's step, not settlement's (`nextStillToCome`, listSeries'
    // reading): the sentence's editor opens on this date and Save writes it back
    // as the anchor. 🔴 Read through settlement it opened past a payday a deposit
    // had paid early. Measured on a copy of his ledger: read on Sep 23 or 24 it
    // opened on Oct 1, past the Sep 24 payday the Sep 23 lump of $4,567.68 paid,
    // and Save with nothing changed took Sep 24 out of the projection settlement
    // walks. The token read "Thursdays" either way.
    nextExpectedOn: projects ? rollForwardNextExpected(eff, today) : eff.nextExpectedOn,
    storedNextExpectedOn: eff.nextExpectedOn,
    nextExpectedAmountCents: eff.nextExpectedAmountCents,
    userCadence: s.userCadence,
    userNextExpectedOn: s.userNextExpectedOn,
    userAmountCents: s.userAmountCents,
    detectedCadence: s.cadence,
    detectedNextExpectedOn: s.nextExpectedOn,
    amountCentsAvg: s.amountCentsAvg,
    amountCentsStddev: s.amountCentsStddev,
    postedStddevCents: posted.stddevCents,
    postedAvgCents: posted.avgCents,
    intervalDaysAvg: s.intervalDaysAvg,
    toleranceDays: s.toleranceDays,
    confidence: s.confidence,
    lastMatchedOn: s.lastMatchedOn,
    isActive: isSeriesActive(s, today),
    evidence: seriesEvidence(s, today),
    endsOn: s.userEndsOn ?? null,
    annualizedCents: annualizedCentsOf(s, today),
    nextExpected,
    overdue,
    linkedTxns,
    amountHistory,
    mergeCandidates,
  };
}

export interface AttachCandidate {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  accountName: string;
}

/** Default amount-window half-width when no text query narrows the search. */
const ATTACH_AMOUNT_BAND_PCT = 0.15;
const ATTACH_AMOUNT_BAND_FLOOR_CENTS = 500;
const ATTACH_LIMIT = 25;

/**
 * Unlinked (recurring_series_id IS NULL), non-future active rows a user could
 * attach to this series (§4.2 "Find transactions"). A text query matches the
 * description (LIKE wildcards escaped); with no query the search falls back to
 * an amount window around the series' expected charge so the list is relevant
 * rather than the whole ledger. Rows already linked anywhere are excluded — an
 * attach re-homes nothing behind the user's back.
 */
export function searchAttachCandidates(
  db: AppDatabase,
  seriesId: string,
  query: string,
  today: string = todayIso(),
  limit: number = ATTACH_LIMIT,
): AttachCandidate[] {
  const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!s) throw new Error(`Unknown recurring series ${seriesId}`);

  const conds = [
    eq(transactions.status, "active"),
    isNull(transactions.recurringSeriesId),
    lte(transactions.postedOn, today),
  ];

  const q = query.trim();
  if (q !== "") {
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const clause = or(
      sql`${transactions.rawDescription} LIKE ${pattern} ESCAPE '\\'`,
      sql`${transactions.normalizedDescription} LIKE ${pattern} ESCAPE '\\'`,
    );
    if (clause) conds.push(clause);
  } else {
    const expected = effectiveSeries(s).nextExpectedAmountCents;
    if (expected !== null) {
      const band = Math.max(
        ATTACH_AMOUNT_BAND_FLOOR_CENTS,
        Math.round(Math.abs(expected) * ATTACH_AMOUNT_BAND_PCT),
      );
      conds.push(sql`${transactions.amountCents} >= ${expected - band}`);
      conds.push(sql`${transactions.amountCents} <= ${expected + band}`);
    }
  }

  return db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      description: sql<string>`coalesce(nullif(${transactions.normalizedDescription}, ''), ${transactions.rawDescription})`,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(desc(transactions.postedOn), desc(transactions.amountCents), desc(transactions.id))
    .limit(limit)
    .all();
}

export interface SeriesOverridesInput {
  /** undefined = leave unchanged; null = clear the override (use detected) */
  userCadence?: Cadence | null;
  userAmountCents?: number | null;
  userNextExpectedOn?: string | null;
}

/** Writes user overrides (§4.4). Detection keeps its own columns; the UI reads user-first. */
export function setSeriesOverrides(
  db: AppDatabase,
  seriesId: string,
  input: SeriesOverridesInput,
): void {
  const patch: Partial<typeof recurringSeries.$inferInsert> = {};
  if ("userCadence" in input) patch.userCadence = input.userCadence ?? null;
  if ("userAmountCents" in input) patch.userAmountCents = input.userAmountCents ?? null;
  if ("userNextExpectedOn" in input) {
    // a calendar-invalid date would poison every future projection — reject it
    // here too, not only at the zod boundary (the service must not trust callers)
    if (input.userNextExpectedOn != null && !isValidIsoDate(input.userNextExpectedOn)) {
      throw new Error(`Invalid next-expected date: ${input.userNextExpectedOn}`);
    }
    patch.userNextExpectedOn = input.userNextExpectedOn ?? null;
  }
  if (Object.keys(patch).length === 0) return;
  const res = db.update(recurringSeries).set(patch).where(eq(recurringSeries.id, seriesId)).run();
  if (res.changes === 0) throw new Error(`Unknown recurring series ${seriesId}`);
}

/** Renames a series (a user-visible label; does not affect grouping). */
export function renameSeries(db: AppDatabase, seriesId: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("Series name cannot be empty");
  const res = db
    .update(recurringSeries)
    .set({ name: trimmed })
    .where(eq(recurringSeries.id, seriesId))
    .run();
  if (res.changes === 0) throw new Error(`Unknown recurring series ${seriesId}`);
  return trimmed;
}
