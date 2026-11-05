import { and, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { UnattachedMatch } from "@/lib/unattached-match";
import { neverPosted, seriesCanBeReshaped, type SeriesEvidence } from "@/lib/series-evidence";
import type { PassedPaydaysReading } from "@/lib/unbanked-income";
import type { BillingCarrier } from "@/lib/billed-with";
import type { CarriedGrace } from "@/lib/occurrence-verdict";
import { daysThatPaid, type Occurrence } from "@/lib/posted-average";
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
import { addDays, compareDates, isValidIsoDate, todayIso } from "@/lib/dates";
import { expectedCentsOf, paydayReadings, type PaydayReading, type PerPayday } from "@/lib/per-payday";
import { stepFrom, stepPlan } from "@/lib/recurring-step";
import { seriesAmountCents } from "@/lib/series-kind";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isAgentsIncomeSeries, loadCategoryIndex } from "./analytics";
import { arrearsThisMonth, unbankedIncomeThisMonth, unbankedIncomeTotals } from "./arrears";
import { billingCarriers, fallsDueOn } from "./billing-carriers";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { incomeCardSeriesIds } from "./income-card";
import { asPayRows, paydaySettlement, readsPerPayday, stillToCome, stillToComeReader } from "./payday-settlement";
import { postedAveragesBySeries } from "./posted-average";
import {
  annualizedCentsOf,
  effectiveSeries,
  isSeriesActive,
  lastFallsDueAfterItsEnd,
  oneChargeDays,
  projectOccurrences,
  rollForwardNextExpected,
  scheduleRanOutOn,
  toProjectable,
  type SeriesOccurrence,
  seriesEvidence,
  seriesIsForecast,
  seriesStaleness,
} from "./recurring";
import { mergeFilings, type HandFiling } from "./recurring-links";
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
   * week "vs expected -$94.92". Null when the series has no rate — and for money that paid no payday, held to none,
   * and for money out on his pay, no payday's pay (decision 75). 🔴 $500.00 back read "vs expected -$641.92".
   */
  expectedCents: number | null;
  /**
   * The row's money paid NO payday (`PaydayReading.towardNoPayday`, §6A 55b) — the calendar's "toward no payday",
   * said here too, and graded against nothing. 🔴 Held to its own day's rate, his Jun 5 $400.00 read "-$647.00" in
   * the table lens and "expected $1,047.00" in the bar's tooltip, beside a calendar drawing it ungraded (a copy of his
   * ledger, 2026-10-08).
   */
  towardNoPayday: boolean;
  /**
   * ⛔ Money in linked to the pay that its settlement never read (`PaydayReading.notFiledAsIncome`): no pay of the
   * series on any surface, and said so — "attached to it but not filed as income", the words the page's passed paydays
   * name it by (`ATTACHED_NOT_FILED`) — never "toward no payday" beside them. 🔴 Review of 92de2b12 (L56): the trial
   * import of the Oct 26 statement into his pre-import copy, read Oct 29 — Oct 1, 8, 15 ($200.00 and $1,141.92) and 22
   * read "toward no payday" beside the passed paydays' "Pay matched to the cent by rows of $1,141.92 … that are attached
   * to it but not filed as income" (re-measured at 95cdf198 on that copy, 2026-11-04). Absent on every other row.
   */
  notFiledAsIncome?: true;
  /**
   * ⚖️ A payment of a series read per occurrence on a day that PAID NO CHARGE (`daysThatPaid`) — money back: graded
   * against nothing (`expectedCents` null) and said "toward no due day", the calendar's words for the same row
   * (`CalendarEntry.towardNoDueDay`). 🔴 Held to the rate, a +$357.58 credit on a −$357.58 premium read "$0.00" against
   * it in the table lens and "expected −$357.58" in its tooltip (review of d7a5485c, L16). Absent on every other row.
   */
  towardNoDueDay?: true;
  /**
   * The rows the bank posted this PAYMENT as, for a series read per occurrence (`SeriesPostedAverage.everyOccurrence`):
   * a day's rows are one point, their sum, said "one payment, posted as 2" (`postedAsWord`). Absent for a row drawn as
   * it posted. 🔴 Drawn per row, his rent's Jun 16 payment of -$2,434.80 read as two charges under -$2,109.00.
   */
  postings?: number;
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
  filing: HandFiling | null;
}

/** One passed payday with no deposit against it — its day, and its own day's rate (§6A 55). */
export interface UnbankedPayday {
  date: string;
  amountCents: number;
}

/** A pay series' passed paydays this month, as the forecast's note reads them (`SeriesDetail.unbankedPaydays`). */
export interface UnbankedPaydays extends PassedPaydaysReading {
  totalCents: number;
  /** in date order; their amounts sum to `totalCents` */
  paydays: readonly UnbankedPayday[];
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
   *
   * ⚖️ …or, billed inside another on its carrier's step, a day of its own already past whose carrier's day is still to
   * come (`rollForwardNextExpected`, default (B), 2026-10-30): the utilities' Nov 1 on Nov 10, due with the rent's Nov
   * 16 — its own day still, so a Save with nothing changed keeps their schedule, and the day it falls due on is said
   * beside it (`nextFallsDueOn`).
   */
  nextExpectedOn: string | null;
  /**
   * ⚖️ default (B), built, not asked (2026-10-30): the day `nextExpectedOn` FALLS DUE on when that is a later day —
   * billed inside another on its carrier's step, the carrier's day it pairs with (`fallsDueOn`): the day its list
   * (`nextExpected`), the All tab and Upcoming name it by, which the sentence says beside its own ("around the 1st, due
   * with the rent on the 16th", `dueWithPhrase`). Null when it falls due on its own day — billed on its own, or on his
   * ledger, the rent and the utilities both on the 1st — or nothing is projected. 🔴 Review of a456a6fc, his ledger
   * copy 2026-10-29b, his rent retyped Nov 16 (Wells Fargo read through Nov 9): on Nov 10 the utilities' sentence read
   * "around the 1st", its editor opening on Nov 1, over "Next expected Nov 16 · Dec 16 · Jan 16" and the All tab's Nov
   * 16 — and nothing on the page said which date was which.
   *
   * ⛔ …and where `nextExpectedOn` ties with its carrier's day — a month too short for either day, both clamped to its
   * last — the first day of the list that falls due on the carrier's later day: the clause is said of the list, so it
   * is said beside every date the list names on the carrier's day, clamped as every day token is. 🔴 Review of
   * 933b29e2 (L76): read off the one day, the rent retyped Oct 31 and the utilities Oct 30, on Nov 5 the page read
   * "charges monthly around the 30th, about $182.21." over Nov 30 · Dec 31 · Jan 31 — their own Dec 30 and Jan 30,
   * due with the rent's 31st (his ledger copy 2026-11-04, the same what-if).
   */
  nextFallsDueOn: string | null;
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
   *
   * A bill's is what each OCCURRENCE was paid — a day's rows one payment. 🔴 Row by row, his rent's page read "posted
   * avg -$1,849.76 ± $583.58" under "-$2,109.00", though every month he paid more (a copy of his ledger, 2026-10-12).
   */
  postedAvgCents: number | null;
  /** ⚖️ the series billed inside its payments (§6A 59) — named on its posted avg line (`carriesPhrase`) */
  carries: readonly string[];
  /** ⚖️ DEFAULT, NOT ASKED (2026-10-22): payments that covered more than one charge (`postedAvgNotes`) */
  paidAhead: readonly Occurrence[];
  intervalDaysAvg: number | null;
  toleranceDays: number;
  confidence: number | null;
  lastMatchedOn: string | null;
  isActive: boolean;
  /** the word every surface uses for its evidence — see `lib/series-evidence` */
  evidence: SeriesEvidence;
  /**
   * Nothing — its own postings or its carrier's — has ever matched it: never billed's own test (`neverPosted`), which
   * the word stops saying once the schedule has ended. The page still says it: "Never billed" beside "Ended Nov 11,
   * 2026", and "was expected", never "charged". 🔴 Review of 49cc98f: "charged once on Nov 11" over 0 linked rows.
   */
  neverPosted: boolean;
  /**
   * ⚖️ The series it is billed inside (owner decision 2026-10-08, §6A 59), or null — the page says "billed with the
   * rent, last seen Sep 2" and links it. 🔴 `/recurring/<Rent utilities & fees>` wore a "Never billed" badge, of money
   * paid inside every rent payment.
   */
  billedWith: BillingCarrier | null;
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
  /**
   * The day its schedule RAN OUT once its end has closed it (`scheduleRanOutOn`) — its last date on or before the end,
   * which can fall between two due days — else null. The end badge names it in the past tense, beside the card's
   * "Its schedule has ended" (`seriesEndBadge`).
   */
  scheduleRanOutOn: string | null;
  /**
   * ⚖️ (B) Billed inside another on its carrier's step, the day its last charge inside its end FALLS DUE on when that is
   * after the end itself (`lastFallsDueAfterItsEnd`) — else null. Where the End dialog's span runs to
   * (`seriesEndInput`). 🔴 Review of 933b29e2 (L74): the rent typed Nov 16 and paid Nov 16, the utilities ending Dec
   * 10, on Nov 20 the dialog read "every charge from Dec 16, 2026 to Dec 10, 2026" (his ledger copy 2026-11-04).
   */
  lastFallsDueOn: string | null;
  /**
   * The day of its ONE charge when its whole schedule holds one (`oneChargeDays`), else null. ⚖️ Owner decision
   * 2026-10-08 (§6A 56): then the CADENCE stat reads "Once" and the sentence "charges once on Nov 11". 🔴 The Nov 11
   * car-insurance balance's page read "Cadence Monthly" under "charges monthly around the 11th".
   */
  oneChargeOn: string | null;
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
   *
   * `unreadCents` — of `amountCents`' magnitude, the part on days no checked statement has reached, the runway's split
   * (`ArrearsSeries.unreadCents`). 🔴 Without it the card read "Already due, and not posted" in warning colour over
   * rent's Oct 1 on a copy of his ledger 2026-10-08, a day no import had covered (Wells Fargo read through Sep 24).
   *
   * `inGraceCents` — of `unreadCents`, the part no statement keeps unread: its accounts read through today, waiting
   * only for its days to post (`ArrearsSeries.inGraceCents`) — what the card and the End dialog say in those words.
   *
   * `graceDays` — the days after a due day a payment may still post on, which the read half waited for
   * (`ArrearsSeries.graceDays`, ⚖️ §6A 60): what the card says the statements reach past it (§6A 65).
   *
   * `carriedGrace` — billed inside another's payment, the two windows that grace is made of, which the card names each
   * (`ArrearsSeries.carriedGrace`); null for a bill paid on its own.
   */
  overdue: {
    date: string;
    /**
     * ⚖️ (B) the own day of `date` (`ArrearsSeries.occurrenceOwnDates`): billed inside another on its carrier's later
     * day, the day a row of its own is graded on — said where its own window is (`alreadyDueWords`); else `date`
     */
    ownDate: string;
    amountCents: number;
    occurrenceCount: number;
    unreadCents: number;
    inGraceCents: number;
    graceDays: number;
    carriedGrace: CarriedGrace | null;
    /** of the read part, the due days rows sitting unattached match to the cent (`ArrearsSeries.unattached`) */
    unattached?: readonly UnattachedMatch[];
  } | null;
  /**
   * The income side of `overdue`: this month's paydays that passed with no deposit against them — null when none did,
   * on a bill, and on the agent's income.
   *
   * 🔴 `/recurring/<It America LLC (weekly pay)>` on a copy of his ledger 2026-10-12 read "Awaiting statements" and
   * "Next expected Oct 15", and said nothing of Oct 1 or Oct 8. The forecast on /recurring said "2 paydays worth
   * $2,283.84 already passed this month … the ledger has not looked for their deposits", /budgets the same, and every
   * bill's page lists what came due. The page that is ABOUT that pay was the only one silent.
   *
   * ⛔ The forecast's reading, not a second one: `unbankedIncomeThisMonth` over the month the forecast walks, with its
   * checked split and frontier (`unbankedIncomeTotals`) — so the page and the note cannot name different Thursdays,
   * or call one checked the other calls unread. ⚖️ The agent's income stays out as the forecast and /budgets leave it
   * out (`isAgentsIncomeSeries`, owner decision 2026-09-28).
   */
  unbankedPaydays: UnbankedPaydays | null;
  /**
   * His pay — an income series that is not the agent's (`isAgentsIncomeSeries`, owner decision 2026-09-28): while it is
   * live, `incomeExpectation` levels it into the monthly income /budgets grades against and the runway counts on. The
   * End dialog names that income (`seriesEndHeadline`). 🔴 It said ending It America LLC (weekly pay) left "the forecast
   * and the recurring calendar" — and on a copy of his ledger 2026-10-12 ending it took /budgets' expected income from
   * $4,948.32 to $0.00 and the runway from 2.6 months of cash to 1.0.
   */
  isHisPay: boolean;
  /** A pay line of the dashboard's Earned vs banked card — the card's own readings (`incomeCardSeriesIds`). */
  onEarnedVsBanked: boolean;
  /** full linked history, newest first */
  linkedTxns: SeriesLinkedTxn[];
  /** linked charge amounts oldest → newest, for the drift chart */
  amountHistory: AmountHistoryPoint[];
  /** other live series this one can merge in — none on a page that cannot be reshaped (`seriesCanBeReshaped`) */
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

/** `SeriesDetail.isHisPay`: income, and not the agent's — the filter `incomeExpectation` and the forecast read by. */
function isHisPay(db: AppDatabase, s: { readonly kind: SeriesKind; readonly accountId: string | null }): boolean {
  return s.kind === "income" && !isAgentsIncomeSeries(outsidePortfolioCashAccountIds(db), s);
}

/**
 * This month's passed paydays with no deposit, for one series' page — `SeriesDetail.unbankedPaydays`. Null for a bill
 * and for the agent's income (the forecast's own series filter), and when nothing passed unpaid.
 *
 * The kind is asked first only so a bill's page skips the walk, which reads income alone (`unbankedIncomeForSeries`).
 */
function unbankedPaydaysOf(
  db: AppDatabase,
  s: { readonly id: string; readonly kind: SeriesKind; readonly accountId: string | null },
  today: string,
): UnbankedPaydays | null {
  if (!isHisPay(db, s)) return null;
  const unbanked = unbankedIncomeThisMonth(db, new Set([s.id]), today);
  const passed = unbanked.series[0];
  if (passed === undefined) return null;
  const {
    totalCents,
    occurrenceCount,
    checkedOccurrenceCount,
    pastGraceOccurrenceCount,
    frontier,
    unattached,
    inGraceUnattachedCount,
  } = unbankedIncomeTotals(unbanked);
  return {
    totalCents,
    occurrenceCount,
    checkedOccurrenceCount,
    pastGraceOccurrenceCount,
    frontier,
    unattached,
    inGraceUnattachedCount,
    paydays: passed.occurrenceDates.map((date, i) => ({ date, amountCents: passed.occurrenceCents[i]! })),
  };
}

const NEXT_EXPECTED_COUNT = 3;

/** The other live series that can merge into `seriesId`, each with what merging it would file (§6A 54). */
function mergeCandidatesOf(db: AppDatabase, seriesId: string): SeriesMergeCandidate[] {
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
  return liveOthers.map((c) => ({ ...c, filing: filings.get(c.id) ?? null }));
}

export function seriesDetail(
  db: AppDatabase,
  seriesId: string,
  today: string = todayIso(),
): SeriesDetail {
  const row = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!row) throw new Error(`Unknown recurring series ${seriesId}`);
  // ⚖️ with the carrier it is billed with — its evidence (`lastSeenOn`, §6A 59)
  const s = { ...row, billedWith: billingCarriers(db).get(row.id) ?? null };

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
      categoryId: transactions.categoryId,
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
  // the calendar's reading of a pay series' rows, behind the calendar's own gate — his spending linked to it read as
  // the money it is, never in its day's (`asPayRows`)
  const idx = readsPerPayday(s) ? loadCategoryIndex(db) : null;
  const readings =
    idx !== null
      ? paydayReadings(asPayRows(idx, linked), paydaySettlement(db, s.id, today, idx).portions, eff)
      : new Map<string, PaydayReading>();
  /*
   * What posted, averaged, and its sample standard deviation — the reading `listSeries` publishes to the All tab and
   * the popover names (`postedAveragesBySeries`): a pay series' is what a payday paid at the rate in force now, a
   * bill's what each occurrence was paid. Two samples is the floor of a spread: with one there is nothing to vary, and
   * the seed that used to be printed here claimed a spread for series with none at all.
   */
  const posted = postedAveragesBySeries(db, [s], today).get(s.id)!;

  /*
   * ⛔ A bar per PAYMENT where the average is per payment (`posted.everyOccurrence`) — Jun 16's two card rows one bar,
   * said "one payment, posted as 2" — as a lump of pay is drawn as the calendar reads it. 🔴 Row by row, his rent's
   * history read "each of the 5 posted occurrences … Jun 16, 2026 -$1,100.00 -$1,009.00 · -$1,334.80 -$774.20" under a
   * Per charge of four payments, each above the -$2,109.00 (review of af5b0fa, a copy of his ledger, 2026-10-12).
   *
   * ⚖️ Every payment at every rate, each against its own time's (§6A 55): a history is drawn whole, as his pay's cash
   * weeks are, though the Per charge above averages only the payments at the rate in force now (§6A 63).
   */
  // ⚖️ …of which the days that PAID a charge — every grader's one rule (`daysThatPaid`); money back is held to nothing
  const paidDays =
    posted.everyOccurrence === null
      ? null
      : new Set(daysThatPaid(posted.everyOccurrence, seriesAmountCents(s)).map((o) => o.postedOn));
  const amountHistory: AmountHistoryPoint[] =
    posted.everyOccurrence !== null
      ? posted.everyOccurrence.map((o) => ({
          date: o.postedOn,
          amountCents: o.amountCents,
          perPayday: null,
          expectedCents: paidDays!.has(o.postedOn) ? expectedCentsOf(undefined, eff, o.postedOn) : null,
          towardNoPayday: false,
          ...(paidDays!.has(o.postedOn) ? {} : { towardNoDueDay: true as const }),
          postings: o.postings,
        }))
      : [...linked].reverse().map((t) => {
          const reading = readings.get(t.id);
          return {
            date: t.postedOn,
            amountCents: t.amountCents,
            perPayday: reading?.perPayday ?? null,
            // ⚖️ each row against its own time's rate (§6A 55), by the calendar's own rule — a pay row, the rate of
            // the payday it paid, and nothing when it paid none; any other row, its own day's
            expectedCents: expectedCentsOf(reading, eff, t.postedOn),
            towardNoPayday: reading?.towardNoPayday ?? false,
            // the calendar's own flag for it (`asPayRows`: ONE flagging for every reader of a pay series' rows)
            ...(reading?.notFiledAsIncome === true ? { notFiledAsIncome: true as const } : {}),
          };
        });

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
  // the day its accounts are read through: late and lapsed are both measured there (§6A 57) — the badge reads it too
  const checkedThrough = silenceMeasuredThroughBySeries(db, today)(s.id);
  const projects = seriesIsForecast(s, today, checkedThrough);

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
  // ⛔ …and less a bill's day a payment has already paid — the same reading, and the same reach: a payment pays a day
  // only within its grace of it. 🔴 With the rent paid Sep 30 the rent's page listed Oct 1, Nov 1 and Dec 1 next, and
  // its End dialog read "every charge from Oct 1, 2026 on", beside a calendar drawing Oct 1 paid (review of 50020a2).
  // ⛔ …and the steps are counted from the series' OWN next day when that is later than today: "the first can land up
  // to one whole step out" is untrue of a one charge (§6A 56) or an anchor typed further ahead. 🔴 Review of 89f235d:
  // the Nov 11 balance moved to Nov 11, 2027 (a copy of his ledger, 2026-10-13) listed nothing next, and its End dialog
  // read "Upcoming charges off the calendar: none scheduled" under "Leaving the forecast: ~$72.74, its one charge" — as
  // one on Mar 11, 2027, inside the year, did too. A longer window only adds days after the ones it held, so a series
  // whose next day is near keeps every day it listed. ⚖️ …its own next day, or where its schedule opens when that is
  // later (`opensOn`: billed inside another, the day of its own that falls due with its carrier's opening day, the one
  // the carrier's payment of that day pays — default built, not asked, 2026-10-29)
  const projectable = toProjectable(s);
  const ownNext =
    projectable.opensOn && eff.nextExpectedOn !== null && compareDates(projectable.opensOn, eff.nextExpectedOn) > 0
      ? projectable.opensOn
      : eff.nextExpectedOn;
  const windowFrom = ownNext !== null && compareDates(ownNext, today) > 0 ? ownNext : today;
  const nextExpected = projects
    ? stillToCome(
        stillToComeReader(db, [s], today),
        s,
        projectOccurrences(
          projectable,
          today,
          addDays(
            stepFrom(windowFrom, stepPlan(eff.cadence, eff.intervalDaysAvg), NEXT_EXPECTED_COUNT + 1),
            s.toleranceDays,
          ),
        ),
      ).slice(0, NEXT_EXPECTED_COUNT)
    : [];
  // the sentence's day, the date its editor opens on and saves — its OWN schedule's (`nextExpectedOn` below) — and the
  // day that one falls due on (`fallsDueOn`): billed inside another, its carrier's day it pairs with when later, the
  // day its list above names it by (default (B), built, not asked, 2026-10-30)
  const sentenceOn = projects ? rollForwardNextExpected(projectable, today) : eff.nextExpectedOn;
  const sentenceFallsDueOn = projects && sentenceOn !== null ? fallsDueOn(projectable.pairedWith, sentenceOn) : null;
  // ⛔ …said of the LIST, not of that one day: where it ties with the carrier's — a month too short for either, both
  // clamped to its last — the first day the list names on the carrier's later day says it (review of 933b29e2, L76)
  const listFallsDueOn = nextExpected.find((o) => o.date !== o.ownDate)?.date ?? null;

  /*
   * ⛔ The BACKWARD half asks the arrears walk's own rule — a live status, not let go (`overdueForSeries` filters both)
   * — never `projects`, which is forward: a schedule its end has closed projects nothing and still owes the last date
   * that came due unposted this month. 🔴 Gated on `projects` once the schedule's end joined it, the Nov 11 balance's
   * already-due card would have gone from Nov 12 while the forecast and the runway still owed its $72.74 (review of
   * 0af5689).
   */
  const late = arrearsThisMonth(db, new Set([seriesId]), today).series[0] ?? null;
  const overdue = late
    ? {
        date: late.nextDate,
        ownDate: late.occurrenceOwnDates[0]!,
        amountCents: -late.amountCents,
        occurrenceCount: late.occurrenceCount,
        unreadCents: late.unreadCents,
        inGraceCents: late.inGraceCents,
        graceDays: late.graceDays,
        carriedGrace: late.carriedGrace,
        unattached: late.unattached,
      }
    : null;
  const unbankedPaydays = unbankedPaydaysOf(db, s, today);
  const hisPay = isHisPay(db, s);
  // the card reads confirmed pay alone (`cashEarningsReadings`): asked first only so no other page walks its readings
  const onEarnedVsBanked = hisPay && s.status === "confirmed" && incomeCardSeriesIds(db, today).has(s.id);

  const namedCategoryId = seriesCategoryIds(db, loadCategoryIndex(db), [s.id]).get(s.id);

  // read only where the page renders the merge control — the one predicate both ask
  const mergeCandidates = seriesCanBeReshaped(s.status) ? mergeCandidatesOf(db, seriesId) : [];

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
    // Rolled forward to its first own day still to FALL DUE (`rollForwardNextExpected`), so the sentence names no day
    // whose charge has come and gone: a day gone by only billed inside another, while the carrier's day it falls due
    // with is still to come — said beside it (`nextFallsDueOn`), and what a Save with nothing changed writes back. On
    // his ledger copy 2026-11-04 with his rent retyped Nov 16, read Nov 10: the utilities' sentence names their Nov 1,
    // "due with the rent on the 16th". 🔴 It said "never reads a date in the past" (review of 933b29e2, L73). Only the
    // series the forecast still projects roll — see `projects` above.
    // ⛔ The schedule's step, not settlement's (`nextStillToCome`, listSeries'
    // reading): the sentence's editor opens on this date and Save writes it back
    // as the anchor. 🔴 Read through settlement it opened past a payday a deposit
    // had paid early. Measured on a copy of his ledger: read on Sep 23 or 24 it
    // opened on Oct 1, past the Sep 24 payday the Sep 23 lump of $4,567.68 paid,
    // and Save with nothing changed took Sep 24 out of the projection settlement
    // walks. The token read "Thursdays" either way.
    // ⚖️ …stepped as its list is (`projectable`): never before the day its schedule opens — billed inside another, the
    // day of its own that falls due with its carrier's opening day (`openingOf`; default built, not asked, 2026-10-29),
    // the day Save then writes as its own
    nextExpectedOn: sentenceOn,
    // ⚖️ …and the day it falls due on, said beside it when that is another — the day its list names (`nextFallsDueOn`)
    nextFallsDueOn: sentenceFallsDueOn === sentenceOn ? listFallsDueOn : sentenceFallsDueOn,
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
    carries: posted.carries,
    paidAhead: posted.paidAhead,
    intervalDaysAvg: s.intervalDaysAvg,
    toleranceDays: s.toleranceDays,
    confidence: s.confidence,
    lastMatchedOn: s.lastMatchedOn,
    isActive: isSeriesActive(s, today),
    // late only on days the ledger has checked — the badge's word and its tone (`seriesEvidenceTone`)
    evidence: seriesEvidence(s, today, checkedThrough),
    neverPosted: neverPosted(seriesStaleness(s, today, checkedThrough)),
    billedWith: s.billedWith,
    endsOn: s.userEndsOn ?? null,
    scheduleRanOutOn: scheduleRanOutOn(s, today),
    lastFallsDueOn: projects ? lastFallsDueAfterItsEnd(projectable, today) : null,
    oneChargeOn: oneChargeDays(db, [s]).get(s.id) ?? null,
    annualizedCents: annualizedCentsOf(s, today, checkedThrough),
    nextExpected,
    overdue,
    unbankedPaydays,
    isHisPay: hisPay,
    onEarnedVsBanked,
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

/**
 * Writes user overrides (§4.4). Detection keeps its own columns; the UI reads user-first.
 *
 * ⚖️ §6A 56 (2026-10-08): a ONE-CHARGE series' day is its whole schedule, so moving that day moves its end with it —
 * here, so the date token, a reset to detected and any later caller all keep the one charge on its own schedule.
 * 🔴 The token wrote the next day alone (review of 8a4ac47). On a copy of his ledger, the Nov 11 balance moved to
 * Nov 14 passed its Nov 11 end: the walk held nothing, the $72.74 left the forecast, and the card said "1 has already
 * ended" about a balance still owed. Every other series' end is its own and stays where it is.
 */
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
    const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
    // the day the one charge lands on after this write: the override, or the detected day a reset hands it back to
    const movedTo = patch.userNextExpectedOn ?? s?.nextExpectedOn ?? null;
    if (s !== undefined && movedTo !== null && oneChargeDays(db, [s]).has(s.id)) patch.userEndsOn = movedTo;
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
