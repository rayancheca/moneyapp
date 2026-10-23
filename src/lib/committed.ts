/**
 * The committed book: money the owner has already agreed to pay.
 *
 * Pure roll-up over occurrences the recurring engine has already projected —
 * this module decides nothing about WHICH series are live, when they step, or
 * whether their evidence has lapsed. `services/recurring` owns all of that and
 * has the anchor-day and `userEndsOn` arithmetic to prove it; duplicating any
 * of it here would create two places that must agree about a date, which is the
 * defect pass 54 was written to stop.
 *
 * What this module owns is the ARITHMETIC OF THE TOTAL, and one rule about it:
 *
 * ⛔ **Money in is never netted against money out.** `upcomingOccurrences`
 * returns income and bills from a single call, so a caller that forgets to
 * filter would hand a $4,188 salary series to a $3,211 rent book and publish a
 * commitment of roughly nothing. That is pass 62's "$0.14 expected income" in a
 * new costume: arithmetic that defends itself and a figure that is false.
 * Inflows are therefore PARTITIONED — counted, reported, and left out of the
 * total — rather than netted (silent) or thrown (a crash in a render path,
 * which pass 62 also shipped). `attribution.ts` sets the precedent: a
 * disagreement is disclosed, never clamped away.
 */

import type { Cadence } from "@/db/schema/recurring";
import { arrearsTail, HAS_NOT_POSTED, type ArrearsReading } from "@/lib/arrears-reading";
import { addCalendarMonths, compareDates, daysInMonthOf, monthKey, periodBounds, withDayOfMonth } from "@/lib/dates";
import { formatDayShortIn, formatMonthYear, monthWindowLabel } from "@/lib/format-date";
import { dayWindowLabel } from "@/lib/period";
import { levelledMonthlyCents, OCCURRENCES_PER_YEAR } from "@/lib/income-basis";
import { formatCents } from "@/lib/money";

/** Where a committed payment came from — already late, or still to come. */
export const COMMITTED_ORIGIN_LABEL = {
  overdue: "already late",
  upcoming: "scheduled",
} as const;

export type CommittedOrigin = keyof typeof COMMITTED_ORIGIN_LABEL;

/**
 * One projected (or overdue) payment. Structurally a subset of
 * `SeriesOccurrence` + `SeriesStaleness` from `services/recurring`, restated so
 * `lib` keeps not importing from `services` — the idiom `section-notes` and
 * `budget-verdict` already follow.
 */
export interface CommittedOccurrence {
  seriesId: string;
  name: string;
  /** iso date */
  date: string;
  /** net-worth signed: NEGATIVE is money out, as everywhere else in the app */
  amountCents: number;
  /** newest matched charge, or null when nothing has ever matched the series */
  lastMatchedOn: string | null;
  /** the series' evidence is older than its own tolerance, or absent entirely */
  isStale: boolean;
  /**
   * The series' own cadence — what a FULL horizon would have billed. Carried
   * rather than inferred from the occurrence count, because the two differ for
   * exactly the series this exists to describe: one that STOPS inside the
   * horizon bills fewer times than its cadence says, and inferring the cadence
   * from the count would make every such series look like it runs throughout.
   */
  cadence: Cadence;
  /** the day the series stops, or null when it runs on past this horizon */
  endsOn: string | null;
  /**
   * The series' whole schedule is ONE charge (`oneChargeDays`, services/recurring) — ⚖️ owner decision 2026-10-08
   * (§6A 56): no monthly cost, its own single payment. Absent means it is not.
   *
   * ⛔ Carried, never inferred from the occurrences: one payment ending on its own day is also the LAST payment of a
   * schedule that held more (`heaviestMonth`'s ⚠️), and only the series' charges tell the two apart.
   */
  oneCharge?: boolean;
  /**
   * ARREARS ONLY: of this payment's magnitude, the part that fell due on days no
   * checked statement has reached for the accounts the series bills on — money that may
   * well have posted where nobody has looked. Absent means all of it: the
   * cautious reading, because the sentence it feeds says "has not posted" only of
   * the rest (`arrearsSentence`).
   */
  unreadCents?: number;
  /**
   * ARREARS ONLY: of `unreadCents`, the part no statement keeps unread — the series' accounts read through today, so it
   * waits only for its days to post (`ArrearsSeries.inGraceCents`). Absent means none of it.
   */
  inGraceCents?: number;
}

export interface CommittedInput {
  /** iso, inclusive — the first day of the horizon */
  from: string;
  /** iso, EXCLUSIVE — the horizon is `[from, to)`, exactly `months` months */
  to: string;
  /** whole calendar months spanned by [from, to); the per-month denominator */
  months: number;
  /** projected payments inside the horizon */
  occurrences: readonly CommittedOccurrence[];
  /** payments that came due before `from` and never posted — ARREARS, outside it */
  overdue: readonly CommittedOccurrence[];
}

export interface CommittedLine {
  seriesId: string;
  name: string;
  /** payments inside the horizon; arrears are not among them */
  occurrences: number;
  /** positive magnitude of money out across the whole horizon */
  totalCents: number;
  /**
   * `totalCents ÷ months`, NOT `totalCents ÷ occurrences`.
   *
   * The two differ for exactly the series worth getting right: car insurance
   * pays five times across a six-month horizon because it ends inside it, and
   * dividing by its own occurrence count would republish $361.49 as the monthly
   * burden of a commitment that costs $301.24 a month over the window actually
   * being asked about. The horizon is the question; the occurrence count is an
   * answer, and it is reported separately so the reader can see both.
   */
  perMonthCents: number;
  /** arrears on this series — money that came due before the horizon opened and
   *  never posted. ⛔ NOT part of `totalCents`; see `CommittedOutflows`. */
  overdueCents: number;
  /** the series' evidence is stale or absent */
  isStale: boolean;
  /** nothing has ever posted against this series */
  neverPosted: boolean;
  /** the series' cadence, so a reader can check the two figures below */
  cadence: Cadence;
  /** the day the series stops, or null */
  endsOn: string | null;
  /**
   * The day of its LAST payment inside the horizon, or null when it has none there (arrears only). Of a ONE-CHARGE line
   * (§6A 56) the day of that charge, which `endsOn` need not be: a schedule is one charge with its end anywhere before
   * the step after it (`isOneCharge`) — and the car card says "charges once on <day>" of it (`heaviestMonthEnding`).
   */
  lastPaymentOn: string | null;
  /**
   * The series stops BEFORE the horizon closes, so it is billed across only
   * part of the window the rate is divided over.
   *
   * ⛔ This is the CAUSE, and every claim about a shrunken rate is gated on it
   * rather than on an arithmetic comparison. `levelledMonthlyCents` rounds, so
   * a full-horizon annual line can miss its own rate by a cent — and a
   * threshold on that difference would be a magic number standing where a fact
   * belongs.
   */
  endsInHorizon: boolean;
  /** the series' whole schedule is one charge (`CommittedOccurrence.oneCharge`, ⚖️ §6A 56) */
  oneCharge: boolean;
  /** what ONE payment costs, as a positive magnitude */
  perOccurrenceCents: number;
  /**
   * What this line would contribute per month if it ran the WHOLE horizon —
   * its cadence annualised, which is the basis the subscriptions card publishes.
   * Equal to `perMonthCents` (to rounding) for every line that does run it.
   *
   * ⚖️ A ONE-CHARGE line (§6A 56) has no cadence to level by — the subscriptions card files it a one-off, out of its
   * monthly figure — and its whole schedule is the one payment this horizon holds, so it runs it: this is its rate.
   * Still `endsInHorizon` (it stops on its day, and the car card counts it among what stops), never short.
   */
  levelledPerMonthCents: number;
  /**
   * How much LOWER this line's contribution to the rate is than its own bill
   * levels to. Zero unless `endsInHorizon` — see the note there.
   */
  shortfallPerMonthCents: number;
}

export interface CommittedOutflows {
  from: string;
  to: string;
  months: number;
  /** positive magnitude of all committed money out INSIDE the horizon */
  totalCents: number;
  /** `totalCents ÷ months` */
  perMonthCents: number;
  /**
   * Arrears: money that came due before the horizon opened and never posted.
   *
   * ⛔ NOT part of `totalCents`, and this is the whole point of the split. The
   * horizon is `[from, to)` — exactly `months` calendar months — so a monthly
   * series contributes exactly `months` payments to it whatever day it is
   * asked on. A debt that came due BEFORE `from` is not inside those months,
   * and adding it to the numerator while leaving `months` as the denominator
   * is how a $2,109.00 rent came to publish $2,284.75 as its monthly cost.
   *
   * Counted, reported, left out — the treatment `inflowCents` already gets,
   * for the same reason. A caller that wants "everything I still owe" adds the
   * two; a caller that wants a RATE uses `perMonthCents` and says the arrears
   * separately, which is what the runway card does.
   */
  overdueCents: number;
  /**
   * Of `overdueCents`, the part on days no checked statement has reached for the
   * accounts those bills post from — summed from each arrears payment's `unreadCents`.
   * What `arrearsSentence` refuses to call "has not posted".
   */
  overdueUnreadCents: number;
  /**
   * Of `overdueUnreadCents`, the part no statement keeps unread — summed from each arrears payment's `inGraceCents`. What
   * `arrearsSentence` says waits for its days to post, never "no statement has covered it yet".
   */
  overdueInGraceCents: number;
  /** how many arrears payments `overdueCents` is made of */
  overdueCount: number;
  /**
   * Committed money INSIDE THE HORIZON whose series has never posted —
   * registered, not evidenced.
   *
   * ⚠️ Sums `lines[].totalCents`, so it narrowed when arrears left that figure:
   * a never-posted series' arrears are no longer part of it. That is consistent
   * — the horizon is what this describes — and it is stated because the change
   * happened underneath this field rather than to it.
   */
  unevidencedCents: number;
  /**
   * How much the ending series lower `perMonthCents` between them.
   *
   * 🔴 THIS IS THE $210.87 BETWEEN TWO CARDS ON HIS DASHBOARD. The runway card
   * publishes a RATE over the horizon; the subscriptions card LEVELS each bill
   * to a month. Both are right, and on 2026-09-02 the whole difference was one
   * series — car insurance, evidenced through 2027-01-11 with no renewal in the
   * ledger, billed five times out of twelve. He asked this card to say so, so
   * the figure is computed here rather than left for a reader to subtract.
   *
   * ⚠️ NO LONGER THE WHOLE DIFFERENCE, TO THE CENT. A ONE-CHARGE line (§6A 56) is short of nothing here, so it is no
   * part of this figure — but the RATE keeps its one payment (the decision's "runway unchanged") while the subscriptions
   * card takes it out of its monthly total. Measured on his ledger copy 2026-10-21: rate $3,452.25 + this $297.98 =
   * $3,750.23 beside the card's $3,744.18 — the $6.05 left over is the Nov 11 balance's $72.74 over the rate's twelve
   * months ($6.06, a cent of rounding apart; review of ebf628b). The caption never quotes the other card, so nothing he
   * reads disagrees. ⚖️ DEFAULT, NOT ASKED (2026-10-22; he said "no more questions"): left unsaid on the card — a
   * clause for $6.06 a month would outweigh the money; the other way is a sentence naming the one charge's share.
   */
  shortfallPerMonthCents: number;
  /** largest commitment first */
  lines: CommittedLine[];
  /**
   * Money IN that was passed to a committed-OUTFLOW roll-up. Always a caller
   * bug; reported rather than netted or thrown. Non-zero here means some read
   * path is feeding income into a bills figure.
   */
  inflowCents: number;
  inflowCount: number;
}

interface Accumulator {
  seriesId: string;
  name: string;
  occurrences: number;
  totalCents: number;
  overdueCents: number;
  isStale: boolean;
  neverPosted: boolean;
  cadence: Cadence;
  endsOn: string | null;
  lastPaymentOn: string | null;
  oneCharge: boolean;
}

/**
 * Does a commitment STOP inside a horizon that closes at `toExclusive`?
 *
 * ⛔ `to` is EXCLUSIVE, so a series ending ON it runs the whole horizon.
 *
 * ⚠️ TWO SURFACES ASK THIS AND MUST NOT ANSWER DIFFERENTLY. This book gates
 * `shortfallPerMonthCents` and `shrinkCaption` on it; `/recurring/<id>` gates
 * the caveat under its ANNUALIZED figure on it (`annualizedCaveat`). That
 * caveat hand-rolled `endsOn !== null` — the mere EXISTENCE of an end date —
 * and so told the owner his `Car lease`, which ends 2028-08-15 and bills the
 * next twelve months in full for $8,340.48, that it was "scheduled only to
 * 2028-08-15".
 */
export function endsInsideHorizon(endsOn: string | null, toExclusive: string): boolean {
  return endsOn !== null && compareDates(endsOn, toExclusive) < 0;
}

export function committedOutflows(input: CommittedInput): CommittedOutflows {
  const { months } = input;
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`committedOutflows: months must be a positive integer, got ${months}`);
  }

  const bySeries = new Map<string, Accumulator>();
  let inflowCents = 0;
  let inflowCount = 0;
  let overdueCount = 0;
  let overdueUnreadCents = 0;
  let overdueInGraceCents = 0;

  const take = (o: CommittedOccurrence, origin: CommittedOrigin): void => {
    if (o.amountCents > 0) {
      inflowCents += o.amountCents;
      inflowCount += 1;
      return;
    }
    // A zero-amount occurrence moves no money and earns no row. It is neither
    // an outflow nor an inflow, and giving it a line would print a commitment
    // of $0.00 — the shape pass 62 drew as a 77.97px bar labelled "$0.00".
    if (o.amountCents === 0) return;

    const magnitude = -o.amountCents;
    const isArrears = origin === "overdue";
    if (isArrears) {
      overdueCount += 1;
      // clamped to the payment: never more unread than there is to read — and never more of it in grace than is unread
      const unread = Math.min(magnitude, Math.max(0, o.unreadCents ?? magnitude));
      overdueUnreadCents += unread;
      overdueInGraceCents += Math.min(unread, Math.max(0, o.inGraceCents ?? 0));
    }
    const acc = bySeries.get(o.seriesId) ?? {
      seriesId: o.seriesId,
      name: o.name,
      occurrences: 0,
      totalCents: 0,
      overdueCents: 0,
      isStale: o.isStale,
      neverPosted: o.lastMatchedOn === null,
      cadence: o.cadence,
      endsOn: o.endsOn,
      lastPaymentOn: null,
      oneCharge: o.oneCharge ?? false,
    };
    bySeries.set(o.seriesId, {
      ...acc,
      // ⛔ arrears fall OUTSIDE the horizon, so they raise neither the count
      // nor the total the per-month figure is divided from
      occurrences: acc.occurrences + (isArrears ? 0 : 1),
      lastPaymentOn:
        isArrears || (acc.lastPaymentOn !== null && compareDates(acc.lastPaymentOn, o.date) >= 0)
          ? acc.lastPaymentOn
          : o.date,
      totalCents: acc.totalCents + (isArrears ? 0 : magnitude),
      overdueCents: acc.overdueCents + (isArrears ? magnitude : 0),
    });
  };

  for (const o of input.overdue) take(o, "overdue");
  for (const o of input.occurrences) take(o, "upcoming");

  const lines: CommittedLine[] = [...bySeries.values()]
    .map((a) => {
      const perMonthCents = Math.round(a.totalCents / months);
      /*
       * ⛔ `totalCents / occurrences`, NOT the series' stored amount: this line
       * is built from the occurrences that landed inside the horizon, and the
       * two agree only when nothing else does. An arrears-only line has no
       * occurrences at all, so it is guarded rather than divided by zero.
       */
      const perOccurrenceCents = a.occurrences === 0 ? 0 : Math.round(a.totalCents / a.occurrences);
      /*
       * ⚖️ §6A 56: a one charge is its own single payment — levelled to a month of its stored cadence it is short of
       * the eleven it never had. 🔴 His runway card read "…, and one other does too — … $364.66 a month lower for the
       * two of them" (a copy of his ledger, 2026-10-13): $66.68 of it the Nov 11 balance, $72.74 "levelled" against
       * the $6.06 its one payment adds.
       */
      const levelledPerMonthCents = a.oneCharge ? perMonthCents : levelledMonthlyCents(perOccurrenceCents, a.cadence);
      const endsInHorizon = endsInsideHorizon(a.endsOn, input.to);
      return {
        seriesId: a.seriesId,
        name: a.name,
        occurrences: a.occurrences,
        totalCents: a.totalCents,
        perMonthCents,
        overdueCents: a.overdueCents,
        isStale: a.isStale,
        neverPosted: a.neverPosted,
        cadence: a.cadence,
        endsOn: a.endsOn,
        lastPaymentOn: a.lastPaymentOn,
        endsInHorizon,
        oneCharge: a.oneCharge,
        perOccurrenceCents,
        levelledPerMonthCents,
        // gated on the CAUSE, and floored: an ending series whose remaining
        // payments happen to over-cover the window is not "short" by a negative
        shortfallPerMonthCents: endsInHorizon
          ? Math.max(0, levelledPerMonthCents - perMonthCents)
          : 0,
      };
    })
    // arrears-only lines have a zero horizon total; they still rank by the money
    // they represent rather than tying at zero in name order
    .sort(
      (x, y) =>
        y.totalCents - x.totalCents || y.overdueCents - x.overdueCents || x.name.localeCompare(y.name),
    );

  const totalCents = lines.reduce((s, l) => s + l.totalCents, 0);

  return {
    from: input.from,
    to: input.to,
    months,
    totalCents,
    perMonthCents: Math.round(totalCents / months),
    overdueCents: lines.reduce((s, l) => s + l.overdueCents, 0),
    overdueUnreadCents,
    overdueInGraceCents,
    overdueCount,
    unevidencedCents: lines.reduce((s, l) => s + (l.neverPosted ? l.totalCents : 0), 0),
    shortfallPerMonthCents: lines.reduce((s, l) => s + l.shortfallPerMonthCents, 0),
    lines,
    inflowCents,
    inflowCount,
  };
}

/** How many bills a rate names before counting the rest — "…, Car lease, Rent utilities & fees, and 9 more". */
const BILLS_NAMED = 3;

/**
 * The bills "Committed bills come to $X a month — …" names: the lines INSIDE the rate, largest first, three by name and
 * the rest counted. Null when no line is — a book of nothing but arrears has no rate to name bills under, and the card
 * prints no "$0.00 a month" over it.
 *
 * ⛔ A line that carries only arrears (`occurrences` 0) is the money that came due before the horizon opened, and none
 * of the rate: `arrearsSentence` says it beside the rate. 🔴 Asked about Nov 12 on a copy of his ledger (2026-10-12),
 * the one-time Nov 11 car-insurance balance — owed, nothing of it still to come — was one of "…, and 10 more" bills
 * that "come to $3,446.19 a month", at $0.00 of it.
 */
export function committedBillsNamed(lines: readonly CommittedLine[]): string | null {
  const inRate = lines.filter((l) => l.occurrences > 0);
  if (inRate.length === 0) return null;
  const named = inRate.slice(0, BILLS_NAMED).map((l) => l.name).join(", ");
  const rest = inRate.length - BILLS_NAMED;
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

/**
 * The runway card's arrears sentence: what came due before today and has not
 * posted, said only as far as the ledger has looked.
 *
 * 🔴 It read "A further $2,296.20 came due earlier this month and never
 * posted." on the owner's ledger 2026-10-07, while October was imported for
 * none of the accounts those bills post from — and /budgets said the same money
 * is "due by today and no import has covered them yet". A negative claim is kept
 * for the part on days the ledger has read (`overdueUnreadCents` is the rest);
 * the unread part takes /budgets' words. "Came due" stays: this leg closes the
 * day BEFORE today (see `committedBook`), so every payment in it is past due.
 *
 * ⛔ The split is `arrearsTail`'s, the one the bill's own page, `/recurring`'s Next column and the math table say it
 * through (`lib/arrears-reading`).
 *
 * 🔴 …and the read half kept its own word, "never posted", where every other surface says "has not posted" or "not
 * posted" (his decisions 60 and 65): "$45.00 never posted" on the e2e runway beside the math table's "came due … and
 * has not posted". The words are the builder's now (`HAS_NOT_POSTED`), and no other can be passed.
 *
 * Null when nothing is late — silence, never "nothing came due".
 */
export function arrearsSentence(book: ArrearsBook): string | null {
  if (book.overdueCents <= 0) return null;
  const tail = arrearsTail(arrearsReadingOf(book), HAS_NOT_POSTED);
  return `A further ${formatCents(book.overdueCents)} came due earlier this month${tail}.`;
}

/** The book figures `arrearsSentence` and its tone read — the in-grace part absent for none of it. */
type ArrearsBook = Pick<CommittedOutflows, "overdueCents" | "overdueUnreadCents"> &
  Partial<Pick<CommittedOutflows, "overdueInGraceCents">>;

/**
 * The book's arrears as the read/unread split every arrears surface says them through — the runway card takes its
 * sentence (`arrearsSentence`) and its tone (`arrearsAlarms`) from the same reading.
 */
export function arrearsReadingOf(book: ArrearsBook): ArrearsReading {
  return {
    owedCents: book.overdueCents,
    unreadCents: book.overdueUnreadCents,
    inGraceCents: book.overdueInGraceCents,
  };
}

/**
 * ⭐ WHAT SHRANK THE RATE — the sentence the owner asked for on 2026-09-02.
 *
 * Two cards on his dashboard state the monthly cost of the same thirteen
 * recurring series and differ by $210.87:
 *
 *     RUNWAY         "Committed bills come to $3,542.21 a month"
 *     SUBSCRIPTIONS  "$3,753.08 a month, still forecast"
 *
 * Both are right. The runway card publishes a RATE over its twelve-month
 * horizon, so a series that stops inside it contributes fewer payments; the
 * subscriptions card LEVELS each bill to a month, which is the right basis for
 * a list of what he pays. He chose to have this card name what shrank it.
 *
 * ⛔ IT NAMES ONLY WHAT THIS BOOK CAN PROVE. Every figure comes from the line
 * itself — the series' end day, its payments inside the horizon, its own two
 * per-month figures. It deliberately does NOT quote the other card's total: the
 * two cards choose their series independently (`COMMITTED_KINDS` here), so a
 * sentence asserting a number computed on the other side would be one card
 * speaking for another, and would go quietly false the day the sets diverge.
 *
 * ⛔ AND IT DOES NOT CREDIT ONE SERIES WITH THE WHOLE DIFFERENCE. When more than
 * one ends inside the horizon, the named one carries only its own shortfall and
 * the rest are counted out loud.
 *
 * ⚖️ A ONE-CHARGE line (§6A 56) ends inside the horizon and lowers nothing — its one payment is all its schedule
 * holds — so it is neither the lead nor one of the others counted (`endingLead`). ⚠️ So the sentence explains the gap
 * between the two cards all but the one charge's own share of the rate, which the subscriptions card leaves out: $6.05
 * on his ledger copy 2026-10-21 (`CommittedOutflows.shortfallPerMonthCents`).
 *
 * Null when nothing ends — silence, never "nothing shrank it", which is the
 * measured-zero rule the rest of this file follows.
 */
export function shrinkCaption(book: {
  lines: readonly CommittedLine[];
  shortfallPerMonthCents: number;
}): string | null {
  const ending = endingLead(book);
  if (ending === null) return null;
  const { lead, endsOn, others } = ending;
  const times = lead.occurrences === 1 ? "once" : `${lead.occurrences} times`;

  return (
    `${lead.name} stops inside that window — evidenced through ${dayWindowLabel(endsOn, endsOn)}, with no renewal ` +
    `in the ledger${endingOthersClause(others)} — so it is billed ${times} rather than throughout, and counts ` +
    `${formatCents(lead.perMonthCents)} a month here against the ${formatCents(lead.perOccurrenceCents)} ` +
    `it charges. The rate above is ${formatCents(book.shortfallPerMonthCents)} a month lower ` +
    `${endingShortfallFor(others)}.`
  );
}

/**
 * Whose shortfall the book's figure is — "for it", "for the two of them", "for all 3 of them": the lead and the
 * others `endingOthersClause` counted, since `shortfallPerMonthCents` sums every ending line's.
 *
 * 🔴 It was "for it" whatever ended: his runway card read "…and one other does too … The rate above is $364.66 a
 * month lower for it." — $297.98 of it Car insurance's and $66.68 the Nov 11 balance's (a copy of his ledger,
 * 2026-10-13), the whole difference credited to the one it names.
 *
 * ⚖️ …and the balance was never one of them: it is ONE charge (§6A 56), its own single payment, short of nothing
 * (`CommittedLine.levelledPerMonthCents`). His card reads "…$297.98 a month lower for it." — Car insurance's own.
 */
export function endingShortfallFor(others: number): string {
  return others === 0 ? "for it" : others === 1 ? "for the two of them" : `for all ${others + 1} of them`;
}

/** The commitment a book names as ending, and how many others end beside it. */
export interface EndingLead {
  lead: CommittedLine;
  /**
   * the lead's end day — never null, because only an ending line can lead. Of a one-charge lead (`heaviestMonthEnding`
   * alone names one) the day it charges.
   */
  endsOn: string;
  /** the other COMMITMENTS that also stop inside the horizon, counted, not named — a one charge is none (§6A 56) */
  others: number;
  /**
   * …and named, each with the day it stops, earliest first — `heaviestMonthEnding`'s alone, for the car card's sentence
   * beside a one-charge lead (`carEvidenceCaption`). 🔴 It counted them, "One commitment stops inside the next 12
   * months", naming neither Car insurance nor its Jan 11 that the runway beside it names (review of 5b19be6).
   */
  othersStopping?: readonly { name: string; on: string }[];
}

/**
 * WHICH ending commitment a sentence about a book names — the choice
 * `shrinkCaption` makes, as a value.
 *
 * 🔴 A SECOND SURFACE PICKED ITS OWN. The car card took the EARLIEST end date
 * of any car series and printed it under the hard-coded word "Insurance".
 * Measured on the owner's dashboard 2026-09-15 it read "Insurance is evidenced
 * through Nov 11, 2026" — the one-payment balance left after a $1,000 early
 * payment — beside the runway card's "Car insurance stops inside that window —
 * evidenced through Jan 11, 2027". After Nov 11 he still pays the premium
 * twice. Both sentences now name the line this returns.
 *
 * The lead is the line that lowers the rate MOST, not the one that ends first:
 * it is the one whose end changes what the book says a month costs.
 */
export function endingLead(book: { lines: readonly CommittedLine[] }): EndingLead | null {
  const ending = book.lines
    .filter((l) => l.endsInHorizon && l.shortfallPerMonthCents > 0)
    .sort((a, b) => b.shortfallPerMonthCents - a.shortfallPerMonthCents);
  const lead = ending[0];
  if (lead === undefined || lead.endsOn === null) return null;
  return { lead, endsOn: lead.endsOn, others: ending.length - 1 };
}

/** ", and one other does too" — the others `endingLead` counted, in one spelling. */
export function endingOthersClause(others: number): string {
  return others === 0 ? "" : others === 1 ? ", and one other does too" : `, and ${others} others do too`;
}

/** The heaviest calendar month of a set of payments — see `heaviestMonth`. */
export interface HeaviestMonth {
  /** the most money out any one calendar month bills, positive magnitude; 0 when nothing goes out */
  cents: number;
  /** the LAST calendar month (`yyyy-mm`) that bills `cents`; null when nothing goes out */
  month: string | null;
  /** the series billed in that month */
  seriesIds: readonly string[];
}

/** One series' payments inside one calendar month. */
interface MonthBucket {
  cents: number;
  count: number;
  cadence: Cadence;
}

/**
 * What one series adds to a calendar month it bills in.
 *
 * ⛔ A series that bills MORE OFTEN THAN MONTHLY counts at its levelled rate,
 * not at however many of its payments this month happens to hold. A review
 * measured the alternative on 2026-09-15: a $20 weekly line beside the lease
 * priced October at five Fridays ($795.04) — and November, with four, would
 * have said $775.04 — so the calendar's extra Friday picked "a month". Levelled,
 * every month it bills says $781.71. A monthly-or-longer series bills at most
 * once a calendar month, so its month holds exactly the bill.
 */
function monthContributionCents(bucket: MonthBucket): number {
  return OCCURRENCES_PER_YEAR[bucket.cadence] > OCCURRENCES_PER_YEAR.monthly
    ? levelledMonthlyCents(Math.round(bucket.cents / bucket.count), bucket.cadence)
    : bucket.cents;
}

/**
 * The most money out any ONE calendar month of these occurrences bills — and
 * which month, and which series bill in it.
 *
 * 🔴 "A month, while both are billed" was the FIRST occurrence of every series,
 * summed. On the owner's ledger 2026-09-15 that priced the one-payment Nov 11
 * insurance balance ($72.74) as a monthly bill beside the premium it is the
 * remainder of: $1,125.36, a month no calendar holds — November bills $767.78,
 * December and January $1,052.62.
 *
 * ⛔ AND NOT "drop every line billed once". A book cannot tell a one-off from a
 * series on its LAST payment: on 2026-12-12 the real premium has one payment
 * left (Jan 11) and would be dropped with the balance, printing the lease alone
 * over a January that bills both.
 *
 * ⚠️ WHAT READING THE MONTHS DOES NOT FIX, EITHER. The fix above is right on the
 * owner's ledger because the balance falls in NOVEMBER, a month the premium
 * does not bill. Had it fallen on Dec 11 it would be summed in beside the
 * premium and print $1,125.36 again — a review demonstrated exactly that on
 * 2026-09-15. Its occurrences were indistinguishable from a premium paid ahead
 * to its last payment (one payment, ending on it), which DOES bill that month,
 * so there was nothing in a book to drop it by. Disclosed rather than guessed
 * around; its test pins the two books to one answer.
 * ⚖️ A book carries it now (`CommittedOccurrence.oneCharge`, §6A 56) — so this figure COULD drop it, and does not: the
 * decision leaves the figure as it was (the car card's "unchanged"), and the sentence under it says the charge instead
 * (`heaviestMonthEnding`, `carEvidenceCaption`). 🔴 This warning still said there was nothing to drop it by after
 * ebf628b put the reading on every occurrence (review of ebf628b).
 *
 * The LAST month that reaches the most is the one kept, because the sentence
 * that dates this figure asks when it stops being what he pays — see
 * `heaviestMonthEnding`.
 *
 * ⛔ Money in is never netted against money out (this module's rule): an inflow
 * does not lower a month.
 */
export function heaviestMonth(occurrences: readonly CommittedOccurrence[]): HeaviestMonth {
  const byMonth = new Map<string, Map<string, MonthBucket>>();
  for (const o of occurrences) {
    if (o.amountCents >= 0) continue;
    const key = monthKey(o.date);
    const series = byMonth.get(key) ?? new Map<string, MonthBucket>();
    const bucket = series.get(o.seriesId) ?? { cents: 0, count: 0, cadence: o.cadence };
    series.set(o.seriesId, { ...bucket, cents: bucket.cents - o.amountCents, count: bucket.count + 1 });
    byMonth.set(key, series);
  }

  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  return months.reduce<HeaviestMonth>(
    (heaviest, [month, series]) => {
      const cents = [...series.values()].reduce((sum, bucket) => sum + monthContributionCents(bucket), 0);
      // `>=`: a later month that ties replaces an earlier one — the LAST is kept
      return cents >= heaviest.cents ? { cents, month, seriesIds: [...series.keys()] } : heaviest;
    },
    { cents: 0, month: null, seriesIds: [] },
  );
}

/**
 * WHICH ending commitment the monthly figure stops with — the car card's
 * sentence under `heaviestMonth`, as a value.
 *
 * 🔴 IT BORROWED THE RUNWAY CARD'S ANSWER TO A DIFFERENT QUESTION. The car card
 * named `endingLead`'s line: the one that lowers the RATE most, which is right
 * for the runway's rate sentence. The car card's sentence says when "the
 * monthly figure above stops being what you pay", and that figure is the
 * heaviest month. A review built the book where the two differ (2026-09-15): a
 * lease ending Feb 15, 2027 and a policy whose last premium is Nov 11, 2026.
 * The card printed "Car lease stops inside the next 12 months — evidenced
 * through Feb 15, 2027 …" over a $1,052.62 that holds the premium, which is not
 * what he pays after Nov 11, 2026.
 *
 * The figure stops being true when a line billed in the LAST month that
 * reaches it stops, so the lead is the EARLIEST-ending of those lines, and the
 * date printed is its own — a name and a date from one line. Null when none of
 * them ends inside the horizon: a line ending outside that month (the
 * one-payment Nov 11 balance, before a premium that runs on) does not stop the
 * figure. On the owner's ledger 2026-09-15 this and `endingLead` name the same
 * line, the premium, through Jan 11, 2027.
 *
 * `others` counts every OTHER commitment that stops inside the horizon, for
 * `endingOthersClause`.
 *
 * ⚖️ …and a ONE-CHARGE line (§6A 56) is no commitment that stops: a charge due once is over on its day, as the runway's
 * count (`endingLead`) has read it since ebf628b — it lowers no rate. Left out of `others` too (§6A 56 read on
 * 2026-10-14, no new question). 🔴 On a copy of his ledger 2026-10-13 the car card said "…, and one other does too" of
 * the Nov 11 balance beside the runway's same sentence of Car insurance alone.
 *
 * ⚖️ …while one billed IN the heaviest month still dates the figure, by the day it CHARGES (`lastPaymentOn`): the
 * decision leaves the figures as they were, so that month's figure holds it, and is not what he pays after that day.
 * ⛔ Never as a commitment that stops — `carEvidenceCaption` says it as the one charge it is. 🔴 Review of 89f235d: with
 * Car insurance ended, or its anchor typed past its end, his car card read "Car insurance — Nov 11 balance … stops
 * inside the next 12 months — evidenced through Nov 11, 2026, with no renewal in the ledger" over November's $767.78
 * (copies of his ledger 2026-10-13). ⚠️ AND NOT LEFT OUT OF THE LEAD: dated by the next commitment instead, a book with a
 * one charge on a premium's Dec 11 dates December's $1,125.36 "after Jan 11, 2027" — a January that bills $1,052.62.
 */
export function heaviestMonthEnding(
  book: { lines: readonly CommittedLine[] },
  heaviest: HeaviestMonth,
): EndingLead | null {
  // the day each line stops the figure: a commitment's end inside the horizon, a one charge's own day (§6A 56)
  const stops = book.lines.flatMap((line) => {
    const day = line.oneCharge ? line.lastPaymentOn : line.endsInHorizon ? line.endsOn : null;
    return day === null ? [] : [{ line, day }];
  });
  const billed = new Set(heaviest.seriesIds);
  // stable: lines arrive largest first, so a tie on the day names the larger
  const first = stops.filter((s) => billed.has(s.line.seriesId)).sort((a, b) => compareDates(a.day, b.day))[0];
  if (first === undefined) return null;
  const stopping = stops
    .filter((s) => s !== first && !s.line.oneCharge)
    .sort((a, b) => compareDates(a.day, b.day))
    .map((s) => ({ name: s.line.name, on: s.day }));
  return { lead: first.line, endsOn: first.day, others: stopping.length, othersStopping: stopping };
}

/**
 * What to CALL the trailing window a spending average was taken over.
 *
 * ⛔ ZERO MONTHS IS NOT A RANGE. `baselineWindow` floors the window at the
 * first month the ledger covers in full and falls back to the CURRENT month
 * for its labels when there is no such month — so the obvious sentence reads
 * "0 complete months, 2022-09 to 2022-09. This month is still running and is
 * not counted", naming as the range it averaged the one month it says it did
 * not count. A caption is a claim like any other figure on the card.
 *
 * Pure, and here rather than inside the card, because the branch a pinned e2e
 * clock can never render is exactly the one worth a test — the same reason
 * `pace-geometry` lives in `lib`.
 */
export function baselineCaption(window: {
  months: number;
  fromMonth: string;
  toMonth: string;
  /**
   * The car's up-front money the average left out (`SpendBaseline.upfrontCarCents`, owner decision 2026-10-07,
   * §6A 51). ⛔ Named whenever it is not zero: "Spending averaged over …" over a figure that is not the plain average
   * of those months would be a caption that lies by omission.
   */
  upfrontCarCents?: number;
  /** the complete months the window leaves out unread (`BaselineWindow.unread`, decision 71) — said, never silent */
  unread?: UnreadMonths | null;
}): string {
  const span = baselineSpan(window);
  if (span === null) return emptyWindowCaption(window.unread ?? null);
  const unread = unreadMonthsSentence(window.unread ?? null);
  const why = unread === null ? "" : ` ${unread}`;
  const leftOut = upfrontCarLeftOut(window.upfrontCarCents ?? 0);
  const clause = leftOut === null ? "" : `, leaving out ${leftOut}`;
  return `Spending averaged over ${span}${clause}.${why} This month is still running and is not counted.`;
}

/**
 * What the car card's share is set against — "not what the last six months measured." — its baseline, which is
 * `baselineWindow`'s.
 *
 * 🔴 Once the frontier slid that window back (his decision 71, 2026-10-13) they were not the last six months: measured on
 * his ledger copy that day, Feb 2026 to Jul 2026 beside an October. So a cut window is named by its months, with the
 * runway caption's reason (`unreadMonthsSentence`), and an uncut one of six reads exactly as it always did.
 *
 * 🔴 …and nor where the FLOOR shortened it (review of cbee36b): a young ledger's window holds the months it covers in
 * full, with no frontier cutting anything (`baselineWindow`), and read "the last six months" over three of them — or
 * over none. Named by its months too, and an empty one in the runway caption's opening (`emptyWindowOpening`).
 */
export function measuredMonthsClause(window: {
  months: number;
  fromMonth: string;
  toMonth: string;
  unread?: UnreadMonths | null;
}): string {
  const unread = unreadMonthsSentence(window.unread ?? null);
  // the sentence's own six: true only of a window that holds six months and ends at the last complete one
  if (unread === null && window.months === 6) return "not what the last six months measured.";
  const why = unread === null ? "" : ` ${unread}`;
  const span = baselineSpan(window);
  if (span !== null) return `not what the ${span}, measured.${why}`;
  const opening = emptyWindowOpening(window.unread ?? null);
  return `not anything measured: ${opening[0]!.toLowerCase()}${opening.slice(1)}.${why}`;
}

/** What a window the frontier emptied is (decision 71): complete months were imported, none of them read in full. */
const NONE_READ_IN_FULL = "no month has been read in full yet";

/**
 * How a caption over `baselineWindow` opens when the window holds no month — "No complete month has been imported
 * yet", or, when the frontier emptied it, "No month has been read in full yet".
 *
 * 🔴 Review of cf8f8dc: the runway and Subscriptions captions kept "No complete month has been imported yet" over a
 * window the frontier emptied and then named, in the next sentence, the complete months it left out — imported whole on
 * one account, read only part of the way on another — beside the car card's "no month has been read in full yet" over
 * the same window. A young ledger reaches it: with no habit yet every account dates the frontier, so one account last
 * imported before the first whole month ends empties the window. ⛔ ONE PHRASE for all three (`NONE_READ_IN_FULL`).
 */
export function emptyWindowOpening(unread: UnreadMonths | null): string {
  const phrase = unreadMonthsSentence(unread) === null ? "no complete month has been imported yet" : NONE_READ_IN_FULL;
  return `${phrase[0]!.toUpperCase()}${phrase.slice(1)}`;
}

/**
 * What a spending average says when it holds no month — "No month has been read in full yet, so there is no spending
 * average to stand on. Jun 2026 and Jul 2026 are left out: Jun 12 is the last day every account you spend from has
 * been imported through." — or "No complete month has been imported yet, so …" where nothing was left out.
 *
 * ⛔ ONE SENTENCE for the runway's caption (`baselineCaption`) and /recurring's pace row (`spendPaceNote`): both read
 * their months by one rule (`averagedMonths`), so on one ledger and one day they hold no month together. 🔴 Review of
 * 6d11c4d: the pace row read "Spending $0.00" over three months before the ledger's first record where the runway on
 * the same young ledger said no month had been read in full.
 */
export function emptyWindowCaption(unread: UnreadMonths | null): string {
  const why = unreadMonthsSentence(unread);
  return `${emptyWindowOpening(unread)}, so there is no spending average to stand on.${why === null ? "" : ` ${why}`}`;
}

/**
 * The complete months a spending window leaves out because not every account you spend from has been read through
 * their last day — `BaselineWindow.unread` — and the day that leaves them out.
 */
export interface UnreadMonths {
  /** 'YYYY-MM', oldest first: complete calendar months after the window and before the running one */
  months: string[];
  /**
   * The day that leaves them out: for a spending window `spendingCoverageThrough` — the last day every account you
   * spend from has been imported through — and for the income pace's `incomeCoverage`, the last day every account that
   * dates it has been: those its own rows come in on habitually that a statement is still coming for
   * (`IncomeUnreadMonths` names them)
   */
  through: string;
}

/**
 * The INCOME pace's left-out months (`incomePaceMonths`), and the accounts that date them: EVERY account that dates the
 * pace's day (`incomeCoverage`), by name, in the app's order (`ACCOUNT_ORDER`). `through` is the earliest of their
 * import days — the last day ALL of them have been imported through ("both A and B have",
 * `incomeUnreadMonthsSentence`), not each one's own.
 *
 * ⛔ Named, never "every account your income lands in". 🔴 Review of af84411 (MEDIUM): the day leaves out the accounts
 * a live series' pay lands in — the schedule projects that pay, never the pace — so on a copy of his ledger with
 * Robinhood Cash shown through Oct 9 and Wells Fargo (his weekly pay) through Sep 24, at 2026-11-10 /recurring read
 * "Oct 9 is the last day every account your income lands in has been imported through" two lines under "It falls after
 * Thu, Sep 24, 2026, the last day every account that pay lands in has been checked through".
 */
export interface IncomeUnreadMonths extends UnreadMonths {
  /** every account that dates the income pace's day — `through` is the earliest one's */
  accounts: string[];
}

/**
 * The last calendar month `through` reads to its END: its own month when it is that month's last day, else the month
 * before — `baselineWindow`'s end under his decision 71.
 *
 * ⚖️ His decision 71 (2026-10-13, asked as an either/or): an average uses only months EVERY account he spends from has
 * been read through to the end of. A month read to its 12th is not a twelfth of a measurement, it is none — the days
 * after it are days nobody has looked at, not days on which nothing was spent.
 */
export function lastFullyReadMonth(through: string): string {
  const own = monthKey(through);
  return periodBounds(through, "monthly").end === through ? own : monthKey(addCalendarMonths(`${own}-01`, -1));
}

/**
 * Why a spending window stops before the last complete month — "Aug 2026 and Sep 2026 are left out: Aug 12 is the last
 * day every account you spend from has been imported through." Null when it leaves nothing out.
 *
 * ⛔ ONE SENTENCE for every caption that names `baselineWindow` — the runway's, Eating out's, Subscriptions', the fees
 * and transfers cards' — in the words /spending's What-moved and the year summary already use for the same day
 * (`spendingCoverageThrough`), so the dashboard and those pages name one frontier one way.
 *
 * ⚠️ The day carries its year only when it is not the first left-out month's (`frontierDay`).
 */
export function unreadMonthsSentence(unread: UnreadMonths | null): string | null {
  return leftOutSentence(unread, "every account you spend from has");
}

/**
 * Why the INCOME pace stops before the last complete month — "Sep 2026 is left out: Sep 9 is the last day Robinhood
 * Cash has been imported through." — "both A and B have", "all of A, B, and C have" of several. Null when it leaves
 * nothing out.
 *
 * ⚖️ Default built, not asked (2026-10-23): his decision 71 carried to the income pace (`incomePaceMonths`), whose day
 * is the accounts its own rows land in (`incomeCoverage`), not the ones he spends from — and not every account his
 * income lands in, so they are named (`IncomeUnreadMonths`). ⛔ ONE SENTENCE with spending's (`unreadMonthsSentence`),
 * only whose day it is told apart: /recurring's pace row prints the two side by side, and two spellings of one rule are
 * how two figures' words drift.
 */
export function incomeUnreadMonthsSentence(unread: IncomeUnreadMonths | null): string | null {
  return leftOutSentence(unread, unread === null ? "" : accountsHave(unread.accounts));
}

/** "A and B", "A, B, and C" — the platform's list. */
const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * The accounts a day is the last one of, with their verb — "Robinhood Cash has", "both A and B have", "all of A, B,
 * and C have" (`incomeUnreadMonthsSentence`). With no name to give — never so built: the day is some named account's
 * — still only the pace's own accounts, never every account his income lands in.
 */
function accountsHave(names: readonly string[]): string {
  if (names.length === 0) return "every account Money in's pace reads has";
  if (names.length === 1) return `${names[0]!} has`;
  return `${names.length === 2 ? "both" : "all of"} ${AND_LIST.format(names)} have`;
}

/** The sentence both name a window's left-out months in, of `whoHas` — whose import day `unread.through` is. */
function leftOutSentence(unread: UnreadMonths | null, whoHas: string): string | null {
  if (unread === null || unread.months.length === 0) return null;
  const { months } = unread;
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const named =
    months.length === 1
      ? `${formatMonthYear(`${first}-01`)} is`
      : months.length === 2
        ? `${formatMonthYear(`${first}-01`)} and ${formatMonthYear(`${last}-01`)} are`
        : `${monthWindowLabel(first, last)} are`;
  return `${named} left out: ${frontierDay(unread)} is the last day ${whoHas} been imported through.`;
}

/**
 * The day that left a window's months out (`UnreadMonths.through`), as the sentence naming it spells it — "Aug 12"
 * (`unreadMonthsSentence`, `incomeUnreadMonthsSentence`). Where spending's frontier left one of Money in's months out
 * of spending's pace alone, Money in's sentence names no day for it (`incomePaceNote`): it follows spending's.
 *
 * ⚠️ It carries its year only when it is not the first left-out month's: the frontier falls inside that month or
 * before it (a stub month the window never counted), and the months beside it carry theirs.
 */
function frontierDay(unread: UnreadMonths): string {
  return formatDayShortIn(unread.through, `${unread.months[0]!}-01`);
}

/**
 * What /budgets' inline editor says of its guide's window — "6-mo avg ≈ $X", and under it, when the frontier slid the
 * window back, its months and why: "Averaged over 6 complete months, Feb 2026 to Jul 2026. Aug 2026 and Sep 2026 are
 * left out: Aug 12 is the last day every account you spend from has been imported through." Null when the window holds
 * no month: there is no guide to name.
 *
 * ⚖️ His decision 71 (2026-10-13) covers the guide as it covers the dashboard: it averages `baselineWindow`
 * (`budget-guide.ts`). Read as "the last six months", a window slid back to Feb–Jul beside an October would be the
 * dashboard caption's lie by omission, so it says what Eating out's caption says — `baselineSpan` and the runway's
 * sentence (`unreadMonthsSentence`). ⛔ The lead counts the window's OWN months: a young ledger's floor makes them
 * fewer than six, and "6-mo avg" over three would be a count the figure was not divided by.
 */
export function guideWindowWords(window: {
  months: number;
  fromMonth: string;
  toMonth: string;
  unread: UnreadMonths | null;
}): { lead: string; note: string | null } | null {
  const span = baselineSpan(window);
  if (span === null) return null;
  const unread = unreadMonthsSentence(window.unread);
  return { lead: `${window.months}-mo avg`, note: unread === null ? null : `Averaged over ${span}. ${unread}` };
}

/**
 * What /recurring's month forecast says of its spending pace when the frontier slid it back — "Spending's pace is
 * averaged over 3 complete months, May 2026 to Jul 2026. Aug 2026 and Sep 2026 are left out: Aug 12 is the last day
 * every account you spend from has been imported through." Null when it leaves nothing out.
 *
 * ⚖️ His decision 71 (2026-10-13) covers the pace's three months as it covers the dashboard's six (`paceMonths`). Its
 * math table reads "3-mo avg" beside an October, and a reader takes that for Jul–Sep; so where they are not, the card
 * names them and why, in `baselineSpan`'s and the runway's words (`unreadMonthsSentence`). ⚠️ "Spending's": the income
 * pace ends at its own day — every account its own rows land in (`incomePaceMonths`, default built 2026-10-23) — and
 * names its months, and those accounts, in a sentence of its own (`incomePaceNote`).
 *
 * ⛔ AND A PACE OF NO MONTH IS NOT A PACE OF NOTHING. Where the floor leaves the window no month (`averagedMonths`), the
 * card holds the pace row's figures back and says so in the runway caption's sentence (`emptyWindowCaption`).
 */
export function spendPaceNote(window: {
  months: number;
  fromMonth: string;
  toMonth: string;
  unread: UnreadMonths | null;
}): string | null {
  const span = baselineSpan(window);
  if (span === null) return emptyWindowCaption(window.unread);
  const unread = unreadMonthsSentence(window.unread);
  return unread === null ? null : `Spending's pace is averaged over ${span}. ${unread}`;
}

/**
 * The car's up-front money a spending average left out (`SpendBaseline.upfrontCarCents`, §6A 51), as a noun phrase —
 * or null when it left none out.
 *
 * ⛔ ONE PHRASE for every sentence that names it: the caption under the runway card (`baselineCaption`) and the
 * withheld verdict above it (`runway`), when that money is all the months counted hold. Two spellings of one amount on
 * one card is how a figure and its words drift.
 *
 * 🔴 A NET REFUND IS NOT MONEY PAID UP FRONT. The sum is the card's own (`isUpfrontCarRow`, either sign), so a window
 * holding a refund of the deposit and not the deposit — paid in an earlier month — is negative, and the caption read
 * "leaving out the -$1,100.00 paid up front for the car". It is named as the refund it is, and not dropped: the average
 * is then the plain one PLUS the refund ÷ the months, and a caption calling it "averaged over …" without saying so
 * would lie by omission exactly as it would over a payment.
 */
export function upfrontCarLeftOut(cents: number): string | null {
  if (cents === 0) return null;
  return cents > 0
    ? `the ${formatCents(cents)} paid up front for the car, which the car card spreads over the lease`
    : `the ${formatCents(-cents)} ${UPFRONT_REFUNDED} for the car, which the car card takes off what ` +
        "it spreads over the lease";
}

/**
 * A NET refund of the car's up-front money, in ONE phrase: the caption's noun (`upfrontCarLeftOut`) and the spend row's
 * term (`spendArithmeticCaption`). 🔴 The term read "+ $1,100.00 up-front refund" over the caption's "the $1,100.00
 * refunded of the money paid up front for the car" — one amount, two spellings, on one card (review of decision 61's
 * caption).
 */
const UPFRONT_REFUNDED = "refunded of the money paid up front";

/** The operands of a spending average, as the pages they come from print them — `spendArithmeticCaption`. */
export interface SpendArithmetic {
  /** SPENT on `/spending` for the window the average covers — gross money out (`cashFlowByPeriod`) */
  spentCents: number;
  /** REFUNDS on that page — money back in expense categories, never negative */
  refundsCents: number;
  /** the car's up-front money the average left out (`SpendBaseline.upfrontCarCents`), either sign */
  upfrontCarCents: number;
  /** the complete months the average divides by */
  months: number;
}

/**
 * The arithmetic under "What you spend a month": the window's SPENT, less what came back, less the car's up-front
 * money, over the months — "$56,444.55 spent − $888.62 back − $6,100.00 up front, over 6 months".
 *
 * ⚖️ His decision 61 (2026-10-12), asked as an either/or: the row keeps its link to the months it averaged, and its
 * arithmetic is captioned under it. Measured on his ledger copy that day: that /spending window prints SPENT $56,444.55
 * and REFUNDS +$888.62, the runway leaves out the $6,100.00 paid up front for the car (§6A 48/51/52), and
 * $49,455.93 ÷ 6 = $8,242.655 — the row's $8,242.66.
 *
 * ⛔ Operands, never a re-derived total: each is a figure a page prints — /spending its SPENT and REFUNDS, the car card
 * its up-front money — so the reader can find every one, and the sum divides to the row (`runwayCard`'s tests).
 * A term that is zero is dropped; SPENT never is, or the sentence would open on a minus. A NET refund of the up-front
 * money is ADDED: "back" holds it and the average does not (`isUpfrontCarRow`, either sign), so it is named as the
 * refund it is, in the caption's words (`UPFRONT_REFUNDED`) — never "− -$" (`upfrontCarLeftOut`'s 🔴). Null with no
 * complete month: there is nothing to divide.
 */
export function spendArithmeticCaption(a: SpendArithmetic): string | null {
  const { spentCents, refundsCents, upfrontCarCents, months } = a;
  if (months < 1) return null;
  const terms = [`${formatCents(spentCents)} spent`];
  if (refundsCents !== 0) terms.push(`− ${formatCents(refundsCents)} back`);
  if (upfrontCarCents > 0) terms.push(`− ${formatCents(upfrontCarCents)} up front`);
  // the caption's own words for it (`UPFRONT_REFUNDED`)
  if (upfrontCarCents < 0) terms.push(`+ ${formatCents(-upfrontCarCents)} ${UPFRONT_REFUNDED}`);
  return `${terms.join(" ")}, over ${monthCount(months)}`;
}

/**
 * "6 complete months", "1 complete month", "4 months" — a month count whose noun
 * agrees with it.
 *
 * 🔴 The eating-out and subscriptions captions printed `{months} complete
 * months` against `baselineWindow`'s own count, so a one-month window read
 * "Averaged over 1 complete months, Sep 2022" beside the runway card's "1
 * complete month". Measured on the owner's ledger replayed at today =
 * 2022-10-15. Months pluralise regularly; `countPhrase` is not borrowed for it.
 */
export function monthCount(months: number, adjective: string | null = null): string {
  return `${months} ${adjective === null ? "" : `${adjective} `}month${months === 1 ? "" : "s"}`;
}

/**
 * The phrase every caption uses to name `baselineWindow`: "6 complete months,
 * Mar 2026 to Aug 2026" — or null, because ⛔ ZERO MONTHS IS NOT A RANGE (see
 * `baselineCaption`). A card that gets null has no window to name and must say
 * so, or not render.
 *
 * 🔴 Two captions beside the runway card spelled it themselves, and at today =
 * 2022-09-10 on the owner's ledger read "Averaged over 0 complete months, Sep
 * 2022" over twenty-one purchases every one of which was in September 2022 —
 * the month the same sentence says it did not count.
 */
export function baselineSpan(window: { months: number; fromMonth: string; toMonth: string }): string | null {
  if (window.months < 1) return null;
  return `${monthCount(window.months, "complete")}, ${monthWindowLabel(window.fromMonth, window.toMonth)}`;
}

/**
 * A window of exactly `months` CALENDAR MONTHS opening on `from`.
 *
 * 🔴 IT CANNOT BE EXPRESSED AS A PAIR OF DATES, and that is the whole reason
 * this type exists. `addCalendarMonths("2026-08-29", 6)` is `2027-02-28`,
 * because 29 February 2027 does not exist — so a half-open `[from, to)` is a
 * day short of six whole months, and a bill anchored on the 28th loses its
 * sixth payment while the rate still divides by six. Five payments over a
 * six-month divisor: the same shape as every other defect in this file.
 *
 * ⛔ AND THE OBVIOUS FIX IS THE SAME DEFECT MIRRORED — measured, not guessed.
 * The recurring engine clamps too, so the series anchored on the 28th, 29th,
 * 30th AND 31st all project onto 2027-02-28. Making that day inclusive fixes
 * the 28th and hands the 29th and 30th a SEVENTH payment. No date cut can
 * separate four anchors that share a date.
 *
 * So membership is decided in MONTH SPACE, against the day the series is really
 * billed on rather than the day the calendar could fit:
 *
 *   - any month strictly before `endMonth` is inside;
 *   - inside `endMonth`, an occurrence is in iff its ANCHOR day-of-month is
 *     before `endDay` — the day-of-month the window opened on.
 *
 * That is exactly the date comparison whenever nothing clamps (the occurrence's
 * own day IS its anchor day), and it is the only thing that separates the four
 * when something does.
 */
export interface MonthHorizon {
  /** inclusive first day */
  from: string;
  /** whole calendar months spanned; the per-month denominator */
  months: number;
  /** "YYYY-MM" — the last month any occurrence can fall in */
  endMonth: string;
  /** the day-of-month the window opened on, and so ends BEFORE */
  endDay: number;
  /**
   * The last day occurrences must be PROJECTED to, so none inside the window is
   * missed. Always the end of `endMonth`: a clamped occurrence can land after
   * the nominal end and still be inside.
   */
  projectThrough: string;
  /**
   * `addCalendarMonths(from, months)`, kept for reporting only.
   * ⚠️ NOT the membership test — see the class docstring. It is what a reader
   * means by "six months from today" and it is what `CommittedOutflows.to`
   * publishes, but a day inside `endMonth` after it may still be in the window.
   */
  nominalEnd: string;
}

export function monthHorizon(from: string, months: number): MonthHorizon {
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`monthHorizon: months must be a positive integer, got ${months}`);
  }
  const nominalEnd = addCalendarMonths(from, months);
  const endMonth = monthKey(nominalEnd);
  return {
    from,
    months,
    endMonth,
    endDay: Number(from.slice(8, 10)),
    projectThrough: withDayOfMonth(`${endMonth}-01`, daysInMonthOf(`${endMonth}-01`)),
    nominalEnd,
  };
}

/**
 * Is one occurrence inside the horizon?
 *
 * `anchorDayOfMonth` is the day the series is really billed on — null for a
 * day-stepped cadence (weekly, biweekly), which never clamps, so the
 * occurrence's own day is the truth and the test degrades to the plain date
 * comparison.
 */
export function withinMonthHorizon(
  h: MonthHorizon,
  day: string,
  anchorDayOfMonth: number | null,
): boolean {
  if (day < h.from) return false;
  const month = monthKey(day);
  if (month < h.endMonth) return true;
  if (month > h.endMonth) return false;
  return (anchorDayOfMonth ?? Number(day.slice(8, 10))) < h.endDay;
}
