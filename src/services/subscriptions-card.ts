import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { recurringSeries, type Cadence } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, monthKey, todayIso } from "@/lib/dates";
import { formatDayShortIn } from "@/lib/format-date";
import { levelledMonthlyCents } from "@/lib/income-basis";
import { wholeToleranceDays } from "@/lib/recurring-step";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { activeTxnsInRange, isAgentsSeries } from "./analytics";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { COMMITTED_KINDS, SPEND_BASELINE_MONTHS, baselineWindow } from "./committed";
import {
  effectiveSeries,
  hasStoppedForecasting,
  rollForwardNextExpected,
  seriesStaleness,
} from "./recurring";

/**
 * What the recurring bills come to a month — and which of them the app has
 * quietly stopped forecasting because their evidence ran out.
 *
 * ## The measurement this card exists for
 *
 * Measured on the real ledger 2026-08-26, eleven money-out series carry a live
 * status (`detected`/`confirmed`). Five of them still forecast, at $991.59 a
 * month. The other six have lapsed — their newest posting is older than their
 * own tolerance — and `upcomingOccurrences` drops them, so $4,158.01 a month of
 * registered commitment is on the books and in no forecast at all.
 *
 * That number is not one story, and the card refuses to tell it as one. Three
 * of the six are genuinely dead (a ChatGPT bill 841 days quiet, a T-Mobile 777,
 * a YouTube Premium 796). One is a moved-out-of apartment. But two are one and
 * three days past tolerance respectively — and the larger of those two is the
 * RENT, $2,285.70 a month, whose only crime is that August's statement has not
 * been imported yet. Statement staleness is normal here; a card that called
 * that "dead" would be lying about the biggest bill on the ledger.
 *
 * So every lapsed line publishes `daysPastTolerance` alongside `lastMatchedOn`.
 * One is a rent that is late; seven hundred is a subscription that is over. The
 * reader can tell those apart from the row, and the card never has to invent a
 * band to tell them apart for him.
 *
 * ## ⛔ Not a second staleness rule
 *
 * `hasStoppedForecasting` — `seriesHasLapsed` + `lapsedSeriesShouldStopForecasting` — is EXACTLY the predicate
 * `upcomingOccurrences` filters on, called here rather than re-derived, so the
 * two cannot disagree about which series are being forecast — this card's whole
 * claim is a claim about what the forecast is doing. `seriesStaleness` supplies
 * the tolerance the rows are measured against, for the same reason.
 *
 * Note the pair, not `isSeriesActive`: that also calls a NEVER-posted series
 * inactive, and would have filed the $559.89 car lease and $361.49 insurance —
 * commitments the owner registered by hand, first payment 2026-09-11 — as dead.
 * They are the opposite of dead; they have simply never been billed, which is
 * its own disclosure and gets its own caveat.
 *
 * ## ⛔ Refunds NET, they are not filtered
 *
 * `postedCents` measures what these series actually took out of the accounts
 * over the baseline window. The obvious query is `WHERE amount_cents < 0`; it
 * is wrong, and this ledger has been bitten by it — pass 66 found twelve
 * inflows sitting in expense categories acting as silent negative expenses and
 * spending was understated $487.50 until they netted. A refunded subscription
 * charge is one event with two legs, and the legs belong in the same bucket
 * where they cancel. `activeTxnsInRange` is reused rather than re-queried so a
 * SPLIT recurring row contributes its parts the same way it does everywhere
 * else.
 *
 * ## ⛔ postedCents is a TOTAL, never divided
 *
 * It is deliberately not published as a monthly rate next to the forecast.
 * Measured over 2026-02 → 2026-07 the rent series posted $4,720.50 across three
 * charges, because the owner moved in halfway through the window — dividing
 * that by six would publish $786.75 a month for a $2,285.70 bill and invite the
 * reader to conclude the forecast is inflated. carCard states the same rule
 * about its own horizon: an average and a bill are different true numbers.
 */

/** The window `postedCents` measures, borrowed rather than re-picked. */
const POSTED_WINDOW_MONTHS = SPEND_BASELINE_MONTHS;

export interface SubscriptionLine {
  seriesId: string;
  name: string;
  cadence: Cadence;
  /** one charge, magnitude, user override first (`effectiveSeries`) */
  perOccurrenceCents: number;
  /** that charge levelled to a month — `weekly × 4` would lose a month a year */
  monthlyCents: number;
  /** newest matched charge; null = the bank has never billed this at all */
  lastMatchedOn: string | null;
  /**
   * The same day, spelled for a SENTENCE — "Aug 4", or "Jan 16, 2025" across a
   * year boundary. Null exactly when `lastMatchedOn` is.
   *
   * 🔴 The card printed "last seen 2026-08-04" nine times, while the card
   * BESIDE it on the same screen read "latest Sep 18, 2024 — 723 days ago" and
   * /recurring's shared rule said "last seen 68d ago" for the same fact. Three
   * spellings of one thing, two of them a click apart. `readableDay`'s line is
   * "for a sentence rather than a table cell", and "last seen …" is a sentence.
   */
  lastMatchedLabel: string | null;
  daysSinceLastMatch: number | null;
  /**
   * How far past its OWN tolerance the evidence is, in days. Null when the
   * series has not lapsed. One means a bill that is late; seven hundred means a
   * subscription that is over, and the card must not flatten the two.
   *
   * ⚖️ Counted on days the ledger has READ — to the day after the series' checked day, never past today
   * (`checkedDaysSinceLastMatch`), the day its lapse is measured to (§6A 57) — so it cannot grow between uploads.
   * 🔴 Counted to today, it grew a day each morning nothing was imported: "Amazon Prime · 47 days past tolerance" on
   * his ledger 2026-10-08, 107 by Dec 7, with no statement read past Sep 2 on its card.
   */
  daysPastTolerance: number | null;
  /** net money out inside the window, refunds netted (positive = money out) */
  postedCents: number;
  /** charges inside the window; a refund nets the money without counting one */
  postedCount: number;
  /** the bank has never billed it — a hand-registered commitment */
  neverBilled: boolean;
}

export interface SubscriptionsCard {
  /** levelled monthly total of the series the app is still forecasting */
  liveMonthlyCents: number;
  /** …and of the ones it has stopped forecasting because their evidence ran out */
  lapsedMonthlyCents: number;
  /** still forecast, largest first */
  live: SubscriptionLine[];
  /** no longer forecast, LONGEST quiet first — the dead ones lead */
  lapsed: SubscriptionLine[];
  /**
   * The lapsed share of everything registered.
   *
   * Not nullable, and that is load-bearing: the card returns null outright when
   * nothing is registered, so by the time this is computed the denominator is
   * proved non-zero. A `=== 0 ? null` ternary here would be dead code shaped
   * like a guard, which committed.ts already caught itself writing once — the
   * next edit trusts it and it protects nothing.
   */
  lapsedSharePct: number;
  /** of `liveMonthlyCents`, how much the bank has never actually billed */
  neverBilledMonthlyCents: number;
  /**
   * ⛔ Null when `liveMonthlyCents` is zero, which is a REACHABLE state: every
   * series can lapse at once, and then there is a lapsed total and nothing
   * live. `x / 0` is `Infinity` and renders as "Infinity% of it"; there is no
   * share of nothing, so the card says something else instead.
   */
  neverBilledSharePct: number | null;
  /** the loudest lapsed line, for the caveat sentence; null when none lapsed */
  largestLapsed: SubscriptionLine | null;
  /** net money out across every line above, inside the window, refunds netted */
  postedCents: number;
  postedCount: number;
  /**
   * Series with a live status that nothing can be levelled from: no expected
   * amount, or no expected date to step from. Either way `projectOccurrences`
   * emits nothing for them. Counted rather than dropped silently, because a
   * card that quietly loses a commitment is the failure this one exists to
   * report.
   */
  unforecastableCount: number;
  /**
   * Series whose commitment is OVER — a known `userEndsOn` already passed.
   *
   * ⛔ NOT `unforecastableCount`. An ended lease has an expected amount and an
   * expected date pattern; what it lacks is a FUTURE occurrence, and the card
   * says so in different words. Folding the two together made it claim Car
   * insurance ($361.49, monthly on the 11th) and Car lease ($695.04, monthly on
   * the 15th) had "no expected amount or no expected date".
   */
  endedCount: number;
  months: number;
  fromMonth: string;
  toMonth: string;
  today: string;
}

interface PostedTotals {
  cents: number;
  count: number;
}

/**
 * What each series actually took, netted and split-aware.
 *
 * The parent transaction's id is what carries `recurring_series_id`, and
 * `activeTxnsInRange` stamps every exploded split part with that same parent
 * id — so summing the parts recovers the parent's amount exactly once.
 */
function postedBySeries(db: AppDatabase, from: string, to: string): Map<string, PostedTotals> {
  const tagged = db
    .select({ id: transactions.id, seriesId: transactions.recurringSeriesId })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNotNull(transactions.recurringSeriesId),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  const seriesOf = new Map(tagged.map((t) => [t.id, t.seriesId as string]));

  const out = new Map<string, PostedTotals>();
  for (const txn of activeTxnsInRange(db, from, to)) {
    const seriesId = seriesOf.get(txn.id);
    if (seriesId === undefined) continue;
    const prev = out.get(seriesId) ?? { cents: 0, count: 0 };
    out.set(seriesId, {
      // ⛔ netting, not filtering — see the header note
      cents: prev.cents - txn.amountCents,
      // a refund is not a charge, so it nets the money without counting one
      count: prev.count + (txn.amountCents < 0 ? 1 : 0),
    });
  }
  return out;
}

export function subscriptionsCard(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = POSTED_WINDOW_MONTHS,
): SubscriptionsCard | null {
  const kinds = new Set<string>(COMMITTED_KINDS);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const rows = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all()
    // money OUT only. `COMMITTED_KINDS` rather than "everything but income":
    // a `transfer` series moves money between accounts the owner already holds,
    // so committing it here would count money that never leaves, and `other` is
    // the catch-all where a misread transfer lands. committed.ts states the
    // rule and measured what the looser filter cost.
    .filter((s) => kinds.has(s.kind))
    // ⚖️ …and HIS: no series on the agent's cash is his subscription, what it pays or what it is paid (`isAgentsSeries`,
    // owner decisions 2026-09-28 and 2026-10-02)
    .filter((s) => !isAgentsSeries(agentsCash, s));

  // a ledger with no recurring commitments has nothing to say here, and a card
  // of zeroes is worse than no card (the rule carCard already follows)
  if (rows.length === 0) return null;

  const currentMonth = monthKey(today);
  // the window runs from `currentMonth − months` to the last day before the
  // current month begins, so the incomplete current month is never read
  /*
   * ⛔ ONE WINDOW, ONE PLACE — `baselineWindow` floors this at the first month
   * the ledger covers in full. Building it from the constant alone let a young
   * ledger put two different windows in two captions on one dashboard.
   */
  const window = baselineWindow(db, today, months);
  const { fromMonth, toMonth } = window;
  const posted = postedBySeries(db, `${fromMonth}-01`, `${toMonth}-31`);

  const live: SubscriptionLine[] = [];
  const lapsed: SubscriptionLine[] = [];
  let unforecastableCount = 0;
  let endedCount = 0;
  // the day each series' accounts are read through — its lapse and its days past tolerance are measured there (§6A 57)
  const checkedOf = silenceMeasuredThroughBySeries(db, today);

  for (const s of rows) {
    const eff = effectiveSeries(s);
    if (eff.nextExpectedAmountCents === null) {
      unforecastableCount += 1;
      continue;
    }

    /*
     * A commitment that is OVER costs nothing going forward, and levelling a
     * monthly figure out of one would publish a bill that cannot happen.
     *
     * ⚠️ The end test used to be RIGHT HERE, and it was the only place that had
     * it: `rollForwardNextExpected` stepped from the anchor with no end test, so
     * this card was correct while /recurring's own "Next" column published a
     * date for a series whose occurrence list was empty. Two places had to
     * agree about a date and one did not, which is the defect pass 54 was
     * written to stop. The test now lives in the function, next to the anchor
     * arithmetic that needs it, and `null` here covers both reasons a series
     * has no next date: it never had one, or it is over.
     */
    const nextOn = rollForwardNextExpected(eff, today);
    if (nextOn === null) {
      /*
       * ⛔ Two different reasons wear one null, and they earn different
       * sentences. No stored date at all is unforecastable; a stored date the
       * series has outlived is ENDED — it has an amount and a rhythm, and only
       * the future is missing.
       */
      if (eff.nextExpectedOn === null) unforecastableCount += 1;
      else endedCount += 1;
      continue;
    }

    const checkedThrough = checkedOf(s.id);
    // "last charged" is the age to today (`daysSinceLastMatch`); late and lapsed are read-day claims
    const staleness = seriesStaleness(s, today, checkedThrough);
    const totals = posted.get(s.id) ?? { cents: 0, count: 0 };
    const line: SubscriptionLine = {
      seriesId: s.id,
      name: s.name,
      cadence: eff.cadence,
      perOccurrenceCents: Math.abs(eff.nextExpectedAmountCents),
      // `levelledMonthlyCents`, not amount × occurrences-in-a-month: the second
      // loses a month of a weekly series every year. income-basis owns the
      // table and the budgets header is already sized from it, so the two
      // figures on this dashboard speak the same units.
      monthlyCents: levelledMonthlyCents(Math.abs(eff.nextExpectedAmountCents), eff.cadence),
      lastMatchedOn: staleness.lastMatchedOn,
      lastMatchedLabel:
        staleness.lastMatchedOn === null ? null : formatDayShortIn(staleness.lastMatchedOn, today),
      daysSinceLastMatch: staleness.daysSinceLastMatch,
      daysPastTolerance: null,
      postedCents: totals.cents,
      postedCount: totals.count,
      // never billed is NOT lapsed: nothing has stopped, nothing ever started.
      // The car lease and its insurance live here.
      neverBilled: staleness.lastMatchedOn === null,
    };

    // exactly the pair `upcomingOccurrences` filters on, so this card's split
    // and the forecast's cannot disagree about which series are being projected
    const stopsForecasting = hasStoppedForecasting(s, today, checkedThrough);
    if (stopsForecasting) {
      lapsed.push({
        ...line,
        // a type narrowing, not a guard: `seriesHasLapsed` is false unless
        // `checkedDaysSinceLastMatch` is set — TypeScript cannot see that, the
        // arithmetic can
        daysPastTolerance:
          staleness.checkedDaysSinceLastMatch === null
            ? null
            : staleness.checkedDaysSinceLastMatch - wholeToleranceDays(staleness.toleranceDays),
      });
    } else {
      live.push(line);
    }
  }

  live.sort((a, b) => b.monthlyCents - a.monthlyCents || a.name.localeCompare(b.name));
  // the lapsed list leads with the LONGEST quiet, not the largest: how dead a
  // thing is is the question this half of the card answers
  lapsed.sort(
    (a, b) => (b.daysPastTolerance ?? 0) - (a.daysPastTolerance ?? 0) || b.monthlyCents - a.monthlyCents,
  );

  const liveMonthlyCents = live.reduce((sum, l) => sum + l.monthlyCents, 0);
  const lapsedMonthlyCents = lapsed.reduce((sum, l) => sum + l.monthlyCents, 0);
  const registeredCents = liveMonthlyCents + lapsedMonthlyCents;

  // every series is over, unforecastable, or worth nothing a month — there is no
  // figure to headline, and a card of zeroes is worse than no card
  if (registeredCents === 0) return null;

  const neverBilledMonthlyCents = live
    .filter((l) => l.neverBilled)
    .reduce((sum, l) => sum + l.monthlyCents, 0);

  const all = [...live, ...lapsed];
  // the loudest lapsed line by MONEY — the caveat sentence names it, and the
  // reader cares which bill went quiet before he cares which went quiet longest
  const largestLapsed =
    lapsed.length === 0
      ? null
      : lapsed.reduce((worst, l) => (l.monthlyCents > worst.monthlyCents ? l : worst));

  return {
    liveMonthlyCents,
    lapsedMonthlyCents,
    live,
    lapsed,
    // safe by the early return above, never by a ternary here
    lapsedSharePct: (lapsedMonthlyCents / registeredCents) * 100,
    neverBilledMonthlyCents,
    neverBilledSharePct:
      liveMonthlyCents === 0 ? null : (neverBilledMonthlyCents / liveMonthlyCents) * 100,
    largestLapsed,
    postedCents: all.reduce((sum, l) => sum + l.postedCents, 0),
    postedCount: all.reduce((sum, l) => sum + l.postedCount, 0),
    unforecastableCount,
    endedCount,
    // the window's OWN month count, which the ledger may have shortened
    months: window.months,
    fromMonth,
    toMonth,
    today,
  };
}
