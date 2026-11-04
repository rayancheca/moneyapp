import { cache } from "react";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import type { BillingCarrier, CarrierSchedule, OpeningPayment } from "@/lib/billed-with";
import { compareDates, diffDays } from "@/lib/dates";
import { daysThatPaid, occurrencesOf, paidAheadDays, readsPerOccurrence } from "@/lib/posted-average";
import { stepPlan } from "@/lib/recurring-step";
import { seriesAmountCents } from "@/lib/series-kind";
import {
  dueDayNearest,
  dueDaysApart,
  dueDaysOf,
  dueDayStepped,
  effectiveSchedule,
  effectiveSeries,
  liesNearerTheLater,
  ownOpening,
  resolveMergeTarget,
  type CarriedBy,
  type EffectiveSchedule,
  type ScheduleOpening,
  type SeriesOverrides,
} from "./recurring";

/**
 * ⚖️ Each series billed INSIDE another, and the carrier it is billed with (owner decision 2026-10-08, §6A 59) — keyed
 * by the CARRIED series' id. The one place the link column is read; `lib/billed-with` is what it means.
 *
 * The carrier is the LIVE series the link names, followed through any merge (`resolveMergeTarget`, detection's own
 * forward map). 🔴 It lent the named series' own `last_matched_on`, and a merge ends the source without touching it:
 * the rent merged into detection's series of the Wells Fargo rows kept posting under the target while the utilities
 * read the ended rent's Sep 2 — and 93 days on they lapsed out of the forecast, the committed book, the arrears and
 * the card's live figure, with nothing on screen to say why. His link stays as he wrote it; the READING follows the
 * merge. A carrier merged INTO the series it carries lends nothing: its postings are that series' own now.
 *
 * ⚖️ …and so do the WORDS: the carrier is named by the live series' own name (`carrierWord`) on every surface — merged
 * into detection's "Flamingo South Beach", "billed with Flamingo South Beach"; named "… (rent)", "billed with the
 * rent" again — never the ended rent's word on one surface and the live series' on another (review of §6A 59,
 * resolved 2026-10-13; pinned in billed-with.test.ts, "after the merge every surface names…").
 *
 * ⚖️ …and so does WHERE IT OPENS: the live carrier's own opening (`ownOpening`) — its date, his or detection's — and
 * the payment that paid it (`openingPaymentsOfRender`), which open what it carries, on the day of its own that falls
 * due with it, for every grader and every projection (`openingOf`), read here once with the rest — and its own
 * schedule (`BillingCarrier.schedule`), which pairs each later day of what it carries with its own day of that period
 * (`pairingOf`; default (B), built, not asked, 2026-10-30).
 *
 * Two small queries rather than a self-join: `aliasedTable` breaks drizzle's row inference (see `seriesHues`), and on
 * a ledger with no link the second is never asked. The second reads every series, as detection's merge map does — a
 * merge chain can pass through any of them.
 */
export function billingCarriers(db: Pick<AppDatabase, "select">): ReadonlyMap<string, BillingCarrier> {
  const carried = db
    .select({ id: recurringSeries.id, carrierId: recurringSeries.userBilledWithSeriesId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userBilledWithSeriesId))
    .all();
  if (carried.length === 0) return new Map();
  const series = db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      lastMatchedOn: recurringSeries.lastMatchedOn,
      mergedIntoId: recurringSeries.mergedIntoId,
      cadence: recurringSeries.cadence,
      userCadence: recurringSeries.userCadence,
      intervalDaysAvg: recurringSeries.intervalDaysAvg,
      anchorDay: recurringSeries.anchorDay,
      nextExpectedOn: recurringSeries.nextExpectedOn,
      userNextExpectedOn: recurringSeries.userNextExpectedOn,
      nextExpectedAmountCents: recurringSeries.nextExpectedAmountCents,
      userAmountCents: recurringSeries.userAmountCents,
    })
    .from(recurringSeries)
    .all();
  const byId = new Map(series.map((s) => [s.id, s] as const));
  const mergedById = new Map(series.map((s) => [s.id, s.mergedIntoId] as const));
  const live = carried.flatMap((c) => {
    const liveId = resolveMergeTarget(c.carrierId!, mergedById);
    return liveId === c.id ? [] : [[c.id, liveId] as const];
  });
  if (live.length === 0) return new Map();
  // one string of the carriers, sorted: `cache` keys on its arguments as passed
  const paidBy = openingPaymentsOfRender(db, [...new Set(live.map(([, liveId]) => liveId))].sort().join(","));
  return new Map(
    live.map(([carriedId, liveId]) => {
      // the column REFERENCES the table and a merge names a series in it, so every carrier is there
      const carrier = byId.get(liveId)!;
      const { id, name, lastMatchedOn } = carrier;
      const opensPaidBy = paidBy.get(id) ?? null;
      const schedule = carrierScheduleOf(carrier);
      return [carriedId, { id, name, lastMatchedOn, ...ownOpening(carrier), opensPaidBy, schedule }] as const;
    }),
  );
}

/** A carrier's schedule as its due days step (`BillingCarrier.schedule`): its effective one, his overrides first. */
function carrierScheduleOf(carrier: SeriesOverrides): CarrierSchedule {
  const { cadence, intervalDaysAvg, nextExpectedOn, anchorDay } = effectiveSchedule(carrier);
  return { cadence, intervalDaysAvg, nextExpectedOn, anchorDay };
}

/**
 * ⚡ MEMOISED FOR ONE SERVER RENDER — `react`'s `cache`, for `buildPortfolio`'s reason (`services/portfolio`): the
 * carriers' opening payments (`openingPayments`), keyed by their ids, comma-joined. Each is read off every posting of
 * its carrier, as its graders read them, and `transactions` has no index on the series link, so one read scans every
 * row — 0.6 ms on his ledger copy 2026-10-29 (13,026 rows), against 0.09 ms for the rest of a `billingCarriers` call,
 * which /budgets' pace statuses alone make 62 times a render. `cache()` does not memoise outside a render, so tests
 * and scripts read it fresh every call.
 */
const openingPaymentsOfRender = cache(function openingPaymentsOfRender(
  db: Pick<AppDatabase, "select">,
  carrierIds: string,
): ReadonlyMap<string, OpeningPayment> {
  const carriers = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.id, carrierIds.split(",")))
    .all();
  return openingPayments(db, carriers);
});

/**
 * ⚖️ Per carrier, the payment that PAID where its own schedule opens by its own test — `paymentFor` over the postings
 * and due days its own graders read (`billPaymentsBySeries`, `billDueDaysBySeries`), his date included — with how many
 * of its due days that payment's own day lies past the opening day (`OpeningPayment`), read off the branch of
 * `paymentFor` that found it; none while nothing has paid it. What says which day of a series billed inside it its
 * first period carries (`openingOf`; default built, not asked, 2026-10-29). ⛔ Read as billed on its own — one hop:
 * the link's one writer refuses a carrier billed with another (`scripts/link-utilities-to-rent.ts`).
 *
 * 🔴 Its own day was its due day NEAREST the payment (review of 46f19f15): a payment of ONE month, late for the
 * opening day by default (c) — nearer the next day, which another payment paid on time — read as that next day's, so
 * what the carrier carries opened a day of its own behind the one the payment pays. The rent typed Nov 25, Dec 12 then
 * Dec 25: {Dec 12, 1}, and on Dec 27 November drew the utilities' Nov 1 missed beside the rent's Nov 25 paid by Dec 12.
 */
function openingPayments(
  db: Pick<AppDatabase, "select">,
  carriers: readonly (SeriesOverrides & { id: string; toleranceDays: number })[],
): ReadonlyMap<string, OpeningPayment> {
  const rows = carriers.map((c) => ({ ...c, billedWith: null }));
  const payments = billPaymentsBySeries(db, rows);
  const dueDays = billDueDaysBySeries(rows);
  const out = new Map<string, OpeningPayment>();
  for (const c of carriers) {
    const days = dueDays.get(c.id)!;
    if (days.opensOn === null) continue;
    const own = payments.get(c.id) ?? [];
    const paid = paymentFor(own, days.opensOn, days);
    if (paid === undefined) continue;
    out.set(c.id, { postedOn: paid.postedOn, dueDaysPast: dueDaysPastOf(own, days.opensOn, days) });
  }
  return out;
}

/**
 * How many due days the own day of the payment that pays `dueOn` lies past it — the branch of `paymentFor` that found
 * it: its own day's payment, on time, early or late (0); the second charge of the day before (−1); a payment of two
 * that caught it up from the day after (1). Asked only of a day some payment pays.
 */
function dueDaysPastOf(payments: readonly Payment[], dueOn: string, dueDays: DueDays): number {
  if (nearerDaysPayment(payments, dueOn, dueDays) !== undefined) return 0;
  return paidAheadFromTheDayBefore(payments, dueOn, dueDays) !== undefined ? -1 : 1;
}

/**
 * ⚖️ The other way round: per CARRIER, the names of the series billed inside its payments (§6A 59) — keyed by the LIVE
 * carrier (`billingCarriers`, through any merge), names in order. A carrier's posted average holds their money too, and
 * the line naming it says so (`carriesPhrase`). Nothing is asked of a ledger with no link.
 */
export function carriedNamesBySeries(db: AppDatabase): ReadonlyMap<string, readonly string[]> {
  const carriers = billingCarriers(db);
  if (carriers.size === 0) return new Map();
  const names = new Map(
    db
      .select({ id: recurringSeries.id, name: recurringSeries.name })
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, [...carriers.keys()]))
      .all()
      .map((s) => [s.id, s.name] as const),
  );
  const out = new Map<string, string[]>();
  for (const [carriedId, carrier] of carriers) {
    out.set(carrier.id, [...(out.get(carrier.id) ?? []), names.get(carriedId)!].sort((a, b) => a.localeCompare(b)));
  }
  return out;
}

/**
 * The rows, each with the carrier it is billed with (`billedWith`, null when billed on its own) — how a series row
 * reaches an evidence reader (`seriesStaleness`, `seriesEvidence`, `hasStoppedForecasting`…) and a projection
 * (`toProjectable`), which REQUIRE it.
 */
export function withBillingCarriers<T extends { id: string }>(
  db: Pick<AppDatabase, "select">,
  rows: readonly T[],
): (T & { billedWith: BillingCarrier | null })[] {
  const carriers = billingCarriers(db);
  return rows.map((r) => ({ ...r, billedWith: carriers.get(r.id) ?? null }));
}

/**
 * ⛔ A row of money IN as a projection takes it (`toProjectable`'s `CarriedBy`): billed on its own. §6A 59 bills a
 * COMMITMENT inside another's payment, and the link's one writer refuses any series that is not a bill
 * (`scripts/link-utilities-to-rent.ts`), so a pay series' walk needs no read of the link — only for a row read as money
 * in (`kind === "income"`); a bill's carrier is read (`withBillingCarriers`).
 */
export function asMoneyIn<T extends { kind: string }>(row: T): T & { readonly billedWith: null } {
  return { ...row, billedWith: null };
}

/** A posting that may pay a due day: the day it posted, and how many days either side of a due day it may land. */
export interface Payment {
  readonly postedOn: string;
  readonly toleranceDays: number;
  /**
   * ⚖️ It covered more than one charge (`paidAheadDays`) — in the rate era in force now, the payment its series'
   * posted average names; in an earlier one, a payment its own era's rate reads so, which no average names (the
   * average holds today's era only, `atTodaysRate` — latent: only his pay has a rate history) — and so pays a second
   * due day (`paymentFor`'s catch-up). Every grader's are read with it (`BillPayment`); absent, one charge.
   */
  readonly coveredMore?: boolean;
  /**
   * ⚖️ …and it is its CARRIER's, for a series billed inside another (`BillPayment.carried`): graded on the carrier's
   * own day it pairs with (`DueDays.pairedWith`), never on a day of the series' own; absent, its own.
   */
  readonly carried?: boolean;
}

/**
 * A bill's due days either side of one — its schedule's steps from its anchor, its end and its anchor disregarded
 * (`dueDaysOf`): the days a payment between two of them is measured against, to pay the one it lies nearer (⚖️ his
 * decision 76, `paymentFor`). Every grader of a bill's day reads the series' own (`billDueDaysBySeries`), so each
 * reads the same days.
 */
export interface DueDays {
  /** the due day after `day`, or null — which asks nothing late (`stillToComeReader`) */
  readonly after: (day: string) => string | null;
  /** the due day before `day`, or null — which leaves nothing to pay `day` early */
  readonly before: (day: string) => string | null;
  /**
   * ⚖️ the day its schedule opens (`openingOf`), or null with no schedule — ONE day for every reader: none projects a
   * due day of it before it (`ProjectableSeries.opensOn`: the walk, and the next date it names), and every due day
   * from it on is a charge (`couldHaveCharged`). One before it is none once it is his date (`opensOnHisDate`), else
   * none before it and before every payment — so no payment of two catches it up (`paymentFor`'s catch-up; default
   * built, not asked, 2026-10-23). Billed on its own, its anchor, where its projection starts. Billed inside another,
   * the day of its OWN that falls due with its CARRIER's opening day — the one the carrier's payment of that day pays,
   * its due day nearest that payment; none yet, its due day nearest that day, a tie the earlier (`openingOf`) — the
   * carrier's date he typed: its projection floored there, starting at its own anchor only when that is later;
   * detection's: the earlier of that day and its own anchor, which opens its projection (default built, not asked,
   * 2026-10-29): the payments are the carrier's, and so is the test. Always one of its own days. 🔴 Until then "where
   * every reader's projection of a bill starts" was false of what the rent carries: its projection opened at its own
   * date, before the rent's he typed (review of 68c837ce — `openingOf`); 🔴 then at the rent's date itself, after the
   * day of its own the rent's first month carries (review of 0ac5d059); 🔴 then on its day nearest the rent's date
   * even once paid, a day a payment posted a day or two after that date may never pay (review of ec7fd198).
   */
  readonly opensOn: string | null;
  /**
   * ⚖️ …and whether that day is HIS (`userNextExpectedOn`): his date IS the schedule, so no day before it was a charge,
   * whatever posted before it (default built, not asked, 2026-10-23), nor one a payment of two catches up from
   * (`liesBeforeHisDate`, 2026-10-29). ⛔ Every grader reads it off the series' own row, the readers that look ahead
   * too — pinned in nearer-due-day-catch-up.test.ts ("…on Sep 1 no reader that looks ahead lists Sep 11") — and,
   * billed inside another, off its carrier's (`openingOf`): the rent's date, not the utilities' (pinned in
   * nearer-due-day-carried.test.ts, "…his date on the rent").
   */
  readonly opensOnHisDate: boolean;
  /**
   * ⚖️ …and, billed inside another on the carrier's own step, the carrier's day each of its days PAIRS with
   * (`pairingOf`; default (B), built, not asked, 2026-10-30): a payment of the carrier's pays a day of it only by
   * paying the carrier's day it pairs with, by the carrier's own test (`paymentFor`). Null billed on its own, or on a
   * step of its own (`pairingOf`). ⛔ REQUIRED, `userEndsOn`'s reason: due days built without it would grade what the
   * rent carries by the rent payment nearest each of its days, silently.
   */
  readonly pairedWith: CarrierPairing | null;
}

/**
 * ⚖️ default (B), built, not asked (2026-10-30) — how the days of a series billed inside another PAIR with its
 * carrier's: what `pairingOf` reads, ONE pairing for every grader of its days (`DueDays.pairedWith`, `paymentFor`) and
 * every projection of them (`ProjectableSeries.pairedWith`, `fallsDueOn`).
 */
export interface CarrierPairing {
  /** the carrier's own due days — its schedule, its opening, his date included — as its own graders read them */
  readonly carrierDays: DueDays;
  /** the carrier's day a due day of the series pairs with: the same number of steps on from where the two open */
  readonly carrierDayOf: (day: string) => string | null;
}

/**
 * The payment that pays a due day, or undefined — ON TIME, the nearest within its own tolerance of it, the earlier of
 * two as near; else EARLY or LATE (below). ⛔ The one test of "did a posting cover this occurrence" for every grader of
 * a bill: the arrears (`overdueForSeries`), the calendar (a posting of its own, or its carrier's) and every reader that
 * looks ahead (`stillToComeReader`), so none can grade one Oct 1 apart from another — given the same postings: each
 * reads all of a series' (`billPaymentsBySeries`).
 *
 * 🔴 The calendar read a bill's own postings inside the month alone (review of 1a1b753): with the rent paid Sep 30,
 * October drew its Oct 1 "missed" beside the utilities "paid with the rent's payment of Sep 30", and the arrears owed
 * neither.
 *
 * ⚖️ …else EARLY or LATE by THE NEARER DUE DAY, his decision 76 (2026-10-14, his answer, refines 73). The option he
 * chose reads, word for word: "A payment between two due days pays the one it's nearer to (a tie goes to the earlier
 * one), unless the nearer one is already paid on time." Its description went on with examples written for him, not
 * his words: Sep 2 → Sep 15, an Oct 1 payment → Oct 15, "FPL's 28th drafts" → the next 8th, Car insurance's Sep 3 →
 * Sep 11. 🔴 The third is no shape his ledger shows: Jul 10 −$14.21 and Jul 28 −$56.22 are every FPL posting on it,
 * and Jul 28 pays Aug 8 — both on Chase Checking, read only through Aug 12, so an Aug 28 or Sep 28 draft is unknown,
 * not absent (his ledger copy, 2026-10-29). So a payment between two due days — past the earlier's tolerance and
 * short of the later's (`DueDays.before`, `DueDays.after`) — pays the one it lies NEARER, a tie the earlier
 * (`liesNearerTheLater`): the later EARLY, only when nothing paid that day on time; the earlier LATE. Of several for
 * one day, the earliest, asked early before late. The grace is the days a payment has to post before anything may say
 * "not posted" (his decision 60, 2026-10-08); a payment past them is still a day's. The cost he accepted: one nearer
 * the next day pays it even when the day before is unpaid — FPL with only Jul 28 (a what-if) owes Jul 8 where it
 * owed Aug 8, one month owed either way.
 *
 * What a payment LEFT OVER pays — one nearer a day another payment already pays — his answer does not say: it stops at
 * "unless", and never reaches a nearer day paid EARLY. The three answers below came with the build (f8b5320, from a
 * brief that read "→ the other day" — a paraphrase of his answer, not his words — built one way only); he said no more
 * questions (2026-10-21), so none was asked, and each is written as a default:
 * (a) ⚖️ default built, not asked (2026-10-21) — nearer the EARLIER day, paid ON TIME by another: it pays nothing,
 *     never the later day early. A lease paid on time Oct 15, then $695.04 more Oct 22, still has Nov 15 coming on
 *     Oct 23, in November's forecast at −$695.04 — counted again — and "has not posted" once read past it, drawn
 *     "?" (not yet known: two postings prove no schedule, `scheduleIsProven`), ✕ missed once three do. 🔴 This takes
 *     back decision 73 for that shape: run against 7aca8e5's paymentFor, Oct 22 paid Nov 15 early. What it keeps: a
 *     rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 keeps Nov 1 coming, with November's −$2,109.00 rent and −$182.21
 *     utilities (73 paid it early with the $291.21 — its 🔴, below), and a what-if Jul 12 beside FPL's Jul 10 (which
 *     paid Jul 8) pays no Aug 8. Paying the other day early instead would read the split's $291.21 as November paid
 *     and silently drop Nov 1's $2,291.21 from Upcoming and the forecast; this default's error shows on screen
 *     instead, and lasts one month.
 * (b) ⚖️ default built, not asked (2026-10-21) — nearer a day paid EARLY by another, either side: it pays nothing too.
 *     A lease paid Sep 2 (Sep 15's, early) then Sep 30 — the 15/15 tie, Sep 15's — owes Oct 15 $695.04, as 73 did;
 *     after Sep 2 + Oct 1, Oct 30 leaves Nov 15 coming where Oct 31 pays it. For a bill due the 15th, a pay on the
 *     30th, a Feb 28 or 29, or a Mar 1 outside a leap year lands this way; one on the 31st or the 1st does not.
 *     Paying the other day here would run on: after the known gap's stray half (Jun 17 paying Jul 1 early, below) the
 *     late rents Jul 8, Aug 5, Sep 6, Oct 7 would each pay the month AFTER their own, and Nov 1 leave Upcoming with
 *     Oct 7. The other side: Oct 5, after Oct 1 paid Oct 15 early, lies nearer Oct 15 too — it pays no Sep 15 late.
 * (c) ⚖️ default built, not asked (2026-10-21) — nearer the LATER day, paid ON TIME by another: it is the EARLIER
 *     day's, LATE — or pays nothing, once that day is paid. The redirect runs ONE WAY. It is the LATE default
 *     (2026-10-12, not asked either — a payment past a day's grace, short of the next day's window, is that day's)
 *     still reading the payment once his "unless" rules the later day out; 73 read it so too. It pays only a day
 *     behind the payment, so it never takes a day still to come out of Upcoming or the forecast, as (a)'s other way
 *     would. FPL's Jul 28 pays Jul 8 when Aug 8 is paid on Aug 8 — and nothing beside Jul 10's on-time Jul 8.
 *     Measured on a what-if copy of his ledger 2026-10-21, his September rent moved from Sep 2 to Sep 20 (−$2,291.21,
 *     11 days before Oct 1): alone, it pays Oct 1 early and September draws Sep 1 missed — the cost above; beside an
 *     on-time Oct 1 rent it is Sep 1's, late, and September draws the utilities paid with it. Paying nothing there
 *     (measured with the redirect turned off) leaves Sep 1's rent and utilities missed beside the $2,291.21 that paid
 *     them; the arrears and Upcoming read the same either way.
 * Each pin names its default (nearer-due-day.test.ts, billing-carriers.test.ts). Measured on what-if copies of his
 * ledger 2026-10-21, with that day's four statements read: the split, the Oct 22 prepay, Sep 30, Oct 30 against Oct
 * 31 and Sep 20 each read as above. Sep 30's Oct 15 is all unread there, because Wells Fargo is read through Sep 24.
 * On the ledger itself no live bill's posting is left over or redirected (9 with postings of their own) and no day
 * moves: the lease has posted once, Sep 2 −$695.04.
 *
 * 🔴 Late paid nothing (review of 44eb3e7): the rent paid Oct 5, four days past its Oct 1 and its 3 days, was drawn
 * beside a red ✕ on Oct 1, the runway said "A further $2,291.21 came due earlier this month and never posted.", and
 * /budgets counted it in what was spent AND in what came due — $4,599.86 projected for one month's rent. His July rent
 * posted Jul 8, nearer Jul 1 than Aug 1. 🔴 Early paid nothing (until his decision 73, 2026-10-13): FPL, due the 8th
 * with 3 days' grace, posted Jul 10 −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8 — and Jul 28
 * paid no due day. A bill drafted around every 28th (a what-if: these two are every FPL posting on his ledger, on
 * Chase Checking, read only through Aug 12, so a later draft is unknown, not absent) would have read every
 * statement's newest 8th "not posted" until the following one.
 *
 * 🔴 Decision 73 paid a day early only once the day before was paid by ANOTHER payment (review of 844e484, measured on
 * his ledger copy 2026-10-13): the Car lease's Sep 2 −$695.04, 13 days before Sep 15, read as Aug 15's late payment
 * and left Sep 15 unpaid — a web pay around every 1st would read as the month before's, and every newest 15th "not
 * posted" once Wells Fargo is read past it; and a rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 paid Nov 1 early with
 * October's second half, so Nov 1 left Upcoming and the November forecast. Nearer, Sep 2 pays Sep 15, an Oct 1 web pay
 * Oct 15, Oct 9 nothing (Oct 1 is paid on time) — and FPL's Jul 28 still pays its Aug 8, Car insurance's $1,000.00
 * of Sep 3 its Sep 11. His lease is anchored on Oct 15 (his date): no surface asks its Aug 15.
 *
 * ⛔ ONE PAYMENT PAYS ONE DUE DAY: on time it is in no gap; between two days it is asked for by one of them only — the
 * later early, or the earlier late — and a day takes one. Rows of one day are ONE payment: his card posted Jun 16's
 * rent as two (`occurrencesOf`). ⚠️ Two halves a day apart are two payments — Jun 16 + Jun 17 pay Jun 1 (the tie) and
 * Jul 1 (nearer it): a known gap neither 73 nor 76 catches.
 *
 * ⚖️ …but ONE PAYMENT OF TWO CHARGES PAYS TWO DAYS — default built, not asked (2026-10-23): one its posted average
 * names as covering more than one charge (`Payment.coveredMore`, `paidAheadDays`: `paidAhead`'s one rule) pays the day
 * the rules above give it, and then ONE more (`catchUpPayment`): the due day BEHIND that one, late, when it is a charge
 * (`couldHaveCharged`) no other payment paid, whatever the payment's timing there; else — LATE for its own day, the
 * day behind it settled (`dayBehindIsSettled`) — the day after, early. A premium due the 11th, Sep 11 missed, then one
 * -$715.16: Sep 19 pays Sep 11 late and Oct 11 early (on Sep 25, Oct 11 is no longer coming), Sep 28 Oct 11 early and
 * Sep 11 late, Oct 12 Oct 11 on time and Sep 11 late. Never a third day, and never the day after one it pays early or
 * on time: a payment AHEAD of its own day is not read, so it takes no day still to come out of Upcoming or the forecast
 * — Car insurance's Sep 3 -$1,000.00 pays Sep 11 early and no Oct 11 (his own date starts its schedule at Dec 11, so
 * neither is asked), and after a paid Aug 11 a -$715.16 on Sep 12 pays no Oct 11. 🔴 At 66daebd one payment paid
 * one day, and the other day a catch-up paid was drawn unpaid beside "covered more than one month": Sep 19 left Oct 11
 * owed — the runway's "A further $3,877.56 came due earlier this month: $357.58 has not posted, …" and the series
 * page's "Already due, and not posted" — and with Sep 28 the arrears owed Sep 11 $357.58 on Sep 30 (review of 66daebd;
 * his ledger copy 2026-10-23 with that premium added on Venture X). 🔴 At 67b3b79 a late one paid the day after
 * whatever lay behind its own day, so after TWO missed charges it paid one of them and a day still to come (review of
 * 67b3b79, the same copy): Aug 11 and Sep 11 missed, Sep 19 took Oct 11 out of Upcoming and October's forecast on Sep
 * 25, and on Oct 23 the runway read only "A further $3,519.98 came due earlier this month and no statement has covered
 * it yet." — his own bills — beside August's ✕; Sep 11 and Oct 11 missed, Oct 20 drew Nov 11 "paid early by its
 * payment of Oct 20, 2026", took it out of Upcoming and November's forecast, named Dec 11 next on the All tab and the
 * page, and left Sep 11 ✕. Now Sep 19 pays Aug 11 and Sep 11, and Oct 20 Sep 11 and Oct 11: a biller puts a payment of
 * two against the two arrears, and an error that shows — a day still listed — beats one that hides, as (a) holds.
 * 🔴 At 8348349 the day behind counted as settled only when paid by its OWN payment (review of 8348349, the same
 * copy): of two late payments of two in a row the second paid one day — Jun 11 paid, Jul 20 and Sep 20 each -$715.16,
 * and on Oct 23 October drew Oct 11 missed, the runway read "A further $3,877.56 came due earlier this month: $357.58
 * has not posted, …" and the page showed it overdue beside both named as covering more than one month — and a
 * schedule opening on a late payment of two paid the day BEFORE it: started Aug 11 by his date, Aug 20 -$715.16 paid
 * Jul 11, which no surface shows, and on Sep 25 the arrears owed Sep 11 $357.58 beside "Aug 20's -$715.16 covered
 * more than one month". Now a day the payment of two before it paid early is settled, so Sep 20 pays Oct 11; and a day
 * before the schedule opens (`DueDays.opensOn`) — before his date, whatever posted before it, or before detection's
 * anchor and every payment of it, as before the ledger's first statement — is no charge, so Aug 20 pays Sep 11: no
 * reader projects it, no payment was its. 🔴 At b6e11a76 a payment late for a day BEFORE his date, no charge either,
 * still paid his date early — the day behind its own read as settled for lying there too (review of b6e11a76; his
 * ledger copy 2026-10-29, the same premium): Jun 11 and Jul 11 paid, Sep 19 -$715.16, then he typed Oct 11 — October
 * drew Oct 11 "paid early by its payment of Sep 19, 2026", on Sep 25 Upcoming listed Nov 11 alone and October's
 * forecast left it out, and on Oct 29 nothing was owed. Now none catches up from a day before his date (⚖️ default
 * built, not asked, 2026-10-29 — `paidAheadFromTheDayBefore`): Oct 11 is still to come on Sep 25 and owed once read
 * past, as at 8348349 — and so with only Sep 11 missed (67b3b79 to b6e11a76 paid Oct 11 with Sep 19 there): his
 * date says Oct 11 is to come. ⚠️ The day behind its own is the only one a catch-up pays — a known gap:
 * with Aug 11 missed, Sep 11 paid and Oct 11 missed, Oct 20 still pays Nov 11 early (at 66daebd Nov 11 was still
 * coming). Reaching further back for an unpaid day reads a bill's whole past, where an unread statement or a payment
 * left over reads as a charge owed, and would keep a catch-up after ONE missed charge from paying the day it paid
 * ahead; settling the day behind reads back only along a run of late payments of two, each one's second day. The cost
 * read into his decision 76 above — one month owed either way, this note's words, not his — is a payment of one
 * charge's; a payment of two owes none, and his words are silent on it, as on (a)–(c). Latent: no bill of his has a
 * catch-up.
 *
 * ⚠️ …and a run settles only two due days apart — a known gap too (review of b6e11a76): of two ADJACENT late payments
 * of two, the later is asked first for its own late day (`nearerDaysPayment`, before `catchUpPayment`), the day the
 * earlier one's second charge would pay ahead, so that charge pays no day. Jun 11, then Jul 20 and Aug 20 each
 * -$715.16: Jul 11 is Jul 20's, Aug 11 and Sep 11 Aug 20's, and Oct 11 owed beside both named as covering more than
 * one month — five charges, four days; with Sep 20 a third, seven and five. Paying every one reads the run as one
 * allocation, each payment pushing the next a day further ahead, onto days still to come — not built, an owner's call
 * (2026-10-29): its error shows a paid day owed, the safe direction. Pinned in billing-carriers.test.ts and
 * nearer-due-day-catch-up.test.ts.
 *
 * ⛔ Nothing is read back but that run: a day's payment lies between the days either side of it — a catch-up, between
 * the day either side and the one past it — and whether the day after is paid on time; and the day behind one a late
 * payment of two pays is settled by its own days, or by the late payment of two before it, two due days back a link
 * (`dayBehindIsSettled`). So no reader needs more than the postings back to the start of such a run — three due days
 * behind its window without one — and two ahead (`billPaymentsBySeries` reads every one).
 *
 * ⚖️ …and a day of a series billed inside another, on the carrier's own step, is paid by its carrier's payments ONLY
 * as the carrier's day it pairs with is: whatever pays that day by the carrier's own test — everything above, decision
 * 76 and the catch-up, over the carrier's payments and the carrier's own days (`DueDays.pairedWith`, `pairingOf`;
 * default (B), built, not asked, 2026-10-30). A row of its own still pays a day of its own by its own days, as a bill
 * on its own is paid. So each payment of the rent's pays exactly one month of what it carries, the one its own day
 * carries, and a payment of ONE charge of the rent's is graded exactly as before — the rent's own grading does not
 * change. ⛔ The safe direction: no payment of the carrier's pays a day of what it carries without paying the carrier's
 * day it pairs with. 🔴 Graded by the rent payment NEAREST each of their days (round 3's reading after the first
 * period), the rent typed Nov 16, paid Nov 16 then Dec 17 — a day past the midpoint, nearer their Jan 1 — owed their
 * Dec 1 $182.21 beside a rent paid on time and drew their Jan 1 "paid early by Dec 17" (the owner question 46f19f15
 * left; pinned in nearer-due-day-paired.test.ts, "⚖️ (B) …").
 */
export function paymentFor<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  const paired = dueDays.pairedWith;
  if (paired === null) return paymentOnItsDays(payments, dueOn, dueDays);
  // a row of its own on its own days; its carrier's payments only on the carrier's day this one pairs with
  const own = paymentOnItsDays(payments.filter((p) => p.carried !== true), dueOn, { ...dueDays, pairedWith: null });
  if (own !== undefined) return own;
  const carrierOn = paired.carrierDayOf(dueOn);
  if (carrierOn === null) return undefined;
  return paymentOnItsDays(payments.filter((p) => p.carried === true), carrierOn, paired.carrierDays);
}

/** `paymentFor` on one series' own days: on time, else early or late by the nearer day, else a catch-up's. */
function paymentOnItsDays<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  return nearerDaysPayment(payments, dueOn, dueDays) ?? catchUpPayment(payments, dueOn, dueDays);
}

/**
 * The day a payment of `dueOn` was graded on (`paymentFor`): for a payment of its carrier's, billed inside another on
 * the carrier's step, the carrier's day `dueOn` pairs with (`DueDays.pairedWith`); else `dueOn` itself. What a reader
 * asks "on time?" of it against — the calendar's choice of which payment on time it names (`paymentNamedFor`).
 */
export function dayPaidAs(dueDays: DueDays, dueOn: string, payment: Payment): string {
  if (payment.carried !== true || dueDays.pairedWith === null) return dueOn;
  return dueDays.pairedWith.carrierDayOf(dueOn) ?? dueOn;
}

/** The payment of a due day by its own days — on time, else early or late by the nearer day (`paymentFor`). */
function nearerDaysPayment<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  const onTime = onTimePayment(payments, dueOn);
  if (onTime !== undefined) return onTime;
  const before = dueDays.before(dueOn);
  if (before !== null) {
    // early: nearer this day than the one before — nothing paid this day on time (above); never one nearer the day
    // before, whether that day was paid on time or early (⚖️ defaults (a) and (b), built, not asked — above)
    const early = paymentDaysBetween(payments, before, dueOn).find((p) =>
      liesNearerTheLater(p.postedOn, before, dueOn),
    );
    if (early !== undefined) return early;
  }
  const after = dueDays.after(dueOn);
  if (after === null) return undefined;
  // late: nearer this day than the next — or nearer the next, when another payment paid that one on time (⚖️ default
  // (c), built, not asked — above)
  const afterOnTime = onTimePayment(payments, after) !== undefined;
  return paymentDaysBetween(payments, dueOn, after).find(
    (p) => afterOnTime || !liesNearerTheLater(p.postedOn, dueOn, after),
  );
}

/**
 * ⚖️ default built, not asked (2026-10-23): the payment of two charges that pays an unpaid due day from the day either
 * side of it (`paymentFor`) — the day before's, LATE there, once the day behind THAT one is settled
 * (`paidAheadFromTheDayBefore`), else it paid that one; or the day after's, whatever its timing there, this day being
 * a charge (`couldHaveCharged`) and the unpaid one behind it. Each read by its own days and the run of late payments
 * of two before them, so no payment pays a third. ⛔ …and never the day before's when that day lies before HIS date
 * (`liesBeforeHisDate`, 2026-10-29): no charge, so the payment catches nothing up and pays neither this day nor the one
 * behind — he typed Oct 11 after Sep 19's -$715.16, Jun 11 and Jul 11 paid, Aug 11 and Sep 11 missed: Oct 11 is owed.
 * 🔴 Unsaid here at fc4444b2: read as written, Sep 19 paid his Oct 11 once the day behind was settled, as at b6e11a76
 * it did (review of b6e11a76).
 */
function catchUpPayment<P extends Payment>(payments: readonly P[], dueOn: string, dueDays: DueDays): P | undefined {
  const ahead = paidAheadFromTheDayBefore(payments, dueOn, dueDays);
  if (ahead !== undefined) return ahead;
  const after = dueDays.after(dueOn);
  if (after === null || !couldHaveCharged(payments, dueOn, dueDays)) return undefined;
  // early, on time or late for the day after, it lies past this day's grace — inside it, it would have paid this day
  // on time — and this day is the one behind it: late there, it pays this day before any day still to come
  const paidAfter = nearerDaysPayment(payments, after, dueDays);
  return paidAfter?.coveredMore === true ? paidAfter : undefined;
}

/**
 * The payment of two LATE for the due day before `dueOn` that pays `dueOn` early, its second charge — once the day
 * behind its own is settled (`dayBehindIsSettled`). ⛔ Never one on time or early there: a payment ahead of its own
 * day is not read ahead (⚖️ default built, not asked, 2026-10-23 — `paymentFor`). ⛔ …and never one late for a day
 * before HIS date (`liesBeforeHisDate`): that day is no charge, so the payment has nothing of his to catch up, and its
 * second charge pays no day of his (⚖️ default built, not asked, 2026-10-29). 🔴 At b6e11a76 that day was asked as its
 * own, and the day behind it read as settled for lying before his date too, so a payment late for the day before his
 * date paid his date early (review of b6e11a76): Jun 11 and Jul 11 paid, Sep 19 -$715.16, then he typed Oct 11 — Oct
 * 11 drawn "paid early by its payment of Sep 19, 2026", and out of Upcoming and October's forecast on Sep 25.
 */
function paidAheadFromTheDayBefore<P extends Payment>(
  payments: readonly P[],
  dueOn: string,
  dueDays: DueDays,
): P | undefined {
  const before = dueDays.before(dueOn);
  if (before === null || liesBeforeHisDate(before, dueDays)) return undefined;
  // the day after the day before is this one — `stillToComeReader` asks no day after a day from today on
  const days = withDayAfter(dueDays, before, dueOn);
  const paidBefore = nearerDaysPayment(payments, before, days);
  if (paidBefore?.coveredMore !== true || !paysLate(paidBefore, before)) return undefined;
  return dayBehindIsSettled(payments, before, days) ? paidBefore : undefined;
}

/**
 * Whether the due day behind `day` is settled for the late payment of two that pays `day` — no charge
 * (`couldHaveCharged`), or paid by its own days or by the late payment of two before IT (`paidAheadFromTheDayBefore`),
 * each read with the day after it as the calendar steps them, though a reader that looks ahead asks no day after any
 * (`stillToComeReader`). ⛔ Never `paymentFor`: the catch-up from `day`'s side is the very payment asking, and would
 * pay a third day. 🔴 Its own days alone (8348349): a day the payment of two before it paid early read as unpaid.
 * ⛔ …and never settled from a day before his date: the his-date test is `paidAheadFromTheDayBefore`'s own, so this
 * call asks it too. 🔴 Nothing pinned that (review of 4d6ec2ac): with the test asked only where the catch-up asks for
 * itself, every test passed and one payment of two paid three days — on his ledger copy 2026-10-29 with a -$357.58
 * premium on Venture X started Sep 11 by his date, Jun 11 at the rate, Aug 20 and Oct 20 each -$715.16, November drew
 * Nov 11 "paid early by its payment of Oct 20", Upcoming listed Dec 11 alone, November's forecast left it out and the
 * All tab and the page named Dec 11 next. Pinned in billing-carriers.test.ts and nearer-due-day-catch-up.test.ts — 🔴
 * at first with the day two before his date unpaid, where a run read without his date stops too: read without it in
 * this call, every test passed again (review of d7a5485c), and on the same copy with Jul 11 at the rate as well Oct 20
 * paid those three days once more. Pinned with it paid.
 */
function dayBehindIsSettled(payments: readonly Payment[], day: string, dueDays: DueDays): boolean {
  const behind = dueDays.before(day);
  if (behind === null || !couldHaveCharged(payments, behind, dueDays)) return true;
  const days = withDayAfter(dueDays, behind, day);
  return (
    nearerDaysPayment(payments, behind, days) !== undefined ||
    paidAheadFromTheDayBefore(payments, behind, days) !== undefined
  );
}

/**
 * ⚖️ default built, not asked (2026-10-23): whether a due day is one the bill could have charged — on or after the
 * day its schedule opens (`DueDays.opensOn`); before his date, never — his date IS the schedule (`effectiveSchedule`),
 * whatever posted before it; before detection's anchor, once a payment of it has posted. Before them no reader
 * projects it and no payment was its: the days before his date, or before the ledger's first statement. So no payment
 * of two catches it up, and a late one there pays the day after instead (`paymentFor`). 🔴 At 8348349 one did:
 * started Aug 11 by his date, Aug 20 -$715.16 paid Jul 11, and Sep 11 was owed beside "Aug 20's -$715.16 covered more
 * than one month" — and so with Jun 11 paid before his date, the other month it covered drawn nowhere.
 */
function couldHaveCharged(payments: readonly Payment[], day: string, dueDays: DueDays): boolean {
  if (dueDays.opensOn !== null && compareDates(day, dueDays.opensOn) >= 0) return true;
  if (liesBeforeHisDate(day, dueDays)) return false;
  return payments.some((p) => compareDates(p.postedOn, day) <= 0);
}

/**
 * ⚖️ default built, not asked (2026-10-23): whether a due day lies before HIS date (`DueDays.opensOnHisDate`) — his date
 * IS the schedule (`effectiveSchedule`), whatever posted before it: no day before it is a charge (`couldHaveCharged`),
 * nor one a payment of two catches up from (`paidAheadFromTheDayBefore`, 2026-10-29). ONE test for both.
 */
function liesBeforeHisDate(day: string, dueDays: DueDays): boolean {
  return dueDays.opensOnHisDate && dueDays.opensOn !== null && compareDates(day, dueDays.opensOn) < 0;
}

/** `dueDays` with `next` the due day after `day` — the step a reader that asks no day after still takes here. */
function withDayAfter(dueDays: DueDays, day: string, next: string): DueDays {
  return { ...dueDays, after: (d) => (d === day ? next : dueDays.after(d)) };
}

/** Whether a payment posted more than its own tolerance AFTER a due day — late for it, were it its payment. */
function paysLate(payment: Payment, dueOn: string): boolean {
  return diffDays(dueOn, payment.postedOn) > payment.toleranceDays;
}

/** Whether a payment of a due day is EARLY (`paymentFor`): more than its own tolerance before the day. */
export function paysEarly(payment: Payment, dueOn: string): boolean {
  return diffDays(payment.postedOn, dueOn) > payment.toleranceDays;
}

/** Whether a payment of a due day is ON TIME (`paymentFor`): within its own tolerance either side of the day. */
export function paysOnTime(payment: Payment, dueOn: string): boolean {
  return Math.abs(diffDays(payment.postedOn, dueOn)) <= payment.toleranceDays;
}

/** The payment within its own tolerance of a due day — the nearest, the earlier of two as near — or undefined. */
export function onTimePayment<P extends Payment>(payments: readonly P[], dueOn: string): P | undefined {
  let best: P | undefined;
  for (const p of payments) {
    if (!paysOnTime(p, dueOn)) continue;
    const gap = Math.abs(diffDays(p.postedOn, dueOn));
    const bestGap = best === undefined ? Infinity : Math.abs(diffDays(best.postedOn, dueOn));
    if (gap < bestGap || (gap === bestGap && compareDates(p.postedOn, best!.postedOn) < 0)) best = p;
  }
  return best;
}

/**
 * The payments past `from`'s tolerance and short of `to`'s — each by its own series' days — one a day, oldest first:
 * late for `from`, or early for `to`. ⚖️ Rows of one day are one payment (`occurrencesOf`); the first is named.
 */
function paymentDaysBetween<P extends Payment>(payments: readonly P[], from: string, to: string): P[] {
  const between = payments
    .filter((p) => diffDays(from, p.postedOn) > p.toleranceDays && diffDays(p.postedOn, to) > p.toleranceDays)
    .sort((a, b) => compareDates(a.postedOn, b.postedOn));
  return between.filter((p, i) => i === 0 || between[i - 1]!.postedOn !== p.postedOn);
}

/**
 * ⚖️ What PAYS each series billed inside another: its carrier's payments, each judged by the CARRIER's tolerance —
 * keyed by the carried series' id. Implied by his decision 59 (2026-10-08, recorded by the orchestrator): the
 * utilities' money is inside the rent's payment, so an occurrence of theirs is paid once the rent's payment for that
 * period has posted — the posting that pays the rent's own occurrence, by the rent's own test (`paymentFor`).
 *
 * 🔴 Without it the evidence followed the carrier (`lastSeenOn`) and the settlement did not: on a copy of his ledger
 * with the link set (2026-10-08) September drew Sep 1 "not yet known" beside the rent's Sep 2 $2,291.21 ($2,109.00 +
 * $182.21), and once the rent's account is read past a 1st the rent paid, the runway, the month forecast, /budgets,
 * the bill's page and the calendar's ✕ would all have said its $182.21 "came due and has not posted" — every month.
 *
 * ⚖️ "The same period" is the carrier's own day each day of the carried series PAIRS with (`pairingOf`; default (B),
 * built, not asked, 2026-10-30): the day of theirs that falls due with the carrier's opening day — the one the
 * carrier's payment of that day pays, its day nearest that payment, by his decision 76 (`openingOf`) — pairs with it,
 * and each later day of theirs with the carrier's day the same number of steps on. His rent and what it carries both
 * fall due on the 1st, so on his ledger each day pairs with the rent's own that day. Apart: the rent typed Nov 16 and
 * paid Nov 17 opens the utilities on their Dec 1, the rent's Nov 16, and their Jan 1 is its Dec 16; paid ON Nov 16,
 * their Nov 1 is its Nov 16 and their Dec 1 its Dec 16; no payment of it yet, their day nearest the date, a tie the
 * earlier — the rent typed Nov 2, their Nov 1 is its Nov 2 (default built, not asked, 2026-10-29; reviews of 0ac5d059
 * and ec7fd198). 🔴 At ec7fd198 "the day its payment there pays" was read off the date itself, which a payment a day
 * after it need not pay (review of ec7fd198). 🔴 To 46f19f15 each LATER day of theirs was paid by the rent payment
 * nearest it: paid Nov 16, the tie, then Dec 17, a day past it, the rent paid their Nov 1 late and their Jan 1 early,
 * and on Dec 20 December drew their Dec 1 missed, owed $182.21 beside a rent paid on time (a temp database). Now Dec 17
 * pays the rent's Dec 16 and so their Dec 1, and their Jan 1 comes with the rent's Jan 16. A series carried on a step
 * of its own — an annual item inside a monthly rent — keeps the payment nearest each of its days (`pairingOf`).
 *
 * ⛔ Amounts are not asked: the carrier's payment pays what is billed inside it whatever it adds up to — as a covering
 * posting pays the bill it covers (`overdueForSeries`). Its money is on the carrier's row, counted there, once.
 *
 * Every one of the carrier's postings, as its own are read (`billPaymentsBySeries`). Nothing is asked of a ledger with
 * no link.
 */
function carrierPaymentsBySeries(
  db: Pick<AppDatabase, "select">,
  rows: readonly { id: string; billedWith: BillingCarrier | null }[],
): ReadonlyMap<string, readonly BillPayment[]> {
  const carried = rows.filter((r): r is typeof r & { billedWith: BillingCarrier } => r.billedWith !== null);
  if (carried.length === 0) return new Map();
  const carrierIds = [...new Set(carried.map((r) => r.billedWith.id))];
  const tolerance = new Map(
    db
      .select({ id: recurringSeries.id, toleranceDays: recurringSeries.toleranceDays })
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, carrierIds))
      .all()
      .map((s) => [s.id, s.toleranceDays] as const),
  );
  const byCarrier = postingsBySeries(db, tolerance, true);
  return new Map(carried.map((r) => [r.id, byCarrier.get(r.billedWith.id) ?? []] as const));
}

/**
 * A payment of a bill (`billPaymentsBySeries`): whose it is — its carrier's (§6A 59), or the series' own — and whether
 * it covered more than one charge of the series that posted it, its carrier's for a carried one
 * (`PaymentDays.coveredMore`): a carrier's payment of two pays two days of what it carries, as two of its own, on
 * days opening where the carrier's open (`billDueDaysBySeries`; pinned in nearer-due-day-carried.test.ts).
 * ⚠️ His rent cannot reach it — a known gap (review of b6e11a76): its payments carry the utilities, each above its
 * -$2,109.00 and none at it, so its average names none. On his ledger copy 2026-10-29 with -$4,582.42 added on Oct 20
 * (October's unposted), the rent's page names only what its payments carry, November draws Nov 1 paid early by Oct 20
 * for the rent and the utilities alike, and Oct 1 stays owed for both, $2,109.00 and $182.21 — drawn "?", Wells Fargo
 * read through Sep 24, inside the runway's "A further $3,519.98 came due earlier this month and no statement has
 * covered it yet." — a paid month shown owed, the safe direction. Set to what a month posts (-$2,291.21), it still
 * names none: Jun 16's -$2,434.80 lies above it.
 */
export interface BillPayment extends Payment {
  readonly carried: boolean;
  readonly coveredMore: boolean;
}

/**
 * Every active posting of each series in `tolerance` on a day that PAID a charge (`PaymentDays.paid`), oldest first,
 * each held to its series' tolerance. ⛔ Money back is no payment: a day of it, or one netted to nothing, pays no due
 * day of any grader's.
 */
function postingsBySeries(
  db: Pick<AppDatabase, "select">,
  tolerance: ReadonlyMap<string, number>,
  carried: boolean,
): Map<string, BillPayment[]> {
  const rows = db
    .select({
      seriesId: transactions.recurringSeriesId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), inArray(transactions.recurringSeriesId, [...tolerance.keys()])))
    .orderBy(asc(transactions.postedOn), asc(transactions.id))
    .all();
  const days = paymentDays(db, rows);
  const out = new Map<string, BillPayment[]>();
  for (const row of rows) {
    if (row.seriesId === null) continue;
    const of = days.get(row.seriesId);
    if (of === undefined || !of.paid.has(row.postedOn)) continue;
    const payment = {
      postedOn: row.postedOn,
      toleranceDays: tolerance.get(row.seriesId) ?? 0,
      carried,
      coveredMore: of.coveredMore.has(row.postedOn),
    };
    out.set(row.seriesId, [...(out.get(row.seriesId) ?? []), payment]);
  }
  return out;
}

/** Of a series' days, the ones that paid a charge, and of those the ones whose payment covered more than one. */
interface PaymentDays {
  /**
   * ⚖️ default built, not asked (2026-10-29): the days whose rows netted the way its rate runs (`daysThatPaid`, his
   * decision 75's unit, the day, read onto a bill) — so money back pays no due day, on time, early or late, and a
   * charge with its same-day reversal paid nothing, as the posted average reads it (`occurrencesOf`). 🔴 Every row was
   * a payment to every grader, with no amount or sign asked (review of 4d6ec2ac; his ledger copy 2026-10-29 with a
   * -$357.58 premium due the 11th added on Venture X, Jun to Aug 11 paid, Sep 11 missed, Sep 19 -$715.16): +$357.58
   * back on Sep 28, nearer Oct 11, drew Oct 11 "paid early by its payment of Sep 28" — the credit — on Oct 1 Upcoming
   * listed Nov 11 alone and October's forecast left the premium out, and on Oct 29 nothing was owed, the runway reading
   * "A further $3,519.98 came due earlier this month and no statement has covered it yet." (his own bills). Now Oct 11
   * is still to come on Oct 1 and owed on Oct 29: "A further $3,877.56 came due earlier this month: $357.58 has not
   * posted, and no statement has covered the other $3,519.98 yet." ⚠️ Money back on a day of its own is never taken off
   * the day its payment paid, as his decision 75 reads a payroll returned on a later day: Sep 19 returned in full on
   * Sep 28 still pays Sep 11. Latent: no bill or subscription of his has money back or a day netted to nothing linked.
   */
  readonly paid: ReadonlySet<string>;
  /**
   * ⚖️ default built, not asked (2026-10-23): the days whose payment covered more than one charge — the ones its posted
   * average names (`paidAheadDays`, read as the average reads its rows: per occurrence, every active row, each era at
   * its own rate), so a grader pays a second day only with a payment the page says covered more than one
   * (`paymentFor`'s catch-up) — of the rate era in force now: an earlier era's, held to its own rate, the page names
   * nowhere, its average holding today's era alone (`atTodaysRate`; latent, only his pay has a rate history). Car
   * insurance's Sep 3 alone on his ledger copy 2026-10-23, and 2026-10-29. 🔴 Nothing pinned that a grader reads THIS,
   * not the bare multiple (review of 67b3b79): read as |amount| ≥ 2 × |rate|, every unit test passed, and a what-if
   * FPL on Venture X (the -$58.87 he set; Jul 10 -$14.21, Jul 28 -$56.22, Sep 28 -$125.00) drew Sep 8 paid by Sep 28
   * beside an average naming nothing. nearer-due-day-catch-up.test.ts pins Sep 8 owed, and these days as paidAhead's.
   */
  readonly coveredMore: ReadonlySet<string>;
}

/** Per series, its `PaymentDays` — read off its rows and its own row, one query for all of them. */
function paymentDays(
  db: Pick<AppDatabase, "select">,
  rows: readonly { seriesId: string | null; postedOn: string; amountCents: number }[],
): ReadonlyMap<string, PaymentDays> {
  const bySeries = new Map<string, { postedOn: string; amountCents: number }[]>();
  for (const r of rows) {
    if (r.seriesId === null) continue;
    const list = bySeries.get(r.seriesId);
    if (list) list.push(r);
    else bySeries.set(r.seriesId, [r]);
  }
  if (bySeries.size === 0) return new Map();
  return new Map(
    db
      .select()
      .from(recurringSeries)
      .where(inArray(recurringSeries.id, [...bySeries.keys()]))
      .all()
      .map((s) => {
        const own = bySeries.get(s.id) ?? [];
        const paid = new Set(daysThatPaid(own, seriesAmountCents(s)).map((o) => o.postedOn));
        const coveredMore = readsPerOccurrence(s)
          ? paidAheadDays(occurrencesOf(own), effectiveSeries(s), s.kind)
          : new Set<string>();
        return [s.id, { paid, coveredMore }] as const;
      }),
  );
}

/**
 * Every payment that may PAY each series' due days: its own postings, each judged by its own tolerance, and — billed
 * inside another — its carrier's, each by the carrier's (`carrierPaymentsBySeries`); only those on a day that paid a
 * charge, never money back (`PaymentDays.paid`, ⚖️ default built, not asked, 2026-10-29); each marked when it covered
 * more than one charge (`PaymentDays.coveredMore`, ⚖️ default built, not asked, 2026-10-23). Keyed by series id; read
 * in one pass for all of them. The days they are graded on are `billDueDaysBySeries`'.
 *
 * ⛔ What `paymentFor` is asked over by every grader that says a bill's day is paid or owed: the arrears
 * (`overdueForSeries`), every reader that looks ahead (`stillToComeReader`) and the calendar, which draws its own
 * postings and names a carrier's (`paidWith`, `BillPayment.carried`) — the same list, so the three cannot grade one
 * Oct 1 apart.
 *
 * ⛔ EVERY posting, never a window's: a day's payment may lie as far back as the due day before it (`paymentFor`, ⚖️ his
 * decision 76, 2026-10-14), and a late one asks whether the day after is paid on time (⚖️ default (c), built, not
 * asked) — a cycle either side of any window, for a catch-up's two ahead and back along a run of late payments of two
 * (`dayBehindIsSettled`); whether a day could have been charged is read off the first (`couldHaveCharged`); and
 * whether a payment covered more than one charge is read off all of its series' (`PaymentDays`). Each reader read
 * from its own window's start less the widest grace until then, and FPL's Aug 8, paid early by Jul 28, would read "not
 * posted" to a reader of August from Jul 29 beside a calendar of the year saying "paid".
 *
 * 🔴 The readers that look ahead never asked (review of 50020a2): with the rent paid Sep 30, the calendar drew its Oct
 * 1 paid while the forecast card, the Upcoming tab, the dashboard strip and the rent's page still listed it coming.
 */
export function billPaymentsBySeries(
  db: Pick<AppDatabase, "select">,
  rows: readonly { id: string; toleranceDays: number; billedWith: BillingCarrier | null }[],
): ReadonlyMap<string, readonly BillPayment[]> {
  if (rows.length === 0) return new Map();
  const own = postingsBySeries(db, new Map(rows.map((r) => [r.id, r.toleranceDays] as const)), false);
  const carried = carrierPaymentsBySeries(db, rows);
  return new Map(rows.map((r) => [r.id, [...(own.get(r.id) ?? []), ...(carried.get(r.id) ?? [])]] as const));
}

/**
 * ⛔ The due days every grader of a bill's day reads it by (`paymentFor`), keyed by series id — its schedule's steps
 * (`dueDaysOf`: its days either side, `DueDays.before` and `DueDays.after`, its own — billed inside another, it falls
 * due with its carrier) and where it OPENS (`openingOf`: billed inside another, on the day of its own its CARRIER's
 * opening day falls due with, the one the carrier's payment of it pays — the day every projection of it opens on
 * too). The arrears, the calendar and every reader that looks ahead (`stillToComeReader`) each read these, so none can
 * grade the utilities' Oct 1 apart from the rent's.
 *
 * 🔴 Each grader read a carried series' opening off its own row (review of 4d6ec2ac): a what-if rent at -$2,291.21
 * typed Oct 1, the utilities carried on detection's Oct 1 — his ledger's shape, the rent typed Sep 1 and the utilities
 * detected Sep 1 — Jul 1 and Aug 2 paid, then Sep 10 -$4,582.42: October drew the rent's Oct 1 missed beside "Rent
 * utilities & fees paid … with the rent's payment of Sep 10 (early)", the arrears owed the rent $2,291.21 and not the
 * utilities, the runway read "A further $2,291.21 came due earlier this month and has not posted.", and on Sep 25
 * Upcoming listed the rent's Oct 1 and Nov 1 but the utilities' Nov 1 alone. Now both Oct 1s are coming on Sep 25 and
 * owed on Oct 23: "A further $2,473.42 came due earlier this month and has not posted." And through `couldHaveCharged`,
 * at 32aeb3a9 too: Oct 10's two months, late for his Oct 1 itself, drew the rent's Nov 1 "paid early by Oct 10" beside
 * the utilities' Nov 1 upcoming; now both are paid early. Pinned in nearer-due-day-carried.test.ts. On his ledger
 * copy 2026-10-29 with that what-if added on Wells Fargo (read through Sep 24), on Oct 29 the runway read "A further
 * $5,811.19 came due earlier this month and no statement has covered it yet." beside what it carries drawn paid early
 * by Sep 10; now both Oct 1s are "?" and it reads "A further $5,993.40 …". Latent on his ledger itself: his rent names
 * no payment of two (`BillPayment`'s known gap), and nothing else is billed inside another.
 *
 * ⛔ The carrier's DAY as well as whether it is his. 🔴 Every pin put the rent and what it carries on one date (review
 * of d7a5485c), so the builder keeping the carried series' own day, taking only "his" from the rent, passed every test:
 * the rent typed Oct 1, the utilities still on detection's Sep 1 — his ledger's shape should he retype only the rent —
 * Sep 10 paid their Oct 1 early beside the rent's "?", and the runway on that copy read "A further $5,811.19 …" again.
 * Pinned with the two apart (nearer-due-day-carried.test.ts, "…still on detection's Sep 1").
 *
 * ⚖️ …and, on the carrier's own step, the carrier's day each of its days PAIRS with (`pairingOf`, `DueDays.pairedWith`;
 * default (B), built, not asked, 2026-10-30): what pays the rent's Dec 16 pays what the rent carries on its Dec 1.
 */
export function billDueDaysBySeries(
  rows: readonly (SeriesOverrides & { id: string } & CarriedBy)[],
): ReadonlyMap<string, DueDays> {
  return new Map(rows.map((r) => [r.id, dueDaysOf(effectiveSchedule(r), openingOf(r), pairingOf(r))] as const));
}

/**
 * ⚖️ Where a bill's schedule OPENS (`DueDays.opensOn`), and whether that day is his — ONE answer for every grader of its
 * days (`billDueDaysBySeries`) and every projection of it (`toProjectable`, `ProjectableSeries.opensOn`): no reader
 * projects a due day of it before it, and every day from it on is a charge (`couldHaveCharged`). Billed on its own,
 * its own (`ownOpening`). Billed inside another — default built, not asked (2026-10-29), read off §6A 59's "by the
 * rent's own test": it is paid by its carrier's payments (`carrierPaymentsBySeries`), so whether a day of it was a
 * charge is the carrier's question —
 *  - the carrier's date HE typed: a day before it is no charge of the rent's, whatever posted before it, nor of what
 *    the rent carries — so none is projected either: its projection opens there when its own date is earlier;
 *  - the carrier's date DETECTION's: a day before it is a charge once a payment has posted, so it says no less than
 *    the carrier's own reading — what it carries opens at the earlier of that date and its own, and its own still
 *    opens its projection, every day of which is a charge.
 * A date he typed on what the rent carries alone opens nothing apart from the rent (pinned, "…HIS date on what it
 * carries alone").
 *
 * 🔴 At 68c837ce what the rent carries projected from its own date while it opened at the rent's (review of
 * 68c837ce): the rent typed Oct 1, the utilities still on detection's Sep 1 — his ledger's shape should he retype only
 * the rent — their Sep 1 was projected, so graded as a charge, and no charge to the catch-up: with Jul 1 and Aug 2 at
 * the rate and Oct 2 -$4,582.42 (two months, on time for his Oct 1), September drew their Sep 1 "missed" and the
 * arrears owed $182.21 beside the rent's page naming Oct 2 as covering more than one month. On his ledger copy
 * 2026-10-29 with that what-if added on Wells Fargo (read through Oct 26), the runway on Sep 25 read "A further $347.08
 * came due earlier this month: $182.21 has not posted, and no statement has covered the other $164.87 yet."; now
 * September draws nothing of theirs and it reads "A further $164.87 …", his own bills, as with the rent on
 * detection's Oct 1. Pinned in nearer-due-day-carried.test.ts ("…on time for his Oct 1"), with the review's two
 * controls, and on every reader that looks ahead and the first-posting rule (recurring-first-posting.test.ts).
 *
 * ⚖️ …and the carrier's opening is read as a day of ITS OWN: the one the carrier's PAYMENT of that day pays
 * (`BillingCarrier.opensPaidBy`, read by the carrier's own test, `paymentFor`, his date included) — its due day nearest
 * that payment, as his decision 76 reads a payment between two due days, stepped back as many of its own days as the
 * payment's own day lies past the opening day (a payment of two that caught the opening day up from the next: the day
 * behind the one nearest it) — and only while no payment has paid it, its day nearest the carrier's date, a tie the
 * earlier: the day a payment ON that date would pay (default built, not asked, 2026-10-29; ⛔ the safe side of the tie:
 * the earlier opens more, owed with the carrier once read past). So the payment that pays the carrier's first period
 * pays its first charge, whatever day of the month each falls on, and where it opens is always one of its own days.
 * 🔴 At 0ac5d059 the floor cut by DATE, not by period (review of 0ac5d059): his rent retyped Nov 2,
 * the day it posts (Sep 2, Oct 2), dropped the utilities' Nov 1 — the charge his Nov 2 carries — off every surface, on
 * the same copy: on Oct 29 Upcoming listed their Dec 1 first beside the rent's Nov 2, November's forecast lost "Rent
 * utilities & fees -$182.21 (monthly), next Nov 1" and its spend moved from -$10,835.73 to -$10,653.52, their page and
 * the All tab named Dec 1 and their year read ~$2,004.31 for ~$2,186.52; on Nov 20 the runway read "A further $2,991.65
 * came due earlier this month and no statement has covered it yet." for $3,173.86, November drawing no Nov 1 of theirs.
 * And through `liesBeforeHisDate`, already at ae29cda4 — on a temp database, the what-if rent at −$2,291.21, whose
 * average names a payment of two (pinned in nearer-due-day-carried.test.ts): November missed, Dec 10 two months drew
 * their Jan 1 "paid early by Dec 10" beside the rent's Jan 2 still to come, and on Dec 20 Upcoming and the All tab
 * named their Feb 1 next. Now their Nov 1 opens them: every figure above reads as at ae29cda4 again, and Dec 10 pays
 * their Nov 1 and Dec 1 as it pays the rent's Nov 2 and Dec 2, their Jan 1 still to come with its Jan 2. ⚠️ Not on
 * his copy (review of 46f19f15, L60): his rent at −$2,109.00 names no payment of two (`BillPayment`'s known gap), so
 * there Dec 10's −$4,582.42 pays the rent's Dec 2 and their Dec 1, late, and November draws both Nov 2 missed — on Dec
 * 20 Upcoming names their Jan 1 by the rent's Jan 2 (his ledger copy 2026-11-04, the rent retyped Nov 2). ⛔ The
 * rent's date BEFORE their own reads the same way: typed Sep 1 beside their own Nov 1 (a Save of their date editor,
 * which opens on Nov 1, types it), they open on their own Sep 1, so a payment of two late for their Nov 1 catches up
 * their Oct 1 and pays no Dec 1 early. 🔴 Nothing pinned that branch (review of 0ac5d059): read as the LATER of the two
 * dates, every test passed. Pinned in nearer-due-day-carried.test.ts ("…the rent typed Nov 2", "…the rent typed Sep
 * 1") and on the day itself in billing-carriers.test.ts.
 *
 * 🔴 At ec7fd198 that day was read off the carrier's DATE even once a payment of it had posted (review of ec7fd198):
 * the rent's payments post a day or more after its date (Sep 2, Oct 2, Jul 8, Aug 4 on his ledger), and one a day or
 * two past a date on the 15th or 16th lies nearer the NEXT 1st, so it paid that day early and nothing paid the one the
 * date opened. On a temp database — a rent at -$2,291.21 typed Nov 16 (or Nov 15, no tie), the utilities on
 * detection's Sep 1, Jul 1 / Aug 2 / Sep 2 / Oct 2 and Nov 17 at the rate, read through Nov 19 — on Nov 20 November
 * drew their Nov 1 missed, the arrears owed $182.21 and the runway read "A further $182.21 came due earlier this month
 * and has not posted." beside a rent paid in full, December drawing their Dec 1 paid early by Nov 17: a month owed for
 * good. On his ledger copy 2026-10-29 with only his rent retyped Nov 16 and -$2,291.21 on Nov 17 and Dec 17 on Wells
 * Fargo, read through Dec 26, on Nov 20 the runway read "A further $1,064.86 came due earlier this month: $877.25 has
 * not posted, and no statement has covered the other $187.61 yet.", November's forecast added "Rent utilities & fees
 * -$182.21 … came due Nov 1 and has not posted" (spend -$3,937.56), their page showed Nov 1 already due, and November
 * kept their ✕ on Dec 5 and Dec 27 beside the rent paid Nov 17. Now Nov 17 opens them on Dec 1, which it pays early:
 * on Nov 20 the runway reads "A further $882.65 …: $695.04 has not posted, …", November's spend -$3,755.35, and nothing
 * of theirs is drawn or owed in November — 0ac5d059's reading of this shape; paid ON Nov 16, the payment pays their
 * Nov 1, late, and opens them there; and November missed, Dec 20's two months — the rent's Nov 16 caught up from its
 * Dec 16 — open them on Dec 1, the day behind their Jan 1 nearest it, so Dec 20 pays their Dec 1 and Jan 1 as it pays
 * the rent's Nov 16 and Dec 16 (read off its nearest day alone, their Dec 1 — the charge the rent's Nov 16 carries —
 * would be drawn, owed and listed nowhere). Pinned in nearer-due-day-carried.test.ts ("…paid Nov 17", "…paid ON Nov
 * 16", "…not yet paid", "…Oct 20's two months before his Nov 16", "…Dec 20's two months") and on the day in
 * billing-carriers.test.ts.
 *
 * ⚖️ …and from that day on, ONE pairing (`pairingOf`; default (B), built, not asked, 2026-10-30): the day of its own
 * that falls due with the carrier's opening day pairs with that day, and each later day of its own with the carrier's
 * day the same number of steps on. Check it against a calendar: the rent typed Nov 16 and paid Nov 16, the utilities on
 * the 1st — their Nov 1 is the rent's Nov 16, their Dec 1 its Dec 16, their Jan 1 its Jan 16 — so whatever pays the
 * rent's Dec 16 (Dec 17, on time) pays their Dec 1, and nothing else does, and their Jan 1 still comes with the rent's
 * Jan 16. A day of theirs falls due on the later of its own day and the rent's day it pairs with (`fallsDueOn`): owed,
 * or drawn missed, only once that rent day is, and until then still to come — and dated by that day on every reader
 * (`SeriesOccurrence.date`). 🔴 Until then the tie's day read on its own grace (46f19f15's known gap): the rent typed
 * Nov 16, nothing of November posted, on Nov 10 (read through Nov 9) November drew their Nov 1 missed and the runway
 * read "A further $182.21 came due earlier this month and has not posted." six days before the rent's Nov 16 came.
 * Now their Nov 1 is still to come with it — Upcoming, November's forecast, /budgets' tail, their page and the All tab
 * hold it, and name it Nov 16 — and owed with it from Nov 17. On a step of its own (an annual item inside a monthly
 * rent) the payment nearest each of its days pays it, as before (`pairingOf`).
 *
 * ⚠️ The cost, the safe way: a date he types on the rent past what it carries takes their earlier periods off every
 * surface, paid ones too. On the same copy with only his rent retyped Nov 1 (or Nov 2), September and October no longer
 * draw "Rent utilities & fees paid … with the rent's payment of Sep 2" (and Oct 2) — the rent's own rows still stand
 * there — and no figure moves: the runway reads "A further $533.73 came due earlier this month and no statement has
 * covered it yet." either way. Latent on his ledger itself: the rent is typed Sep 1 and the utilities detected Sep 1,
 * one day.
 */
export function openingOf(
  s: SeriesOverrides & { billedWith: Pick<BillingCarrier, "opensOn" | "opensOnHisDate" | "opensPaidBy"> | null },
): ScheduleOpening {
  const own = ownOpening(s);
  const carrier = s.billedWith;
  if (carrier === null) return own;
  // the carrier's opening as the day of its own that falls due with it — that day itself with no schedule of its own
  const withIt =
    carrier.opensOn === null
      ? null
      : (dayFallingDueWith(effectiveSchedule(s), carrier.opensOn, carrier.opensPaidBy) ?? carrier.opensOn);
  if (carrier.opensOnHisDate) return { opensOn: withIt, opensOnHisDate: true };
  return { opensOn: earlierOf(own.opensOn, withIt), opensOnHisDate: false };
}

/**
 * The due day of a series billed inside another that falls due with its carrier's opening day (`openingOf`): the one
 * the carrier's payment of that day pays (`BillingCarrier.opensPaidBy`) — its due day nearest that payment, as his
 * decision 76 reads a payment between two, stepped back as many of its own due days as the payment's own day lies past
 * the opening day (a payment of two that caught it up from the day after: the day behind) — else, nothing paid yet,
 * its due day nearest the opening day itself, a tie the earlier. Null with no schedule of its own.
 */
function dayFallingDueWith(
  schedule: EffectiveSchedule,
  carrierOpensOn: string,
  paidBy: OpeningPayment | null,
): string | null {
  if (paidBy === null) return dueDayNearest(schedule, carrierOpensOn);
  const nearest = dueDayNearest(schedule, paidBy.postedOn);
  return nearest === null ? null : dueDayStepped(schedule, nearest, -paidBy.dueDaysPast);
}

/** The earlier of two days, either of them absent. */
function earlierOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareDates(a, b) <= 0 ? a : b;
}

/**
 * ⚖️ default (B), built, not asked (2026-10-30) — how each day of a series billed inside another PAIRS with its
 * carrier's own day of that period: ONE pairing for every grader of its days (`billDueDaysBySeries`, `paymentFor`) and
 * every projection of them (`toProjectable`, `fallsDueOn`). The day of its own that falls due with the carrier's
 * opening day (`dayFallingDueWith`, the one `openingOf` opens it on when the carrier's date is his) pairs with that
 * opening day; each later day of its own pairs with the carrier's day the same number of steps on, and each earlier
 * one — a day of its own before it on detection's date — the same number back. Against a calendar: the rent typed
 * Nov 16 and paid Nov 16, the utilities on the 1st — their Nov 1 is the rent's Nov 16, their Dec 1 its Dec 16, their
 * Jan 1 its Jan 16; paid Nov 17 instead, which opens them on their Dec 1, their Dec 1 is the rent's Nov 16 and their
 * Jan 1 its Dec 16. On his ledger the rent is typed Sep 1 and the utilities detected Sep 1: each 1st is the rent's own.
 *
 * Null billed on its own, with no schedule either side, or on a STEP of its own — a cadence, or a detected interval,
 * that steps apart from the carrier's (`stepPlan`): an annual item carried inside a monthly rent. Then the payment
 * nearest each of its days pays it, as before (A) — on the safe side: no pairing hands next year's day of it to next
 * month's rent payment (pinned in nearer-due-day-paired.test.ts, "…on the rent's step only").
 */
export function pairingOf(s: SeriesOverrides & CarriedBy): CarrierPairing | null {
  const carrier = s.billedWith;
  if (carrier === null || carrier.opensOn === null) return null;
  const own = effectiveSchedule(s);
  if (!stepsAlike(own, carrier.schedule)) return null;
  const pairsOn = dayFallingDueWith(own, carrier.opensOn, carrier.opensPaidBy);
  if (pairsOn === null) return null;
  const carrierOpensOn = carrier.opensOn;
  return {
    // the carrier billed on its own — one hop: the link's one writer refuses a carrier billed with another
    carrierDays: dueDaysOf(carrier.schedule, { opensOn: carrierOpensOn, opensOnHisDate: carrier.opensOnHisDate }, null),
    carrierDayOf: (day) => dueDayStepped(carrier.schedule, carrierOpensOn, dueDaysApart(own, pairsOn, day)),
  };
}

/** Whether two schedules step alike — the same calendar months a step, or the same days (`stepPlan`). */
function stepsAlike(a: CarrierSchedule, b: CarrierSchedule): boolean {
  const ours = stepPlan(a.cadence, a.intervalDaysAvg, a.anchorDay);
  const theirs = stepPlan(b.cadence, b.intervalDaysAvg, b.anchorDay);
  if (ours.calendarMonths !== theirs.calendarMonths) return false;
  return ours.calendarMonths ? ours.stepMonths === theirs.stepMonths : ours.stepDays === theirs.stepDays;
}

/**
 * ⚖️ (B) The day a due day FALLS DUE on: the later of that day and its carrier's day it pairs with (`pairingOf`) —
 * that day itself billed on its own, or on a step of its own. A day of what the rent carries is never owed, nor drawn
 * missed, before the rent's day it pairs with is, nor before its own day; until then it is still to come (default
 * built, not asked, 2026-10-30). ONE reading for every window a reader holds a day in — the arrears' month, Upcoming's
 * days, a month's forecast, /budgets' tail, the page's list and its next date (`projectOccurrences`,
 * `rollForwardNextExpected`) — and for the calendar's verdict on the day (`settledVerdict`). ⚖️ …and the day each of
 * those names or draws it on: the occurrence's `date` (`SeriesOccurrence.date`; its own day is `ownDate`, what a
 * grader asks paid) and the All tab's Next (`nextStillToCome`). 🔴 Held by it but dated by its own day (review of
 * aa05a56d), a reader that re-read the date read another: the category forecast counted their Oct 25 in no month, the
 * dashboard counted their Nov 1 due by a Nov 12 paycheck before the rent's Nov 16, and "next Nov 1" named a day past.
 */
export function fallsDueOn(pairedWith: CarrierPairing | null | undefined, day: string): string {
  const carrierOn = pairedWith?.carrierDayOf(day) ?? null;
  return carrierOn !== null && compareDates(carrierOn, day) > 0 ? carrierOn : day;
}
