import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { diffDays, todayIso } from "@/lib/dates";
import { formatDayShortIn } from "@/lib/format-date";
import { isStaleClose } from "@/lib/holding-price-age";
import { formatCents } from "@/lib/money";
import { listAccounts } from "./accounts";
import { activeTxnsInRange, loadCategoryIndex, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { accountCoverage, type AccountCoverage, type CoverageGrade } from "./coverage";
import {
  provenanceFor,
  weakestVerdict,
  type Provenance,
  type ProvenanceInput,
  type ProvenanceVerdict,
} from "./provenance";
import { MIN_OCCURRENCES } from "./recurring";

/**
 * What you owe on cards — and, because a card balance is never a live number,
 * how old each half of that total actually is.
 *
 * ## The total is three statements, not one moment
 *
 * Measured 2026-08-26 the three cards were last checked on 2026-08-02,
 * 2026-08-09 and 2026-08-14 — 24, 17 and 12 days ago. One headline over three
 * different "as of" days is the ordinary way a debt figure lies: it reads as a
 * balance you could pay today when it is really three balances observed in
 * three different weeks, each with unseen spending behind it.
 *
 * So the shared-date test comes straight from `priceColumnAge`'s doctrine —
 * *a fact about every row belongs to the column, a fact about one row belongs
 * to that row.* When every card closes on the same day the card says it once;
 * when they disagree each row carries its own date. `isStaleClose` is IMPORTED
 * rather than re-derived, so this card and /investments can never disagree
 * about where "old" starts. What is deliberately NOT borrowed is
 * `holdingPriceAge`'s copy: its sentence is about market closes and a refresh
 * button, neither of which exists for a credit-card statement.
 *
 * ## ⛔ The as-of day is the day the money was CHECKED
 *
 * `latestBalances` reports the newest row in `daily_balances`, which for these
 * cards is a `carried` day — the derived cache simply ran to whenever it was
 * last rebuilt. Measured, those cache days (Aug 5 / Aug 14 / Aug 17) run three
 * to eight days PAST the statements behind them (Aug 2 / Aug 9 / Aug 14).
 * Printing the cache day would claim the number is fresher than its evidence,
 * so every date on this card is `accountCoverage.verifiedThrough` — the last
 * day the chain actually closed.
 *
 * The BALANCE still comes from `latestBalances`, and on a `carried` newest day
 * the two agree exactly: `carryForward` writes the anchor's own level and
 * `deriveForward` only calls a day carried while no transaction has landed. On
 * a `derived_unverified` newest day they do NOT agree — the figure really is
 * newer than the evidence dated beside it — and that is precisely the card the
 * row's `caveat` fires on, in warning tone, saying since when nothing has
 * checked it.
 *
 * ## ⛔ Sign
 *
 * A liability is stored NEGATIVE (net-worth signed). This card publishes what
 * is owed as a POSITIVE magnitude, exactly as `runwayCard` does for its `cards`
 * assumption, and says so in `convention`. A card whose stored balance is
 * positive means the bank owes HIM, and that lands here as a negative `owed` —
 * it must reduce the total rather than being clamped away.
 *
 * ## Agreeing with the runway card
 *
 * Both cards sit on the dashboard and both publish card debt, so they are
 * assembled from the same rows: `listAccounts` → `latestBalances`, negated.
 * Measured 2026-08-26 both read $925.61. Two differences are latent rather
 * than live, and are DISCLOSED instead of hidden, because either would make
 * one screen contradict itself:
 *
 *  - `runwayCard` iterates every account `listAccounts` returns, including
 *    deactivated ones. This card is scoped to active cards, so a closed card
 *    still carrying a balance is counted there and not here — `closedOwedCents`
 *    names that money.
 *  - `runwayCard` reads a missing balance as `?? 0`. A card the ledger has no
 *    balance for is not a card you owe nothing on, so `owedCents` here is
 *    `null` for it and `unpricedCards` says the total is a floor.
 *
 * ## What it costs
 *
 * Fees are read from the ledger's own `Fees` taxonomy, netted, never filtered
 * (`activeTxnsInRange`, so a split fee lands in both its parts). Interest is
 * its own bucket and is subtracted out of the fee total rather than being
 * silently folded in, so "fees" and "interest" name disjoint money.
 *
 * ⛔ The card publishes what was CHARGED and never a yearly rate. `MIN_OCCURRENCES`
 * is the bar the app uses before it will call anything recurring, and measured
 * on the real ledger the best-evidenced card fee has charged twice — below it.
 * Dividing one observation by one year would be inventing a schedule the ledger
 * has not seen.
 */

/** The ledger's own name for the top of the fee taxonomy. */
const FEES_CATEGORY = "Fees";
/** …and the two children that must not be read as each other. */
const ANNUAL_FEE_CATEGORY = "Card Annual Fees";
const INTEREST_CATEGORY = "Interest Charges";

export interface CardFeeLine {
  /** every fee charged to this card, refunds netted; positive = money out */
  totalCents: number;
  charges: number;
  /** the most recent one, ISO */
  lastOn: string;
  /** the subset the ledger files as a card annual fee */
  annualCents: number;
  annualCharges: number;
  /**
   * The annual fee has charged often enough for the app to call it recurring.
   * `MIN_OCCURRENCES` decides, not a number chosen here — the same bar
   * `analyzeGroup` holds every other series to.
   */
  annualRepeats: boolean;
  /**
   * The row's own sub-line, worded here rather than in the component.
   * Rule of this codebase: the words and the numbers leave together, so a
   * template that says "annual" cannot end up over a figure that is not one.
   */
  summary: string;
}

export interface CardOwedLine {
  accountId: string;
  name: string;
  last4: string | null;
  /**
   * Positive = owed. Negative = the bank owes you.
   * ⛔ `null` = the ledger has no balance for this card. That is NOT zero.
   */
  owedCents: number | null;
  /** last day this card's balance provably added up */
  checkedThrough: string | null;
  /** days between `checkedThrough` and today; null when nothing is checked */
  daysSinceChecked: number | null;
  /**
   * The date phrase this row prints, or null when the card-level sentence
   * already speaks for every row (`priceColumnAge`'s rule) or when nothing has
   * checked this card at all.
   */
  asOfLabel: string | null;
  /**
   * A warning about this card's evidence, or null when the chain is clean.
   *
   * Separate from `asOfLabel` rather than replacing it: a card can have a
   * perfectly good `verifiedThrough` date AND have stopped adding up after it,
   * and folding the two into one field would hide the second behind the first.
   */
  caveat: string | null;
  grade: CoverageGrade;
  verdict: ProvenanceVerdict;
  /** this card's slice of the debt; null when there is no debt to divide */
  sharePct: number | null;
  /** …and how that slice is said. Null exactly when `sharePct` is. */
  shareLabel: string | null;
  /** null when this card has never been charged a fee */
  fees: CardFeeLine | null;
}

export interface CardsFees {
  /** every fee on every active card, interest excluded, refunds netted */
  totalCents: number;
  charges: number;
  firstOn: string;
  lastOn: string;
  /** the subset the ledger files as card annual fees */
  annualCents: number;
}

export interface CardsOwedCard {
  /** the big figure, already worded — "$925.61" or "Nothing owed" */
  headline: string;
  /** the sentence under it, from the same call so the two cannot drift */
  explanation: string;
  /** which way the sign runs, said out loud */
  convention: string;
  /** what is owed, positive, summed over cards whose balance is known */
  owedCents: number;
  /** true when every known balance is settled or in credit */
  nothingOwed: boolean;
  cards: CardOwedLine[];
  /** the one day every card closes on, or null when they disagree */
  sharedCheckedThrough: string | null;
  /** the OLDEST evidence under the total — how old this figure really is */
  oldestCheckedThrough: string | null;
  daysSinceOldest: number | null;
  /** cards with no recorded balance: while > 0 the total is a floor */
  unpricedCards: number;
  /** owed on DEACTIVATED cards, which this card leaves out and runway does not */
  closedOwedCents: number;
  /** null when no card has ever been charged a fee */
  fees: CardsFees | null;
  /**
   * Interest charged to these cards. `null` when the ledger has no
   * interest-charge category to look in — a missing bucket is not evidence
   * that no interest was charged.
   */
  interestCents: number | null;
  /** what to say about interest, or null when there is no bucket to check */
  interestNote: string | null;
  /** the composed "prove it" chain behind the headline */
  provenance: Provenance;
  today: string;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * "Aug 9 — 17 days ago" — the only phrasing a date gets on this card.
 *
 * ⛔ Whether an observation is old enough to age out loud is `isStaleClose`'s
 * decision, imported rather than re-stated as `days > 0` here. `lib/holding-price-age`
 * exists so that a page note and a per-row date "can never disagree about where
 * the boundary is", and a third opinion in this service would break the
 * guarantee that docstring makes. A statement that closed today is dated and
 * not aged: "0 days ago" is noise, and a future date is not old, it is wrong.
 */
function dated(day: string, today: string): string {
  // ⛔ `formatDayShortIn`, not `formatDayShort`. A charge from another year
  // printed as a bare "Sep 18" beside "714 days ago" is one phrase disagreeing
  // with itself — and in September it reads as a date still to come.
  if (!isStaleClose(day, today, diffDays)) return formatDayShortIn(day, today);
  const days = diffDays(day, today);
  return `${formatDayShortIn(day, today)} — ${days} ${plural(days, "day", "days")} ago`;
}

/**
 * How proven ONE card's balance is.
 *
 * Two days are asked about, not one, and the weaker answer wins:
 *
 *  - the day the displayed figure is stated for — `provenanceFor`'s default;
 *  - `unverifiedSince`, the first day the chain stopped being checked.
 *
 * ⛔ The second is what stops the badge contradicting the row beside it. A card
 * whose replay missed an anchor in March still has a perfectly `anchored`
 * newest day, so asking only about that day reports "adds up" while the row
 * underneath says "stopped adding up on Mar 4". Both sentences are true of
 * their own day and only one of them can be true of the TOTAL.
 *
 * The second verdict is READ from the same service rather than mapped from the
 * coverage grade here, because a grade-to-verdict table already exists inside
 * `provenance` and a second copy of it would be the defect this codebase keeps
 * finding.
 */
function cardVerdict(db: AppDatabase, accountId: string, cov: AccountCoverage | undefined): ProvenanceVerdict {
  const onFigure = provenanceFor(db, { kind: "accountBalance", accountId })?.verdict ?? "unknown";
  if (!cov?.unverifiedSince) return onFigure;
  const onBreak =
    provenanceFor(db, { kind: "accountBalance", accountId, day: cov.unverifiedSince })?.verdict ?? "unknown";
  return weakestVerdict([onFigure, onBreak]);
}

/**
 * What is wrong with this card's evidence, said in the card's own voice, or
 * null when nothing is.
 *
 * Every branch reads a field `accountCoverage` already computed — the grade,
 * the day the chain broke, the day the owner last counted it. Re-deriving any
 * of that here would give the app a second opinion about the same account, and
 * the second one would be the untested one.
 */
function caveatFor(cov: AccountCoverage | undefined, today: string): string | null {
  if (!cov) return "no statement has checked this card yet";
  const when = (day: string): string => dated(day, today);
  switch (cov.grade) {
    case "verified":
      return null;
    case "unverified":
      return cov.unverifiedSince ? `nothing has checked it since ${when(cov.unverifiedSince)}` : "nothing checks this balance";
    case "broken":
      return cov.brokenSince ? `stopped adding up on ${when(cov.brokenSince)}` : "this balance does not add up";
    case "manual":
      return cov.lastManualUpdate ? `you last counted it on ${when(cov.lastManualUpdate)}` : "you are the statement here";
    // a credit account is never graded market_value — accountCoverage branches
    // on type === "investment" — but the switch stays exhaustive so a new grade
    // cannot slip through as silence
    case "market_value":
      return "priced, not checked";
    case "unknown":
      return "no statement has checked this card yet";
  }
}

interface FeeCategories {
  /** the fee subtree with interest taken OUT, so the two buckets are disjoint */
  feeIds: Set<string>;
  annualIds: Set<string>;
  /** null when the ledger has no interest bucket at all */
  interestIds: Set<string> | null;
}

function feeCategories(idx: CategoryIndex): FeeCategories | null {
  const top = [...idx.byId.values()].find((c) => c.parentId === null && c.name === FEES_CATEGORY);
  if (!top) return null;

  const child = (name: string): string | null =>
    [...idx.byId.values()].find((c) => c.parentId === top.id && c.name === name)?.id ?? null;

  const annualId = child(ANNUAL_FEE_CATEGORY);
  const interestId = child(INTEREST_CATEGORY);
  const interestIds = interestId === null ? null : new Set(idx.subtreeIds(interestId));

  const feeIds = new Set(idx.subtreeIds(top.id));
  // interest is a cost, but it is not a fee: folding it in would let a card
  // say "no interest" and "$X in fees" about the same dollars
  if (interestIds) for (const id of interestIds) feeIds.delete(id);

  return { feeIds, annualIds: annualId === null ? new Set() : new Set(idx.subtreeIds(annualId)), interestIds };
}

/**
 * ⛔ Netting, not filtering. `WHERE amount_cents < 0` would read a refunded fee
 * as a fee that happened AND a credit that never did; the ledger was understated
 * $487.50 by exactly that shape. A reversal cancels its charge here, and stops
 * being counted as one.
 */
function feeLine(rows: readonly AnalyticsTxn[], annualIds: ReadonlySet<string>, today: string): CardFeeLine | null {
  if (rows.length === 0) return null;
  const totalCents = rows.reduce((s, t) => s - t.amountCents, 0);
  const charges = rows.filter((t) => t.amountCents < 0).length;
  const annual = rows.filter((t) => t.categoryId !== null && annualIds.has(t.categoryId));
  const annualCharges = annual.filter((t) => t.amountCents < 0).length;
  // ⛔ the last CHARGE, not the last row. A refund is a reversal, not an event
  // to date the fee by — "1 annual fee, Mar 5" over a fee charged on Mar 1 and
  // reversed on Mar 5 dates it by the undoing.
  const chargeDays = rows.filter((t) => t.amountCents < 0).map((t) => t.postedOn).sort();
  const lastOn = chargeDays.at(-1) ?? [...rows].map((t) => t.postedOn).sort().at(-1)!;

  /*
   * ⛔ "annual fee" is said ONLY where the ledger files the charge as one.
   * Measured 2026-08-26 the $395 Capital One membership fee sits in `Bank Fees`,
   * not `Card Annual Fees` — it is real money and it shows in the total either
   * way, but calling it an annual fee here would be this card asserting a
   * classification the ledger has not made.
   */
  const allAnnual = annualCharges > 0 && annualCharges === charges;
  const noun = allAnnual ? (charges === 1 ? "annual fee" : "annual fees") : charges === 1 ? "charge" : "charges";
  // ⛔ through `dated`, like every other date here. A bare "latest Mar 1" over
  // fees spanning two Marches names neither of them, and how long ago a fee was
  // charged is the whole question about whether it is coming round again.
  const when = charges > 1 ? `latest ${dated(lastOn, today)}` : dated(lastOn, today);

  return {
    totalCents,
    charges,
    lastOn,
    annualCents: annual.reduce((s, t) => s - t.amountCents, 0),
    annualCharges,
    annualRepeats: annualCharges >= MIN_OCCURRENCES,
    summary: charges === 0 ? `fully refunded, ${dated(lastOn, today)}` : `${charges} ${noun}, ${when}`,
  };
}

/** The earliest active row on any of these accounts — the fee window's floor. */
function firstActivity(db: AppDatabase, accountIds: readonly string[]): string | null {
  if (accountIds.length === 0) return null;
  return (
    db
      .select({ day: transactions.postedOn })
      .from(transactions)
      .where(and(eq(transactions.status, "active"), inArray(transactions.accountId, [...accountIds])))
      .orderBy(asc(transactions.postedOn))
      .limit(1)
      .get()?.day ?? null
  );
}

/**
 * One card's slice of the debt.
 *
 * ⛔ `x / 0` is `Infinity`, and `Infinity%` renders. A ledger where every card
 * is settled has no shares to hand out — the card says "Nothing owed" instead —
 * and a card in credit has no slice of a debt either. Both are null, and the
 * label is null in exactly the same breath so a percentage can never appear
 * without the number behind it.
 */
function share(cents: number | null, totalCents: number): { sharePct: number | null; shareLabel: string | null } {
  if (totalCents <= 0 || cents === null || cents <= 0) return { sharePct: null, shareLabel: null };
  const sharePct = (cents / totalCents) * 100;
  return { sharePct, shareLabel: `${Math.round(sharePct)}% of it` };
}

function composedProvenance(
  cards: readonly CardOwedLine[],
  owedCents: number,
  oldest: string | null,
  today: string,
): Provenance {
  const inputs: ProvenanceInput[] = cards.map((c) => ({
    label: c.last4 ? `${c.name} ····${c.last4}` : c.name,
    verdict: c.verdict,
    detail:
      c.owedCents === null
        ? "no recorded balance — not in this total"
        : c.checkedThrough === null
          ? "nothing has checked this card yet"
          : `${formatCents(Math.abs(c.owedCents))} ${c.owedCents < 0 ? "in credit" : "owed"}, checked through ${dated(c.checkedThrough, today)}`,
  }));

  const counted = cards.length;
  const proven = cards.filter((c) => c.verdict === "derived" || c.verdict === "sourced").length;

  return {
    verdict: weakestVerdict(cards.map((c) => c.verdict)),
    // a total is only as proven as its weakest input — but the WORD has to
    // describe the mixture, the lesson netWorthProvenance records
    badgeWord: `${proven} of ${counted} add up`,
    headline:
      `${formatCents(owedCents)} across ${counted} ${plural(counted, "card", "cards")}, ` +
      `each balance as of its own last statement. A total is only as proven as its weakest part.`,
    sources: [],
    // the total cannot be proven past the FIRST card that stops being checked
    checkedThrough: oldest,
    inputs,
  };
}

/**
 * What is owed on cards, how old each figure is, and what the cards cost.
 *
 * Returns null when there is no active credit account, and also when not one of
 * them has a recorded balance — a headline of `$0.00` that really means "the
 * ledger does not know" is the worst thing this card could render.
 */
export function cardsOwedCard(db: AppDatabase, today: string = todayIso()): CardsOwedCard | null {
  const all = listAccounts(db).filter((a) => a.type === "credit");
  const active = all.filter((a) => a.isActive);
  if (active.length === 0) return null;
  if (active.every((a) => a.balance?.balanceCents === undefined)) return null;

  const coverageById = new Map(accountCoverage(db, today).map((c) => [c.accountId, c]));

  /**
   * ⛔ `cents === 0 ? 0 : -cents`, never a bare `-cents`. JavaScript has a
   * NEGATIVE ZERO and `-0` formats as "-$0.00": a paid-off Chase Sapphire
   * rendered exactly that on the dashboard, which reads as a debt of some tiny
   * amount rounded down, or as a bug — either way not as "you owe nothing".
   * Caught by looking at the card, not by tsc and not by any total, since
   * `-0 + 0 === 0` leaves every sum correct.
   */
  const owedOf = (cents: number | null | undefined): number | null =>
    cents === null || cents === undefined ? null : cents === 0 ? 0 : -cents;

  const bare = active.map((a) => {
    const cov = coverageById.get(a.id);
    const checkedThrough = cov?.verifiedThrough ?? null;
    return {
      accountId: a.id,
      name: a.name,
      last4: a.last4,
      owedCents: owedOf(a.balance?.balanceCents),
      checkedThrough,
      daysSinceChecked: checkedThrough === null ? null : diffDays(checkedThrough, today),
      grade: cov?.grade ?? ("unknown" as CoverageGrade),
      caveat: caveatFor(cov, today),
      verdict: cardVerdict(db, a.id, cov),
    };
  });

  const owedCents = bare.reduce((s, c) => s + (c.owedCents ?? 0), 0);
  const unpricedCards = bare.filter((c) => c.owedCents === null).length;
  const closedOwedCents = all
    .filter((a) => !a.isActive)
    .reduce((s, a) => s + (owedOf(a.balance?.balanceCents) ?? 0), 0);

  /* ── what the cards cost ─────────────────────────────────────────── */
  const idx = loadCategoryIndex(db);
  const cats = feeCategories(idx);
  const activeIds = active.map((a) => a.id);
  const from = firstActivity(db, activeIds);

  const feesByAccount = new Map<string, AnalyticsTxn[]>();
  let interestCents: number | null = null;
  let fees: CardsFees | null = null;

  if (cats && from !== null) {
    const onCards = new Set(activeIds);
    const rows = activeTxnsInRange(db, from, today).filter((t) => onCards.has(t.accountId));

    for (const t of rows) {
      if (t.categoryId === null || !cats.feeIds.has(t.categoryId)) continue;
      feesByAccount.set(t.accountId, [...(feesByAccount.get(t.accountId) ?? []), t]);
    }

    if (cats.interestIds) {
      const ids = cats.interestIds;
      interestCents = rows
        .filter((t) => t.categoryId !== null && ids.has(t.categoryId))
        .reduce((s, t) => s - t.amountCents, 0);
    }

    const feeRows = [...feesByAccount.values()].flat();
    if (feeRows.length > 0) {
      const days = feeRows.map((t) => t.postedOn).sort();
      fees = {
        totalCents: feeRows.reduce((s, t) => s - t.amountCents, 0),
        charges: feeRows.filter((t) => t.amountCents < 0).length,
        firstOn: days[0]!,
        lastOn: days.at(-1)!,
        annualCents: feeRows
          .filter((t) => t.categoryId !== null && cats.annualIds.has(t.categoryId))
          .reduce((s, t) => s - t.amountCents, 0),
      };
    }
  }

  /* ── how many days this total really spans ───────────────────────── */
  const checkedDays = bare.map((c) => c.checkedThrough).filter((d): d is string => d !== null);
  const distinct = new Set(checkedDays);
  // priceColumnAge's rule: one date that describes every row belongs to the
  // column, and only a disagreement sends the date down to the rows
  const sharedCheckedThrough = distinct.size === 1 && checkedDays.length === bare.length ? checkedDays[0]! : null;
  const oldestCheckedThrough = [...distinct].sort()[0] ?? null;
  const daysSinceOldest = oldestCheckedThrough === null ? null : diffDays(oldestCheckedThrough, today);

  /* ── rows, largest debt first; an unpriced card has no place in that order ── */
  const cards: CardOwedLine[] = bare
    .map((c) => ({
      ...c,
      // ⛔ `x / 0` is Infinity and renders as "Infinity%". A card with nothing
      // owed has no shares to hand out, and the card says something else.
      ...share(c.owedCents, owedCents),
      asOfLabel:
        sharedCheckedThrough !== null || c.checkedThrough === null
          ? null
          : dated(c.checkedThrough, today),
      caveat: c.caveat,
      fees: feeLine(feesByAccount.get(c.accountId) ?? [], cats?.annualIds ?? new Set(), today),
    }))
    .sort((a, b) => (b.owedCents ?? -Infinity) - (a.owedCents ?? -Infinity) || a.name.localeCompare(b.name));

  const nothingOwed = owedCents <= 0;
  const n = cards.length;

  const floor =
    unpricedCards > 0
      ? ` ${unpricedCards} of them ${plural(unpricedCards, "has", "have")} no balance in the ledger, so this is a floor.`
      : "";
  const closed =
    closedOwedCents !== 0
      ? ` A closed card still carries ${formatCents(Math.abs(closedOwedCents))}, which is not counted here.`
      : "";

  const explanation = nothingOwed
    ? `Nothing is outstanding on ${n} ${plural(n, "card", "cards")}.` +
      (oldestCheckedThrough === null
        ? ""
        : ` The oldest of those balances was last checked ${dated(oldestCheckedThrough, today)}.`) +
      floor +
      closed
    : sharedCheckedThrough !== null
      ? `Across ${n} ${plural(n, "card", "cards")}, all as of ${dated(sharedCheckedThrough, today)}.` +
        floor +
        closed
      : `Across ${n} ${plural(n, "card", "cards")}, each as of its own last statement — so this is not one moment.` +
        (oldestCheckedThrough === null
          ? ""
          : ` The oldest of them closed ${dated(oldestCheckedThrough, today)}.`) +
        floor +
        closed;

  return {
    headline: nothingOwed ? "Nothing owed" : formatCents(owedCents),
    explanation,
    convention:
      "A card balance is stored the way a statement writes a debt, as a negative. Shown here as what you owe.",
    owedCents,
    nothingOwed,
    cards,
    sharedCheckedThrough,
    oldestCheckedThrough,
    daysSinceOldest,
    unpricedCards,
    closedOwedCents,
    fees,
    interestCents,
    /*
     * A measured zero is worth saying; an absent bucket is not. Only the first
     * of these is evidence — if the ledger has no interest-charge category the
     * card stays silent rather than announcing an absence it never checked.
     */
    interestNote:
      interestCents === null
        ? null
        : interestCents === 0
          ? "No interest has ever been charged to them."
          : `Interest has cost ${formatCents(interestCents)} on top of that.`,
    provenance: composedProvenance(cards, owedCents, oldestCheckedThrough, today),
    today,
  };
}
