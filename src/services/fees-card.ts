import type { AppDatabase } from "@/db/client";
import { addCalendarMonths, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { monthCount } from "@/lib/committed";
import { formatMonthYear, monthWindowLabel } from "@/lib/format-date";
import { ledgerHref } from "@/lib/ledger-href";
import { formatCents } from "@/lib/money";
import { resolvePeriod, withPeriod } from "@/lib/period";
import { activeTxnsInRange, loadCategoryIndex, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { baselineWindow, SPEND_BASELINE_MONTHS } from "./committed";
import { provenanceFor, type Provenance } from "./provenance";

/**
 * What the banks charge you, and what they pay you back.
 *
 * Two totals that the dashboard otherwise never puts beside each other: the
 * `Fees` expense taxonomy, and the `Income > Interest` bucket. Apart they are
 * both rounding errors on a $8k month. Together they answer a question with a
 * direction — is the banking relationship costing you money or making you
 * money — and measured on the real ledger the answer changes depending on how
 * far back you look, which is the entire reason this card publishes two
 * windows instead of one.
 *
 * ## 🔴 Both halves, and the card does not get to pick
 *
 * Measured 2026-08-27 (`scripts/probe-fees-card.ts`):
 *
 *  - **all time** — $1,426.39 paid in fees against $2,439.68 of interest
 *    earned. The banks are $1,013.29 ahead of the ledger, in his favour.
 *  - **the 6 complete months 2026-02 → 2026-07** — $617.14 paid against
 *    $27.21 earned. That is $589.93 the other way.
 *
 * Publishing only the first would be a card that congratulates him on a
 * savings balance he no longer has; publishing only the second would hide that
 * the banks have, on balance, paid for themselves. So the headline states the
 * RECENT figure — the one that is still true — and the sentence directly under
 * it states the all-time one, with the word "other way" computed from the two
 * signs rather than written into the template. If the reversal ever unwinds the
 * sentence says so on its own.
 *
 * ## ⛔ The fee categories are RESOLVED, never matched by name
 *
 * `WHERE name LIKE '%Fee%'` is the obvious query and on this ledger it is
 * wrong by $571.64: `Coffee` matches it, and the total goes from $1,426.39 to
 * $1,998.03 — a card about bank charges reporting a fifth of the eating-out
 * habit. The top-level `Fees` node is found by exact name and parentage and
 * everything under it comes from `subtreeIds`, which is `loadCategoryIndex`'s
 * job and not this module's.
 *
 * ## 🔴 Interest is INCOME, so its sign runs the other way
 *
 * A fee is an expense row and lands NEGATIVE; interest is an income row and
 * lands POSITIVE. Both are published here as positive magnitudes of money that
 * MOVED, so `paidCents` negates and `earnedCents` does not — and `netCents` is
 * signed from the reader's side: **positive means the banks paid you more than
 * you paid them.** That convention is stated on the type and again on the card,
 * because "net fees" is a phrase that could reasonably mean either direction.
 *
 * ## ⛔ Refunds and clawbacks NET, they are not filtered
 *
 * Neither side filters on sign. A refunded fee is one event with two legs and
 * the legs cancel — the ledger was understated $487.50 by exactly the opposite
 * habit before pass 66 netted expense inflows. The mirror holds for interest: a
 * clawback is the bank taking back interest it credited, so it reduces what
 * they paid you rather than being dropped as "not income".
 *
 * ⚠️ That is deliberately NOT `incomeByMonth`'s convention, which keeps only
 * `amountCents > 0` because it is drawing an income chart where a reversal is
 * not a bar. This card is measuring a relationship's balance, where it is. The
 * disagreement is disclosed rather than hidden, and it is one row's worth on
 * this ledger: measured 2026-08-27 all 68 interest rows are positive and all 77
 * fee rows are negative, so netting and filtering agree today and would stop
 * agreeing the first time a bank reverses anything.
 *
 * `activeTxnsInRange` is reused rather than re-queried so SPLITS expand the
 * same way they do everywhere else.
 *
 * ## ⛔ Where this sits next to `CardsOwedCard`
 *
 * `cardsOwedCard` already publishes a fee total under "what they cost", and the
 * two must not be read as the same number. Its scope is **active credit cards,
 * all time**, and it holds `Interest Charges` OUT of its fee figure so that
 * "fees" and "interest charged" name disjoint money on a card about cards. This
 * one's scope is **every account, over a stated window**, and its `paidCents` is
 * the whole `Fees` subtree including `Interest Charges` — because interest a
 * bank charges you is money you paid a bank, which is this card's question.
 *
 * That makes this card's all-time figure a strict superset of that one's, never
 * a competing measurement of the same set. It is also why the window is said out
 * loud in the headline noun: measured 2026-08-27 `cardsOwedCard` publishes
 * $618.63 (cards, all time) and this card's recent window is $617.14 (every
 * account, six months) — a $1.49 gap between two numbers that mean entirely
 * different things, on one screen. Neither is wrong; a reader who thinks they
 * are the same number is.
 *
 * ⚠️ The category resolution below is the same rule as `cardsOwedCard`'s
 * module-private `feeCategories`, minus the interest-charge subtraction, and it
 * is written twice only because that one is private and its file is in flight.
 * Exporting it and taking the subtraction as a flag is a one-line follow-up —
 * the same seam `movers-card`'s `ledgerOpens` records.
 *
 * ## Windows
 *
 * The recent window is `SPEND_BASELINE_MONTHS` complete months, imported rather
 * than re-picked: the runway card, the eating-out card and the movers card all
 * publish "6 complete months" on the same screen, and a fourth window would be
 * a contradiction the reader has to resolve. The current month is excluded
 * rather than prorated. "All time" runs from the earliest fee-or-interest row
 * to today, and that first day is printed so the span is never guessed at.
 */

/** The ledger's own name for the top of the fee taxonomy. */
const FEES_CATEGORY = "Fees";
/** …and for the income bucket that is its mirror. */
const INCOME_CATEGORY = "Income";
const INTEREST_CATEGORY = "Interest";

/**
 * The lower bound of "all time" — below any date the ledger can hold, so the
 * window is the ledger's own span rather than a horizon this module picked.
 */
const LEDGER_FLOOR = "0000-01-01";

/**
 * ⛔ `Math.round(-0.4)` is `-0`, and `formatCents(-0)` renders "-$0.00".
 *
 * A live hazard rather than a formality: every monthly rate here divides a
 * signed total (a window whose fees were net-refunded has a NEGATIVE one) by a
 * month count. It hides, too — `-0 + 0 === 0` leaves every sum correct while
 * one cell prints a minus sign it does not have. This shipped to this dashboard
 * once and only looking at the page found it.
 */
function cents(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/** Which direction the money ran, from the reader's side. */
export type FeeDirection = "ahead" | "behind" | "level";

export interface FeeLine {
  categoryId: string;
  /** the ledger's own name for this bucket, never a name this module invents */
  name: string;
  /** positive = money out to a bank; refunds already netted */
  cents: number;
  /** charges only — a refund is a reversal, not a second event */
  charges: number;
  /**
   * Rows filed on the `Fees` parent itself rather than under any child. Not a
   * kind of fee: a bucket the ledger has not said anything about yet.
   */
  isUnfiled: boolean;
  /** why this row should not be leaned on — null when there is nothing to say */
  note: string | null;
  /** the drill-down that lists exactly the rows behind `cents` */
  href: string;
}

export interface FeeWindow {
  /** inclusive ISO bounds, so the reader can check the arithmetic */
  from: string;
  to: string;
  /** money out to banks, positive, refunds netted — NAMED fee buckets only */
  paidCents: number;
  /**
   * Rows filed on the `Fees` parent itself, which the app has not identified as
   * anything. Deliberately NOT added to `paidCents` — see `feeCategories`.
   */
  unclassifiedCents: number;
  unclassifiedRows: number;
  /** credits (fee reversals) filed on Fees itself — counted apart, never as charges */
  unclassifiedCredits: number;
  /** how many fee CHARGES — refunds do not count as events */
  paidCharges: number;
  /** money in from banks, positive, clawbacks netted */
  earnedCents: number;
  /** how many interest CREDITS — clawbacks do not count as events */
  earnedCredits: number;
  /** every row on either side, so an empty window can be told from a level one */
  rowCount: number;
  /** ⛔ `earned − paid`. POSITIVE = the banks paid you more than you paid them. */
  netCents: number;
  direction: FeeDirection;
  /**
   * What they paid you for every dollar you paid them, in cents.
   *
   * ⛔ Null when nothing was paid TO them. `x / 0` is `Infinity` and would
   * render "$Infinity back for every $1"; a window with no fees has no ratio to
   * publish and the card says something else. A window whose fees were net
   * REFUNDED is null for the same reason it is null in `MoverLine.pctOfUsual`:
   * a negative denominator divides cleanly and comes out with the wrong sign.
   */
  earnedPerDollarCents: number | null;
}

export interface FeesCard {
  /** which window the headline describes — "recent" unless it holds no rows */
  basis: "recent" | "allTime";
  /** "$589.93", or "Level" when the two sides matched exactly */
  headline: string;
  headlineNoun: string;
  direction: FeeDirection;
  /** both windows in one sentence, so neither can be quoted without the other */
  summary: string;

  recent: FeeWindow;
  allTime: FeeWindow;
  /** the month the all-time window opens in, as the card prints it — "Dec 2022" */
  allTimeFromLabel: string;
  /** how many complete months `recent` covers */
  months: number;
  fromMonth: string;
  toMonth: string;

  /** the recent window's fee buckets, biggest first */
  lines: FeeLine[];
  /** money out, per month, across the recent window */
  paidMonthlyCents: number;
  /** money in, per month, across the recent window */
  earnedMonthlyCents: number;
  /** the interest rows' own drill-down — null when there is no interest bucket */
  interestHref: string | null;
  /**
   * `/spending` over the window the HEADLINE measured — `recent`, or `allTime`
   * when that is the basis — for the card's header link.
   *
   * 🔴 It was a bare `/spending`, which `resolvePeriod` resolves to the RUNNING
   * month, a month neither window here reads whole. Measured on the owner's
   * ledger 2026-09-15: the headline read "more in fees than interest, over the
   * 6 months to Aug 2026" (Mar 1 – Aug 31, 2026), and the link opened September
   * 2026, where the page refuses any comparison ("There is no comparison for
   * September 2026 yet: …").
   */
  spendingHref: string;

  /**
   * ⛔ EMPTY IS NOT MISSING. A ledger whose `Interest` bucket exists and holds
   * nothing has been checked and the answer is no; a ledger with no such bucket
   * has not been checked at all. The two get different sentences, and neither
   * gets the word "unchecked" when the truth is "empty".
   */
  earnedNote: string | null;
  /** rows the ledger files as `Fees` without saying what kind — null when none */
  unfiledNote: string | null;
  /** why the interest half is smaller than it was — null when it is not */
  interestTrendNote: string | null;
  /**
   * What a dollar of fees bought back, both windows in one clause.
   *
   * ⛔ Written here rather than in the component precisely because it has three
   * shapes and two division guards. A component branching on which halves are
   * null is a component computing, and the branch that says "$Infinity back"
   * is the one nobody writes a test for.
   */
  ratioNote: string | null;

  /** what the recent fee total is standing on */
  paidProvenance: Provenance | null;
  today: string;
}

interface FeeCategories {
  /** the whole `Fees` subtree, the parent node included */
  feeIds: Set<string>;
  feesTopId: string;
  /** null when this ledger has no interest bucket at all — NOT the same as empty */
  interestIds: Set<string> | null;
  interestTopId: string | null;
}

/**
 * The two taxonomies, resolved by identity.
 *
 * ⛔ Never a name match. `/fee/i` catches `Coffee`, and it is not a hypothetical:
 * measured on the real ledger it adds $571.64 of espresso to a bank-fee total
 * of $1,426.39.
 */
function feeCategories(idx: CategoryIndex): FeeCategories | null {
  const top = [...idx.byId.values()].find((c) => c.parentId === null && c.name === FEES_CATEGORY);
  if (!top) return null;

  const income = [...idx.byId.values()].find((c) => c.parentId === null && c.name === INCOME_CATEGORY);
  const interestTop = income
    ? ([...idx.byId.values()].find((c) => c.parentId === income.id && c.name === INTEREST_CATEGORY) ?? null)
    : null;

  return {
    /**
     * ⛔ The NAMED children only — `ATM Fees`, `Bank Fees`, `Card Annual Fees`,
     * `Interest Charges`. Rows filed directly on the `Fees` PARENT are not fees
     * the app has identified; they are rows nobody has classified, and on the
     * real ledger they are mostly not bank charges at all.
     *
     * Measured 2026-08-27, the catch-all held $309.00 of which **$0.15** was
     * genuinely a bank fee: $302.00 is a New York State income tax payment,
     * $5.16 a Canadian immigration charge, $1.69 the processor's fee for
     * paying that tax. Counting the parent put a $302 tax bill inside "what the
     * banks charge you" and nearly doubled the recent total.
     *
     * ⚠️ The ledger has NO `Taxes` category, which is why that row is here at
     * all. Until it does, the honest move is to disclose the bucket rather than
     * assert what is in it.
     */
    feeIds: new Set([...idx.subtreeIds(top.id)].filter((id) => id !== top.id)),
    feesTopId: top.id,
    interestIds: interestTop === null ? null : new Set(idx.subtreeIds(interestTop.id)),
    interestTopId: interestTop?.id ?? null,
  };
}

/**
 * The last day of a month key. `periodBounds` owns the calendar, not this — a
 * second implementation of "when does a month end" is exactly the kind of
 * duplicate definition that lets two surfaces disagree about February.
 */
function lastDayOf(month: string): string {
  return periodBounds(`${month}-01`, "monthly").end;
}

function windowOf(
  rows: readonly AnalyticsTxn[],
  cats: FeeCategories,
  from: string,
  to: string,
): FeeWindow {
  const inWindow = rows.filter((t) => t.postedOn >= from && t.postedOn <= to);
  const fees = inWindow.filter((t) => t.categoryId !== null && cats.feeIds.has(t.categoryId));
  // sitting on the parent, identified as nothing — counted apart and disclosed
  const unclassified = inWindow.filter((t) => t.categoryId === cats.feesTopId);
  // ⛔ narrowed through a local, not a `!`. An empty interest side and an absent
  // one are different answers here, and the type is the only thing keeping them
  // apart — an assertion would let a later edit read `null` as "none".
  const interestIds = cats.interestIds;
  const interest = interestIds
    ? inWindow.filter((t) => t.categoryId !== null && interestIds.has(t.categoryId))
    : [];

  // ⛔ netting, not filtering, on BOTH sides — see the header note
  const paidCents = fees.reduce((s, t) => s - t.amountCents, 0);
  const earnedCents = interest.reduce((s, t) => s + t.amountCents, 0);
  const netCents = earnedCents - paidCents;

  return {
    from,
    to,
    paidCents,
    unclassifiedCents: unclassified.reduce((sum, t) => sum - t.amountCents, 0),
    unclassifiedRows: unclassified.filter((t) => t.amountCents < 0).length,
    unclassifiedCredits: unclassified.filter((t) => t.amountCents > 0).length,
    paidCharges: fees.filter((t) => t.amountCents < 0).length,
    earnedCents,
    earnedCredits: interest.filter((t) => t.amountCents > 0).length,
    rowCount: fees.length + interest.length + unclassified.length,
    netCents,
    direction: netCents === 0 ? "level" : netCents > 0 ? "ahead" : "behind",
    earnedPerDollarCents: paidCents > 0 ? cents((earnedCents / paidCents) * 100) : null,
  };
}

/** "…, so you are $1,013.29 up on them." — one clause, both signs handled. */
function standingClause(w: FeeWindow): string {
  if (w.direction === "level") return "the two sides matched exactly";
  const amount = formatCents(Math.abs(w.netCents));
  return w.direction === "ahead" ? `you are ${amount} up on them` : `you are ${amount} down on them`;
}

/**
 * What the banks charge, and what they pay.
 *
 * Returns null when the ledger cannot answer, which is two different absences:
 * there is no `Fees` taxonomy to read at all, or there is one and neither it
 * nor the interest bucket has ever held a row. A card of zeroes is worse than
 * no card.
 */
export function feesCard(db: AppDatabase, today: string = todayIso()): FeesCard | null {
  const idx = loadCategoryIndex(db);
  const cats = feeCategories(idx);
  if (!cats) return null;

  const currentMonth = monthKey(today);
  // the window runs to the last day BEFORE the current month begins, so the
  // incomplete current month is never read — the runway card's own convention
  /*
   * ⛔ ONE WINDOW, ONE PLACE — `baselineWindow` floors this at the first month
   * the ledger covers in full. Building it from the constant alone let a young
   * ledger put two different windows in two captions on one dashboard.
   */
  const window = baselineWindow(db, today, SPEND_BASELINE_MONTHS);
  /*
   * ⛔ ZERO MONTHS IS NOT A WINDOW: with no complete month `baselineWindow`
   * falls back to the CURRENT month, and the "recent" half below would be this
   * month's running rows under sentences about complete months.
   */
  if (window.months < 1) return null;
  /*
   * 🔴 THE WINDOW'S OWN MONTHS, not the constant. The rows were read over
   * `window` and the count, the rates and every sentence used
   * `SPEND_BASELINE_MONTHS`. Replayed on the owner's ledger at today =
   * 2023-01-15 (window Sep–Dec 2022, `months` field 4): "$0.62 went out in fees
   * over the 6 complete months Sep 2022 to Dec 2022", headline "over the 6
   * months to Dec 2022", and $0.10 a month where the four months make it $0.16.
   */
  const months = window.months;
  const { fromMonth, toMonth } = window;
  const recentFrom = `${fromMonth}-01`;
  const recentTo = lastDayOf(toMonth);

  /*
   * One load, widest bound: everything the ledger holds up to today. The
   * all-time window is the point of the card, so there is no narrower read that
   * would answer it, and slicing in memory keeps the two windows provably built
   * from one row set rather than from two queries that could disagree.
   */
  const rows = activeTxnsInRange(db, LEDGER_FLOOR, today).filter(
    (t) =>
      t.categoryId !== null &&
      // ⚠️ the catch-all PARENT is admitted here and excluded from `paidCents`
      // inside `windowOf`. Filtering it out at this step instead would make the
      // card silently unable to disclose it — the rows would never arrive.
      (t.categoryId === cats.feesTopId ||
        cats.feeIds.has(t.categoryId) ||
        (cats.interestIds?.has(t.categoryId) ?? false)),
  );
  // an empty bucket is an answer; an empty LEDGER is not a card
  if (rows.length === 0) return null;

  const firstOn = rows.map((t) => t.postedOn).sort()[0]!;
  const allTime = windowOf(rows, cats, firstOn, today);
  const recent = windowOf(rows, cats, recentFrom, recentTo);

  /* ── the recent window's buckets, by the ledger's own children ────────── */
  const byCategory = new Map<string, FeeLine>();
  for (const t of rows) {
    if (t.postedOn < recentFrom || t.postedOn > recentTo) continue;
    // the catch-all IS listed — it is money out and the reader should see it —
    // it simply does not count toward the "what the banks charge you" total
    if (t.categoryId === null || !(cats.feeIds.has(t.categoryId) || t.categoryId === cats.feesTopId)) continue;
    const node = idx.byId.get(t.categoryId)!;
    const isUnfiled = node.id === cats.feesTopId;
    const line = byCategory.get(node.id) ?? {
      categoryId: node.id,
      name: node.name,
      cents: 0,
      charges: 0,
      isUnfiled,
      /**
       * ⛔ Listed, but NOT counted in `paidCents` — and the distinction is the
       * whole point of the row.
       *
       * These are real money out, so hiding them would be worse. But the card's
       * claim is "what the BANKS charge you", and measured 2026-08-27 this
       * bucket held $309.00 of which **$0.15** was a bank fee: $302.00 is a New
       * York State income tax payment, $5.16 a Canadian immigration charge,
       * $1.69 the processor's fee for paying the tax. Counting them nearly
       * doubled the recent total and put a tax bill inside a sentence about
       * banks.
       *
       * ⚠️ Not a reclassification either — the ledger has no `Taxes` category,
       * which is why the row is here at all. The honest position is to show the
       * money, name what the ledger says about it (nothing), and leave the
       * total making only the claim it can support.
       */
      note: isUnfiled ? "not counted — no kind given" : null,
      href: ledgerHref({ category: node.id, from: recentFrom, to: recentTo }),
    };
    byCategory.set(node.id, {
      ...line,
      cents: line.cents - t.amountCents,
      charges: line.charges + (t.amountCents < 0 ? 1 : 0),
    });
  }

  const lines = [...byCategory.values()]
    // a bucket with nothing in it is an absence, not a row reading "$0.00"
    .filter((l) => l.charges > 0 || l.cents !== 0)
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));

  /* ── the notes ───────────────────────────────────────────────────────── */
  const unfiledRows = rows.filter(
    (t) => t.postedOn >= recentFrom && t.postedOn <= recentTo && t.categoryId === cats.feesTopId,
  );
  const largestOf = (list: typeof rows) =>
    [...list].filter((t) => t.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents)[0];
  /** "2 charges", "1 charge and 1 credit", "1 credit" — a reversal is never counted as a charge */
  const rowsPhrase = (charges: number, credits: number): string =>
    [
      charges > 0 ? `${charges} ${charges === 1 ? "charge" : "charges"}` : null,
      credits > 0 ? `${credits} ${credits === 1 ? "credit" : "credits"}` : null,
    ]
      .filter((p) => p !== null)
      .join(" and ");
  const largestUnfiled = largestOf(unfiledRows);
  const recentCharges = unfiledRows.filter((t) => t.amountCents < 0).length;
  const recentCredits = unfiledRows.filter((t) => t.amountCents > 0).length;
  const recentOne = recentCharges + recentCredits === 1;
  const recentUnfiledNote =
    largestUnfiled === undefined
      ? null
      : `${rowsPhrase(recentCharges, recentCredits)} ${recentOne ? "is" : "are"} filed on Fees itself rather than as a kind of fee, so the ledger has not said what ${recentOne ? "it is" : "they are"}. The largest ${recentCredits > 0 ? "charge " : ""}is ${formatCents(-largestUnfiled.amountCents)} — “${largestUnfiled.rawDescription}”.`;
  /*
   * 🔴 THE ALL-TIME HALF LEFT ROWS OUT AND SAID NOTHING. The sentence above
   * reads the RECENT window only, but the all-time figures exclude parent rows
   * too — measured 2026-09-14, "Paid to them 70 charges $996.64" all time over a
   * Fees category holding $996.79: a $0.15 "FOREIGN EXCHANGE RATE ADJUSTMENT FEE"
   * filed on Fees itself, dated outside the recent window, missing from a figure
   * with no footnote. The windows' own unclassified fields are the rule — the
   * same bounds as their totals — so a row outside the recent window, at either
   * end or on today, is told against the window whose figure it is missing from.
   */
  const allTimeLabel = formatMonthYear(firstOn);
  const allTimeDiffers =
    allTime.unclassifiedRows !== recent.unclassifiedRows ||
    allTime.unclassifiedCredits !== recent.unclassifiedCredits ||
    allTime.unclassifiedCents !== recent.unclassifiedCents;
  /*
   * ⛔ The count and the total must describe the SAME rows. `unclassifiedCents`
   * nets credits while the count was charges alone, so a $5.00 fee and its
   * reversal read "1 charge totalling $0.00", a lone reversal "0 charges are
   * filed…", and a reversal outside the window "1 charge totalling -$5.34"
   * (second reader, 2026-09-14). Charges and credits are named apart, and a
   * net is called a net.
   */
  const n = allTime.unclassifiedRows;
  const c = allTime.unclassifiedCredits;
  const allTimeOne = n + c === 1;
  const net = allTime.unclassifiedCents;
  const amountPhrase =
    c === 0
      ? `totalling ${formatCents(net)}`
      : net > 0
        ? `netting ${formatCents(net)} paid`
        : net < 0
          ? `netting ${formatCents(-net)} back`
          : "netting to nothing";
  const largestEver = largestOf(rows.filter((t) => t.categoryId === cats.feesTopId));
  const allTimeUnfiledNote = !allTimeDiffers
    ? null
    : recentUnfiledNote !== null
      ? `Since ${allTimeLabel}, ${rowsPhrase(n, c)} ${amountPhrase} ${allTimeOne ? "is" : "are"} filed there, and none of it is in the all-time figures either.`
      : `Since ${allTimeLabel}, ${rowsPhrase(n, c)} ${allTimeOne ? "is" : "are"} filed on Fees itself rather than as a kind of fee, and ${allTimeOne ? "it is" : "they are"} not in the all-time figures.` +
        (largestEver === undefined ? "" : ` The largest ${c > 0 ? "charge " : ""}is ${formatCents(-largestEver.amountCents)} — “${largestEver.rawDescription}”.`);
  const unfiledNote = [recentUnfiledNote, allTimeUnfiledNote].filter((s) => s !== null).join(" ") || null;

  /*
   * ⛔ EMPTY IS NOT MISSING, and this is where the distinction bites: a ledger
   * with no interest bucket has never been asked the question, while one whose
   * bucket is empty has been asked and the answer is no. Saying "unchecked" of
   * the second, or "none" of the first, is the error three services here have
   * already made.
   */
  const earnedNote =
    cats.interestIds === null
      ? "This ledger has no interest bucket, so nothing here has looked for interest paid to you."
      : allTime.earnedCredits === 0 && allTime.earnedCents === 0
        ? "No bank has ever paid you interest — the bucket exists and it is empty."
        : null;

  /*
   * Why the recent half is small. A monthly rate against the single best month
   * the ledger has ever recorded — a max over months already loaded, not a new
   * window — and withheld unless that peak is genuinely BEHIND this window and
   * genuinely above it. Otherwise the note would announce a fall that is either
   * inside the period it claims to explain, or not a fall at all.
   */
  const interestByMonth = new Map<string, number>();
  if (cats.interestIds) {
    for (const t of rows) {
      if (t.categoryId === null || !cats.interestIds.has(t.categoryId)) continue;
      const m = monthKey(t.postedOn);
      interestByMonth.set(m, (interestByMonth.get(m) ?? 0) + t.amountCents);
    }
  }
  const best = [...interestByMonth.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const earnedMonthlyCents = cents(recent.earnedCents / months);
  const paidMonthlyCents = cents(recent.paidCents / months);
  const interestTrendNote =
    best === undefined || best[0] >= fromMonth || best[1] <= earnedMonthlyCents
      ? null
      : `Interest is not what it was: ${formatCents(best[1])} in its best month, ${formatMonthYear(`${best[0]}-01`)}, against ${formatCents(earnedMonthlyCents)} a month across the ${months} here.`;

  /*
   * ⛔ Both guards live here, in one place. `earnedPerDollarCents` is already
   * null when its window paid nothing — this only decides which sentence is
   * left to write, and writes none at all when neither window has a ratio.
   */
  const ratioNote =
    allTime.earnedPerDollarCents === null
      ? null
      : recent.earnedPerDollarCents === null
        ? `Across the whole ledger they have paid you ${formatCents(allTime.earnedPerDollarCents)} for every $1 you paid them; over the ${monthCount(months)} here you paid them nothing at all.`
        : `${formatCents(recent.earnedPerDollarCents)} back for every $1 in fees over ${months === 1 ? "that 1 month" : `these ${months} months`}, against ${formatCents(allTime.earnedPerDollarCents)} across the whole ledger.`;

  /* ── the headline, and which window it describes ─────────────────────── */
  const basis = recent.rowCount === 0 ? "allTime" : "recent";
  const shown = basis === "recent" ? recent : allTime;
  const toLabel = formatMonthYear(`${toMonth}-01`);
  const windowLabel = monthWindowLabel(fromMonth, toMonth);
  const spanLabel =
    basis === "recent" ? `over the ${monthCount(months)} to ${toLabel}` : `since ${formatMonthYear(firstOn)}`;

  const headlineNoun =
    shown.direction === "level"
      ? spanLabel
      : shown.direction === "behind"
        ? `more in fees than interest, ${spanLabel}`
        : `more in interest than fees, ${spanLabel}`;

  /*
   * "the other way" is COMPUTED, never templated. The reversal is what makes
   * this card worth drawing today, and a sentence that asserts it would keep
   * asserting it after it unwound.
   */
  const comparable = recent.direction !== "level" && allTime.direction !== "level";
  const reversed = comparable && recent.direction !== allTime.direction;
  const allTimeLead =
    basis === "allTime"
      ? `Nothing at all has been charged or paid in the last ${monthCount(months, "complete")}.`
      : !comparable
        ? // ⛔ a window that came out exactly level runs neither the same way nor
          // the other way, and claiming either would be the card asserting a
          // direction it just measured the absence of
          "All time:"
        : reversed
          ? "All time it runs the other way:"
          : "All time it reads the same way:";

  const summary =
    basis === "allTime"
      ? `${allTimeLead} From ${formatMonthYear(firstOn)} the ledger holds ${formatCents(allTime.paidCents)} of fees against ${formatCents(allTime.earnedCents)} of interest, so ${standingClause(allTime)}.`
      : `${formatCents(recent.paidCents)} went out in fees over the ${monthCount(months, "complete")} ${windowLabel}, across every account, against ${formatCents(recent.earnedCents)} of interest back. ${allTimeLead} from ${formatMonthYear(firstOn)} the ledger holds ${formatCents(allTime.earnedCents)} of interest against ${formatCents(allTime.paidCents)} of fees, so ${standingClause(allTime)}.`;

  return {
    basis,
    headline: shown.direction === "level" ? "Level" : formatCents(Math.abs(shown.netCents)),
    headlineNoun,
    direction: shown.direction,
    summary,

    recent,
    allTime,
    allTimeFromLabel: formatMonthYear(firstOn),
    // the window's OWN month count, which the ledger may have shortened
    months: window.months,
    fromMonth,
    toMonth,

    lines,
    paidMonthlyCents,
    earnedMonthlyCents,
    /*
     * ⛔ Null rather than a link to all money in. A drill-down promises to list
     * exactly the rows behind the figure beside it; over a ledger with no
     * interest bucket there are none, and "every credit you have ever received"
     * is a different question wearing this one's label.
     */
    interestHref:
      cats.interestTopId === null
        ? null
        : ledgerHref({ category: cats.interestTopId, from: recentFrom, to: recentTo }),
    // the window the headline measured, whichever basis it took — see the field
    spendingHref: withPeriod("/spending", resolvePeriod({ period: null, from: shown.from, to: shown.to }, today)),

    earnedNote,
    unfiledNote,
    interestTrendNote,
    ratioNote,

    /*
     * The fee total is exactly a `categorySpend` over the `Fees` subtree, so
     * `provenanceFor` grades it rather than this module inventing a second
     * account of what the number is standing on. It describes the RECENT total
     * only — the figure the rows above it add up to.
     */
    paidProvenance: provenanceFor(db, {
      kind: "categorySpend",
      categoryId: cats.feesTopId,
      from: recentFrom,
      to: recentTo,
      label: "the fees you paid",
    }),
    today,
  };
}
