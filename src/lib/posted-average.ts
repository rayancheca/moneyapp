import type { Cadence, SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import { carriesPhrase } from "./billed-with";
import { compareDates } from "./dates";
import { formatDayShortIn } from "./format-date";
import { formatCents, roundToCents } from "./money";
import { onPayDay, spreadSampleCents, type PaydayReading, type ReadableRow } from "./per-payday";
import { currentRatePeriod, ratePeriodOf, type RateSchedule } from "./series-kind";

/**
 * WHAT A SERIES' POSTINGS AVERAGED, AND THEIR SPREAD — the figure "posted avg" names and the ± it carries. ONE reading
 * for every surface that prints it: the series page's Per charge (`seriesDetail`), the All tab's "posted avg"
 * (`listSeries`) and the amount popover's "The ledger's own average of what actually posted" (provenance). Each feeds
 * it through `services/posted-average`, so the three can only name one figure.
 *
 * ⚖️ A pay series read per payday (`readsPerPayday`) averages what a PAYDAY paid, over the rate era in force now
 * (owner decisions 2026-10-08, §6A 55): each row as the calendar holds it to the expectation (`spreadSampleCents` — a
 * lump as one week; never a part of a payday's pay, nor money that paid no payday), and only the rows held to the
 * CURRENT rate (`PaydayReading.ratePeriod`), because a dated rate change is not a change in what a week pays.
 *
 * A series with a schedule of charges (`readsPerOccurrence`) averages what each OCCURRENCE was paid: the rows of one
 * payment are one sample. ⚖️ …and only the payments made at the rate in force now (owner decision 2026-10-12, §6A 63 —
 * `atTodaysRate`), as his pay is held to its current rate: a rent increase recorded with the old rate's dates leaves
 * the old rent out of the average, and with no payment yet at the new rate there is NO average. Any other series
 * averages its rows as they posted.
 *
 * 🔴 Measured on a copy of his ledger 2026-10-08: the raw mean of his four deposits — Jun 4's $1,047.00 cash week,
 * Jun 5's $400.00, the Sep 23 lump of $4,567.68 and Sep 24's $1,141.92 — is $1,789.15, an amount no payday ever paid.
 * His page printed "posted avg +$1,789.15 ± 1881.46" under "+$1,141.92", the All tab "posted avg +$1,789.15", and the
 * popover "⚠️ The ledger's own average of what actually posted is $1,789.15, which is not what you set."
 *
 * 🔴 …and the same of a bill, 2026-10-12: the rent's page and the All tab printed "posted avg -$1,849.76 ± $583.58"
 * under "-$2,109.00", though every month he paid MORE — Jun 16's one payment, posted by his card as -$1,100.00
 * and -$1,334.80, counted as two charges. Per payment it is -$2,312.21 ± $85.27.
 */
export interface PostedAverage {
  /** the samples' mean, to the cent — null with no sample */
  avgCents: number | null;
  /** their SAMPLE standard deviation — null under two samples: with one there is nothing to vary */
  stddevCents: number | null;
}

/**
 * How a series' rows become samples — `services/posted-average` picks it: per payday (`readsPerPayday`, with the
 * series' per-payday reading, `paydayReadings`), per occurrence (`readsPerOccurrence`), or each row as it posted.
 */
export type PostedReading =
  | { readonly per: "payday"; readonly readings: ReadonlyMap<string, PaydayReading> }
  | { readonly per: "occurrence" }
  | { readonly per: "row" };

/**
 * Whether a series' rows are read per occurrence: a series with a schedule of charges — every kind but money in,
 * live or ended — and not one he dismissed.
 *
 * ⛔ Money in keeps the pay rule (§6A 55, untouched): per payday while it is paid (`readsPerPayday`), as it posted once
 * it ends. ⛔ A dismissed series has no occurrence to pay — he said it is not recurring — and its rows are purchases:
 * measured on a copy of his ledger 2026-10-12, CC Vending's three of Nov 11, 2024 ($2.40, $2.60, $2.65).
 */
export function readsPerOccurrence(s: { kind: SeriesKind; status: SeriesStatus }): boolean {
  return s.kind !== "income" && s.status !== "dismissed";
}

/** The reading, from a series' active rows (`PostedReading`), with the rate in force on `today`. */
export function postedAverage(
  rows: readonly ReadableRow[],
  reading: PostedReading,
  schedule: Pick<RateSchedule, "amountHistory">,
  today: string,
): PostedAverage {
  const samples =
    reading.per === "payday"
      ? perPaydayEvidence(rows, reading.readings, schedule, today).samples.map((s) => s.cents)
      : reading.per === "occurrence"
        ? atTodaysRate(occurrencesOf(rows), schedule, today).map((o) => o.amountCents)
        : rows.map((r) => r.amountCents);
  if (samples.length === 0) return { avgCents: null, stddevCents: null };
  const mean = samples.reduce((a, c) => a + c, 0) / samples.length;
  // ⚖️ half away from zero, as every money figure (`roundToCents`): 🔴 `Math.round` printed the rent's -$2,312.205 as
  // "-$2,312.20" (posted-average review, 2026-10-12)
  const avgCents = roundToCents(mean);
  if (samples.length < 2) return { avgCents, stddevCents: null };
  const variance = samples.reduce((a, c) => a + (c - mean) ** 2, 0) / (samples.length - 1);
  return { avgCents, stddevCents: Math.round(Math.sqrt(variance)) };
}

/**
 * One sample of a pay series read per payday: a deposit DAY whose money paid a payday on its own, read as the calendar
 * holds it to the expectation (`spreadSampleCents`) — a week, a lump at what each of its paydays was paid, or a day's
 * deposits read together (`PaydayReading.perPayday`, "the unit is the day").
 */
export interface PaydaySample {
  /** the deposit's day */
  postedOn: string;
  /** what it paid per payday — the posted average's sample */
  cents: number;
  /** the paydays its money paid on its own: 1 for a week */
  paydays: number;
  /** what its day's rows came to, net (decision 75) — the row itself when it stood alone */
  dayCents: number;
  /** the deposits that made it: 1 for a deposit alone on its day */
  deposits: number;
  /** the rows of money out netted into it — a payroll partly returned the same day: 0 for a day of deposits alone */
  returns: number;
}

/**
 * ⚖️ What a pay series' posted average is OF, and what it leaves out (§6A 55) — ONE reading for the average
 * (`postedAverage`) and the amount popover's words (`SeriesPostedAverage.perPayday`), so the words cannot count or
 * range a row the average leaves out. 🔴 They described the rows as they posted: his pay's popover read "Its 4 tagged
 * postings since Jun 4, 2026 were 4 different amounts, from $400.00 to $4,567.68 — so any single figure for it is an
 * average, not a repeat." beside an average of $1,141.92 that every payday at the rate in force paid exactly (a copy of
 * his ledger, 2026-10-12).
 */
export interface PerPaydayEvidence {
  /** what each deposit day of the rate era in force now paid per payday, oldest first — what the average averages */
  samples: readonly PaydaySample[];
  /** tagged rows that paid paydays of an EARLIER rate era — each held to its own time's rate, and not averaged */
  earlier: number;
  /**
   * The rate era of each of those rows (`ratePeriodOf`'s index), oldest first: which earlier rate each was held to,
   * so the words can name every rate when there were several. 🔴 Counted alone, deposits at $1,000.00 and $1,047.00
   * read "at an earlier rate" (review of the pay-and-avg branch).
   */
  earlierEras: readonly number[];
  /**
   * tagged rows that paid paydays of a LATER rate era — a raise recorded ahead, whose first week's pay landed while
   * the old rate is in force — held to that rate, and not averaged until it is in force
   */
  later: number;
  /**
   * tagged rows whose money paid no payday of its own: toward none at all, of any era — held to no rate, so of none
   * (`PaydayReading.expectedCents`) — or part of one of the era in force now
   */
  noPaydayOfTheirOwn: number;
  /**
   * tagged rows of money out, on a day that did not net to $0.00 — no deposit, so no payday's pay, of any era — and
   * not netted into a day that is a sample (`PaydaySample.returns`, decision 75)
   */
  moneyOut: number;
  /**
   * The days whose tagged rows net to $0.00, oldest first (`nettedToNothing`, the rule a bill's payments are read by):
   * a payroll and its same-day return paid nothing, and none of their rows is counted above — named instead, so the
   * words still account for every row.
   */
  netted: readonly Occurrence[];
}

/**
 * The samples of the rate era in force now (`currentRatePeriod` — today's), and the rows left out. ⚖️ One "in force
 * now" for pay and bills (§6A 55, §6A 63): a raise recorded before its first day is not in force until then, and the
 * weeks paid at the rate that is still average.
 *
 * ⛔ Money toward no payday first: it answers no week, so no era's rate is what it is held to — and the words call it
 * what the calendar and the Amount history draw it, "toward no payday". 🔴 Read by its era first, his Jun 5 $400.00
 * was "at an earlier rate" in the popover (a copy of his ledger, 2026-10-12), and "paid no payday on its own" with
 * no history written. ⛔ …then an era's DIRECTION: a deposit pays the era of the payday it anchors to, which can
 * begin after today (`depositEra`). 🔴 Every era but today's was `earlier`, and a Wednesday's pay for a raise
 * beginning Thursday read "before Aug 27, 2026 … at an earlier rate" (review of 78c21ee).
 *
 * ⛔ And before any of it, a day whose rows net to $0.00 paid nothing (`nettedToNothing` — ONE rule, a bill's and his
 * pay's), and money out is no deposit (`moneyOut`): neither is a sample, nor any era's. 🔴 A payroll returned the same
 * day was a "-$1,141.92" deposit: two weeks at $1,141.92 averaged $380.64 on the page, the All tab and the popover,
 * "from -$1,141.92 to $1,141.92" (review of 6c59cdb, hypothetical: no money out is linked to his pay). ⚖️ Money out
 * on a day that BANKED is part of that day's money, though (decision 75, `daysThatBanked`): a sample is its day's net,
 * and counts the money out in it (`PaydaySample.returns`). ⛔ Its pay days' rows only (`onPayDay`): a row linked to
 * the pay off them — his spending, or money on a day no row of it is filed as his pay — is in no day's money
 * (settlement never read it), and is named as the money it is: a debit `moneyOut`, a credit money toward no payday
 * (`noPaydayOfTheirOwn`).
 */
export function perPaydayEvidence(
  rows: readonly ReadableRow[],
  readings: ReadonlyMap<string, PaydayReading>,
  schedule: Pick<RateSchedule, "amountHistory">,
  today: string,
): PerPaydayEvidence {
  const now = currentRatePeriod(schedule, today);
  const netted = nettedToNothing(rows.filter(onPayDay));
  const paidNothing = new Set(netted.map((o) => o.postedOn));
  const counted = rows.filter((r) => !onPayDay(r) || !paidNothing.has(r.postedOn));
  /*
   * A day's rows, read together where settlement saw them as one (`PerPayday.deposits`) — by their NET, money out too
   * (`PerPayday.returns`, decision 75): a day that banked is what settlement spent (`daysThatBanked`).
   */
  const days = new Map<string, { cents: number; deposits: number; returns: number }>();
  for (const r of counted.filter(onPayDay)) {
    const day = days.get(r.postedOn) ?? { cents: 0, deposits: 0, returns: 0 };
    const isDeposit = r.amountCents > 0;
    days.set(r.postedOn, {
      cents: day.cents + r.amountCents,
      deposits: day.deposits + (isDeposit ? 1 : 0),
      returns: day.returns + (isDeposit ? 0 : 1),
    });
  }
  const samples: PaydaySample[] = [];
  const earlierEras: number[] = [];
  let later = 0;
  for (const r of counted) {
    const reading = readings.get(r.id);
    // money that paid no payday is no era's (`noPaydayOfTheirOwn`, below)
    if (reading?.towardNoPayday === true) continue;
    // …and money out is no deposit: no payday's pay, of any era — counted below, in its day's sample or on its own
    if (r.amountCents <= 0) continue;
    // a row with no reading is held on its own day, as `expectedCentsOf` holds it
    const era = reading?.ratePeriod ?? ratePeriodOf(schedule, r.postedOn);
    if (era < now) earlierEras.push(era);
    if (era > now) later += 1;
    if (era !== now) continue;
    const cents = spreadSampleCents(r.amountCents, reading);
    if (cents === null) continue;
    const per = reading?.perPayday ?? null;
    // a figure read per payday is its DAY's (`dayPerPayday`); a row read as the one amount it is stood alone
    const day = per === null ? { cents: r.amountCents, deposits: 1, returns: 0 } : days.get(r.postedOn)!;
    const { deposits, returns } = day;
    samples.push({ postedOn: r.postedOn, cents, paydays: per?.paydays ?? 1, dayCents: day.cents, deposits, returns });
  }
  /*
   * ⚖️ Money out netted into a day that paid a payday is in that day's sample (`PaydaySample.returns`): the sample is
   * the day's net, so it is counted there, never "of money out, paying no payday" beside it. Any other is money out.
   */
  const returned = samples.reduce((n, s) => n + s.returns, 0);
  const moneyOut = counted.filter((r) => r.amountCents <= 0).length - returned;
  const sampled = samples.reduce((n, s) => n + s.deposits + s.returns, 0);
  const earlier = earlierEras.length;
  return {
    samples: samples.sort((a, b) => compareDates(a.postedOn, b.postedOn)),
    earlier,
    earlierEras: earlierEras.sort((a, b) => a - b),
    later,
    noPaydayOfTheirOwn: counted.length - earlier - later - moneyOut - sampled,
    moneyOut,
    netted,
  };
}

/** One payment of a series read per occurrence: its day, what it paid, and how many rows the bank posted it as. */
export interface Occurrence {
  postedOn: string;
  amountCents: number;
  /** the rows of that day — 1 for a payment posted whole; his card posted Jun 16's rent as 2 */
  postings: number;
}

/**
 * What each payment paid, oldest first: a day's rows summed — one payment the bank posted as several, as his card
 * posted Jun 16's rent as two. A row of another day is another payment, however near. The payments of the posted
 * average (`readsPerOccurrence`) — those at the rate in force now, `atTodaysRate` — and, every one of them, what the
 * series page's Amount history draws (`SeriesPostedAverage.everyOccurrence`), so neither the average, the popover's
 * sentence nor the history can count a payment as two.
 *
 * ⚠️ Not the series' tolerance either side, the reach the calendar gives a payment of a due day (`paymentFor`): the
 * calendar pays a due day with ONE posting, and walks due days only from the anchor forward — the rent's from Sep 1, so
 * no due day of the calendar's is paid by Jun 16 at all. 🔴 Read as rows within the tolerance of a payment's first,
 * separate charges became one: on the e2e fixture after "Detect now", Chipotle's visits of Sep 19 and 21, 2025 (and
 * four more pairs) and Sweetgreen's lunches of Jan 20, 21 and 22, 2026 — each one sample of two or three meals.
 *
 * ⛔ A day whose rows net to $0.00 paid nothing — a charge and its same-day reversal — and is no payment: no sample, no
 * bar, none the popover counts (`nettedToNothing` names it instead). 🔴 Summed as a day it was a payment of $0.00: his
 * rent with a hypothetical -$50.00 charged and reversed on Jul 20 read "posted avg -$1,849.76 ± $1,036.68" over five.
 */
export function occurrencesOf(rows: readonly Pick<ReadableRow, "postedOn" | "amountCents">[]): Occurrence[] {
  return daysOf(rows).filter((o) => o.amountCents !== 0);
}

/**
 * The days whose rows net to $0.00, oldest first — a charge and its same-day reversal: tagged postings that paid no
 * payment (`occurrencesOf` leaves them out), named where the rows are counted so they still add up. ⛔ ONE rule: a pay
 * series' days too — a payroll and its same-day return paid no payday (`PerPaydayEvidence.netted`). None on his
 * ledger (a copy of it, 2026-10-12).
 */
export function nettedToNothing(rows: readonly Pick<ReadableRow, "postedOn" | "amountCents">[]): Occurrence[] {
  return daysOf(rows).filter((o) => o.amountCents === 0);
}

/**
 * The days whose rows BANKED money, oldest first: a day's rows netted (`occurrencesOf`), where the net is money in —
 * the deposits a pay series' settlement walks (`settlePaydaysBackwards`) and the reach of its walk back
 * (`walkBackBound`), Earned vs banked's last pay to arrive and its payday today (`cashEarnings`), and every figure
 * that says Income (`hisIncomeRows`).
 *
 * ⚖️ His decision 75 (2026-10-13): a day whose pay-linked rows net to $0.00 — a deposit and its same-day return —
 * banked nothing, and pays no payday: the rule this module's average already read a pay series' days by
 * (`nettedToNothing`), now every reader's. A day netting below $0.00 — money out alone, or a return larger than the
 * day's pay — banks nothing either; a partial return the same day banked its net. 🔴 Settlement read money IN row by
 * row, so a payroll returned the same day still paid its payday — the calendar drew it paid and the income card
 * counted it the last pay to arrive, beside an average that said the day paid nothing (hypothetical: no money out is
 * linked to his pay, a copy of his ledger 2026-10-13).
 *
 * ⛔ THE UNIT IS THE DAY, as per payday it always was (`lib/per-payday`): two deposits on one day are one day's money.
 */
export function daysThatBanked(rows: readonly Pick<ReadableRow, "postedOn" | "amountCents">[]): Occurrence[] {
  return occurrencesOf(rows).filter((o) => o.amountCents > 0);
}

/**
 * The days whose rows net BELOW $0.00, oldest first — money going back out on a day of its own: a payroll returned on a
 * later day, a clawback. `daysThatBanked`' other side, so every day that is not a same-day nothing is one or the other.
 * ⚖️ His decision 75: such a day banked nothing and pays no payday — the deposit's own day pays as it always has — so
 * it is named where a window's money is counted (`payShortfall`'s `wentBackOut`), never taken off a paid payday.
 */
export function daysThatWentBackOut(rows: readonly Pick<ReadableRow, "postedOn" | "amountCents">[]): Occurrence[] {
  return occurrencesOf(rows).filter((o) => o.amountCents < 0);
}

/** A day's rows summed, one per day, oldest first — what `occurrencesOf` and `nettedToNothing` divide between them. */
function daysOf(rows: readonly Pick<ReadableRow, "postedOn" | "amountCents">[]): Occurrence[] {
  const byDay = new Map<string, Occurrence>();
  for (const r of rows) {
    const o = byDay.get(r.postedOn);
    byDay.set(
      r.postedOn,
      o === undefined
        ? { postedOn: r.postedOn, amountCents: r.amountCents, postings: 1 }
        : { ...o, amountCents: o.amountCents + r.amountCents, postings: o.postings + 1 },
    );
  }
  return [...byDay.values()].sort((a, b) => compareDates(a.postedOn, b.postedOn));
}

/**
 * ⚖️ The payments a series read per occurrence averages: those whose day falls in the rate era in force now
 * (`ratePeriodOf` … `currentRatePeriod`, on `today`) — owner decision 2026-10-12 (§6A 63), the pay rule's era (§6A 55)
 * on a bill: if a rent increase is recorded with the old rate's dates, its posted avg is what he has paid at the new
 * rate — and until the new rate's first day, at the rate still in force. Every payment of a series whose rate never
 * changed. Through `SeriesPostedAverage.occurrences`, also what the popover's sentence counts and ranges, so it cannot
 * count a payment the average leaves out.
 *
 * ⚠️ Latent on his ledger (2026-10-12): only his pay has a history, and pay is read per payday, never through here.
 */
export function atTodaysRate(
  occurrences: readonly Occurrence[],
  schedule: Pick<RateSchedule, "amountHistory">,
  today: string,
): Occurrence[] {
  const now = currentRatePeriod(schedule, today);
  return occurrences.filter((o) => ratePeriodOf(schedule, o.postedOn) === now);
}

/**
 * "posted as 2" — a payment the bank posted as several rows, said where it is counted as one: the popover's "(5
 * tagged postings: Jun 16's posted as 2)" and the Amount history's "one payment, posted as 2". Null for a payment
 * posted whole, which says nothing new.
 */
export function postedAsWord(o: Pick<Occurrence, "postings">): string | null {
  return o.postings > 1 ? `posted as ${o.postings}` : null;
}

/**
 * ⚖️ DEFAULT, BUILT, NOT ASKED (2026-10-22; he said "no more questions") — the owner call the 2026-10-14 handoff §4
 * raised: a payment of at least `PAID_AHEAD_MULTIPLE` times the rate it is held to covered more than one charge, and
 * the average holding it SAYS so, beside the figure it keeps. 🔴 His Car insurance read "posted avg -$678.79 ±
 * $454.26" under the -$357.58 he set, and its popover "⚠️ … -$678.79, which is not what you set", with nothing to say
 * Sep 3's -$1,000.00 paid two premiums and part of a third early (his ledger copy 2026-10-21). Measured there: Sep 3 is
 * 2.80× its rate; every other payment of his 26 non-pay series is 0.24–1.15× (the rent's Jun 16, which carries the
 * utilities), so any multiple between 1.16 and 2.79 marks Sep 3 alone. The alternative — leave it out of the average
 * — was not built: it changes the figure, and that is his to decide.
 */
export const PAID_AHEAD_MULTIPLE = 2;

/** The payments of `occurrences` that covered more than one charge — `PAID_AHEAD_MULTIPLE` × `rateCents` or more. */
export function paidAhead(occurrences: readonly Occurrence[], rateCents: number | null): Occurrence[] {
  if (rateCents === null || rateCents === 0) return [];
  return occurrences.filter(
    (o) =>
      Math.sign(o.amountCents) === Math.sign(rateCents) &&
      Math.abs(o.amountCents) >= PAID_AHEAD_MULTIPLE * Math.abs(rateCents),
  );
}

/** the period one charge of a cadence covers — "more than one month" */
const CHARGE_PERIOD: Record<Cadence, string> = {
  weekly: "week",
  biweekly: "fortnight",
  semimonthly: "half-month",
  monthly: "month",
  quarterly: "quarter",
  annual: "year",
};

/**
 * "Sep 3's -$1,000.00 covered more than one month" — said beside the posted average holding it (`postedAvgNotes`); null
 * for none. A day outside `today`'s year carries the year.
 */
export function paidAheadPhrase(
  paid: readonly Pick<Occurrence, "postedOn" | "amountCents">[],
  cadence: Cadence,
  today: string,
): string | null {
  if (paid.length === 0) return null;
  const each = paid.map((o) => `${formatDayShortIn(o.postedOn, today)}'s ${formatCents(o.amountCents)}`);
  const named = each.length < 3 ? each.join(" and ") : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
  return `${named}${paid.length === 1 ? "" : " each"} covered more than one ${CHARGE_PERIOD[cadence]}`;
}

/**
 * What is said beside a posted average, in order — what its payments carry (`carriesPhrase`, §6A 59), then the
 * payments that covered more than one charge (`paidAheadPhrase`). ⛔ ONE list for the three surfaces that print the
 * average — the series page's Per charge and the All tab (" · "), and the popover's warning (" — "), so none can name
 * one and not the other.
 */
export function postedAvgNotes(
  avg: { carries: readonly string[]; paidAhead: readonly Pick<Occurrence, "postedOn" | "amountCents">[] },
  cadence: Cadence,
  today: string,
): string[] {
  return [carriesPhrase(avg.carries), paidAheadPhrase(avg.paidAhead, cadence, today)].filter(
    (n): n is string => n !== null,
  );
}
