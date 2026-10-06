import { and, asc, eq, inArray } from "drizzle-orm";
import { apportionPercents } from "@/lib/apportion";
import { beforeFirstBalance, beforeFirstBalanceClause, unverifiedDetail } from "@/lib/coverage-detail";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { diffDays, todayIso } from "@/lib/dates";
import { formatDayShortIn } from "@/lib/format-date";
import { isStaleClose } from "@/lib/holding-price-age";
import { formatCents } from "@/lib/money";
import { listAccounts } from "./accounts";
import { activeTxnsInRange, loadCategoryIndex, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { accountCoverage, type AccountCoverage, type CoverageGrade } from "./coverage";
import { observedSeries } from "./derivation";
import {
  footingBounds,
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
 * assembled from the same balances: `latestBalances` over active cards,
 * negated — here through `listAccounts`, there through `cashPosition`.
 * Measured 2026-08-26 both read $925.61. One difference is latent rather than
 * live, and is DISCLOSED instead of hidden, because it would make one screen
 * contradict itself:
 *
 *  - `cashPosition` reads a missing balance as `?? 0`. A card the ledger has no
 *    balance for is not a card you owe nothing on, so `owedCents` here is
 *    `null` for it and `unpricedCards` says the total is a floor.
 *
 * (A closed card still carrying a balance is in neither total; `closedOwedCents`
 * names that money.)
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
  /**
   * First day of the unchecked run its newest balance sits in (`AccountCoverage.uncheckedSince`),
   * so the figure is newer than anything a statement checked; null when the newest day is checked.
   */
  uncheckedSince: string | null;
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
  /**
   * A quiet line about a clean chain, in the tone the row's date has, or null: a `verified` card's
   * days before its first statement, those days alone — the date is the sentence's or `asOfLabel`'s,
   * said once (`noteFor`). Never set beside a `caveat` — a card with something to warn of is not
   * `verified`.
   *
   * ⚖️ His answer, 2026-10-05: a quiet note, not the amber warning. It was the `caveat` (§6A 35), so
   * a card both its statements check, counted as adding up, read in the colour of "nothing checks it
   * since Aug 8" — a field of its own so the tone leaves the service with the words.
   */
  note: string | null;
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
  /**
   * the OLDEST evidence under the total — how old this figure really is.
   * ⚠️ The oldest CHECK, what "the oldest of them closed" says. The proof's
   * date is `footingBounds`', which also stops at a card resting on his count.
   */
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
 *  - the day the displayed figure is stated for — the day its balance was
 *    observed (`observedSeries`), the same day /accounts/[id] asks about;
 *  - the day the row's trouble starts: `brokenSince`, the first day the walk
 *    MISSED a statement, and with no break `unverifiedSince`, the first day
 *    nothing checks.
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
  /*
   * 🔴 S24: this asked with no day, so `accountBalance` graded the newest cached
   * row — the day the cache was rebuilt, "carried" on Discover's Sep 14 while its
   * account page graded Sep 8, the statement's day. See `observedSeries`.
   */
  const day = observedSeries(db, accountId).at(-1)?.day;
  const onFigure = provenanceFor(db, { kind: "accountBalance", accountId, day })?.verdict ?? "unknown";
  /*
   * 🔴 This asked about `unverifiedSince` alone, documented as "the first day the chain stopped
   * being checked". It is the first unchecked day the card EVER had: on a card whose export
   * reached back before its first statement, a day replayed backwards from it, graded
   * `unverified`. When the walk then missed the Aug 5 statement, the row said "stopped adding up
   * on Jul 26", net worth called the account "broken", and this badge and the total's read
   * "unverified" (§6A 28 follow-up review, through `rebuildAccount`). The break is the day the
   * row names, so it is asked first.
   *
   * ⛔ …and with no break, still the first unchecked day, not the run still open
   * (`uncheckedSince`, which the row's "since" is dated from): an `unverified` card with no run
   * open — his count, with days before it — asked about the open run alone, which it does not
   * have, would wear its figure's verdict beside net worth's "unverified".
   *
   * ⚖️ …but not of a `verified` card. His answer, 2026-10-05 (§6A 35): the days before its first
   * statement do not on their own make it a card nothing is checking, and net worth counts it as
   * adding up. Asked about the first of them — replayed backwards from the Jul 25 statement — the
   * badge read "unverified" of a $200.00 the Aug 5 statement printed. A verified card has no break
   * and no unchecked day its balance rests on, so its figure's day is the whole question.
   */
  const troubleFrom =
    cov === undefined || cov.grade === "verified" ? null : (cov.brokenSince ?? cov.unverifiedSince);
  if (troubleFrom === null) return onFigure;
  const onTrouble =
    provenanceFor(db, { kind: "accountBalance", accountId, day: troubleFrom })?.verdict ?? "unknown";
  return weakestVerdict([onFigure, onTrouble]);
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
      /*
       * ⚖️ Nothing to warn of. The days before its first statement, when it has any, are the row's
       * quiet `noteFor` — his answer of 2026-10-05; they were this warning (§6A 35), in amber.
       */
      return null;
    case "unverified":
      /*
       * Net worth's line for the account, in this card's dates (`unverifiedDetail`).
       *
       * 🔴 The row kept its own copy, dating "since" from `unverifiedSince`, the
       * first unchecked day the card ever had, and it was false twice. A card
       * resting on a balance he TYPED read "nothing has checked it since Aug 4
       * — 6 days ago", claiming a check before Aug 4 that never happened; once
       * his count took net worth's words, a card two statements checked, the
       * newer on Aug 5, read "nothing has checked it since Jul 19 — 22 days
       * ago", because its export reached back before the first of them (§6A 28
       * review). Net worth names his count, or the run still open.
       */
      return unverifiedDetail(cov, when) ?? "nothing checks this balance";
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

/**
 * The row's quiet line, or null: a `verified` card's days before its first statement, in /imports'
 * words for them ("the 26 days before its first balance") — "unchecked days before its first balance".
 *
 * ⚖️ His answer, 2026-10-05: a quiet note in the tone the verified rows use, not the amber warning.
 * Every other grade says what is wrong in `caveatFor`.
 *
 * 🔴 The date is the card's to place, by its own rule (`priceColumnAge`'s): said once — by the
 * sentence under the headline when every card shares it, else by the row's own line (`asOfLabel`).
 * The note took net worth's line, date and all ("adds up through Aug 5 — 5 days ago, and unchecked
 * days before that"), and said the date a second time either way: under "Across 2 cards, all as of
 * Aug 5 — 5 days ago." in the one row not quiet, and under the row's own "Aug 5 — 5 days ago" when
 * the dates differ. These days need a day the card is checked through (`beforeFirstBalance` reads
 * `verifiedThrough`, the row's `checkedThrough`), so the sentence or the row's line always says it,
 * and the note never does. The proof keeps its line (`composedProvenance`): there the date is its own.
 */
function noteFor(cov: AccountCoverage | undefined): string | null {
  if (cov === undefined || beforeFirstBalance(cov) === null) return null;
  return "unchecked days before its first balance";
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
function share(cents: number | null, totalCents: number): number | null {
  if (totalCents <= 0 || cents === null || cents <= 0) return null;
  return (cents / totalCents) * 100;
}

/**
 * The same shares as WHOLE percents that add to a hundred.
 *
 * 🔴 Rounding each slice on its own is how the dashboard's coverage note came
 * to print "94%" over four rows adding to 95. Two cards owing today round to
 * 60 + 40 by luck; three cards at a third each would print 33 + 33 + 33 and a
 * reader adding the card up would get 99. `lib/apportion` carries the
 * measurement and the method.
 *
 * ⛔ Cards with NO share — settled, in credit, unpriced — are held out of the
 * apportionment entirely and keep their null label, so a card that owes nothing
 * can never be handed a leftover point.
 */
function shareLabels(pcts: readonly (number | null)[]): (string | null)[] {
  const owing = pcts.map((p, i) => ({ p, i })).filter((e): e is { p: number; i: number } => e.p !== null);
  const whole = apportionPercents(owing.map((e) => e.p));
  const out: (string | null)[] = pcts.map(() => null);
  owing.forEach((e, k) => (out[e.i] = `${whole[k]}% of it`));
  return out;
}

/**
 * How the cards under the total are dated, as a clause — one home for the sentence under the
 * figure and the proof's headline, which said it in the same words.
 *
 * 🔴 "Across 1 card, each as of its own last statement — so this is not one moment." of a card
 * resting on his count: it has no statement, and one card is one moment. The proof said "each
 * balance as of its own last statement" of it too (§6A 28 review). Any card with no checked day
 * — his count, a card he counts himself, a card with no balance — sent both down the words
 * written for statements closing on different days. A card is "as of its own last statement"
 * only when one checked it, and the rest are counted as what they are.
 *
 * 🔴 …and only when its balance is still that statement's. "$240.00 across 1 card, each balance
 * as of its own last statement" of a card whose Aug 5 statement printed $200.00 and whose $40.00
 * charge on Aug 8 nothing checks: the figure sits in the run still open (`uncheckedSince`), the
 * run its row and net worth date "nothing checks it since" from (§6A 28 follow-up review). A card
 * whose balance has moved past its last statement is named as newer than it — in both sentences:
 * the e2e fixture's dashboard said "each as of its own last statement" of a Discover whose $86.89
 * sits in 14 unchecked days (from Jun 25, 2026) past its Jun 14, 2026 statement.
 */
function asOfClause(
  cards: readonly { checkedThrough: string | null; uncheckedSince: string | null }[],
  what: "" | "balance ",
): string {
  const unchecked = cards.filter((c) => c.checkedThrough === null).length;
  const newer = cards.filter((c) => c.checkedThrough !== null && c.uncheckedSince !== null).length;
  const dated = cards.length - unchecked - newer;
  if (unchecked > 0 && unchecked === cards.length) return " that no statement has checked";
  // the cards a statement dates lead; with none of those, the newer ones lead in their place
  const lead =
    dated > 0 || newer === 0
      ? `, each ${what}as of its own last statement`
      : `, each ${what}newer than its own last statement`;
  const others = [
    dated > 0 && newer > 0 ? `${newer} that ${plural(newer, "is", "are")} newer` : null,
    unchecked > 0 ? `${unchecked} that no statement has checked` : null,
  ].filter((part): part is string => part !== null);
  return others.length === 0 ? lead : `${lead} except ${others.join(" and ")}`;
}

function composedProvenance(
  cards: readonly CardOwedLine[],
  coverage: readonly AccountCoverage[],
  owedCents: number,
  today: string,
): Provenance {
  const coverageById = new Map(coverage.map((cov) => [cov.accountId, cov]));
  /** ", and unchecked days before that" of a verified card with days before its first statement */
  const daysBefore = (accountId: string): string => {
    const cov = coverageById.get(accountId);
    return cov === undefined ? "" : beforeFirstBalanceClause(cov);
  };
  const inputs: ProvenanceInput[] = cards.map((c) => ({
    label: c.last4 ? `${c.name} ····${c.last4}` : c.name,
    verdict: c.verdict,
    /*
     * 🔴 "nothing has checked this card yet" of a card resting on his count — this proof's own
     * copy of net worth's line, left as it was when the row took net worth's sentence (§6A 28
     * review). It never named his count, and it dropped the $95.00 the card owes, so the lines
     * under "$295.00 across 2 cards" no longer added up to it. A card no statement checked says
     * what its row says (`caveatFor`), after its figure like every other line.
     *
     * 🔴 …and so does a card a statement DID check. The row's sentence was read only when nothing
     * had checked the card, so a card checked through Aug 5 whose $240.00 holds a charge from Aug 8
     * read "$240.00 owed, checked through Aug 5 — 5 days ago" under a row and a net worth that both
     * said "nothing checks it since Aug 8"; a broken one kept its check and dropped "stopped adding
     * up on Jul 26" (§6A 28 follow-up review). The row's caveat says what net worth says of the
     * account, in this card's dates (`caveatFor`), so wherever there is one, the line says it.
     *
     * ⚖️ A verified card's days before its first statement come after the verb every verified line
     * here has (`beforeFirstBalanceClause`), his answer of 2026-10-05: "checked through Aug 5 — 5
     * days ago, and unchecked days before that" beside "checked through Aug 5 — 5 days ago". The
     * row's quiet note is in net worth's verb; this list's neighbours are "checked through".
     */
    detail:
      c.owedCents === null
        ? "no recorded balance — not in this total"
        : `${formatCents(Math.abs(c.owedCents))} ${c.owedCents < 0 ? "in credit" : "owed"}, ${
            c.caveat ??
            (c.checkedThrough === null
              ? "nothing has checked this card yet"
              : `checked through ${dated(c.checkedThrough, today)}${daysBefore(c.accountId)}`)
          }`,
  }));

  const counted = cards.length;
  const proven = cards.filter((c) => c.verdict === "derived" || c.verdict === "sourced").length;

  /*
   * ⛔ The total cannot be proven past the FIRST card that stops being checked —
   * net worth's rule, so net worth's `footingBounds`, never a second copy. This
   * took the oldest `verifiedThrough`, which a card resting on a balance he
   * TYPED does not have: alone it left the total undated beside a net worth that
   * dates the same card, and beside a checked card it dated the total past the
   * day this one goes unchecked. The day is his word when it is his count's, so
   * the sentence saying so travels with it (owner decision 2026-09-28, §6A 28).
   */
  const footing = footingBounds(coverage);

  return {
    verdict: weakestVerdict(cards.map((c) => c.verdict)),
    // a total is only as proven as its weakest input — but the WORD has to
    // describe the mixture, the lesson netWorthProvenance records
    badgeWord: `${proven} of ${counted} add up`,
    headline:
      `${formatCents(owedCents)} across ${counted} ${plural(counted, "card", "cards")}` +
      `${asOfClause(cards, "balance ")}. A total is only as proven as its weakest part.${footing.note}`,
    sources: [],
    checkedThrough: footing.through,
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
      uncheckedSince: cov?.uncheckedSince ?? null,
      daysSinceChecked: checkedThrough === null ? null : diffDays(checkedThrough, today),
      grade: cov?.grade ?? ("unknown" as CoverageGrade),
      caveat: caveatFor(cov, today),
      verdict: cardVerdict(db, a.id, cov),
    };
  });

  const owedCents = bare.reduce((s, c) => s + (c.owedCents ?? 0), 0);
  /*
   * ⛔ SHARES ARE OF WHAT IS OWED, NOT OF THE NET. A card in credit is money
   * the headline nets off — and it was shrinking the denominator. Measured on
   * the owner's dashboard on 2026-09-03, the day a Chase Sapphire statement
   * closed $82.72 in credit: "$842.89 across 3 cards" with Discover "66% of it"
   * and Venture X "44% of it" — two slices of one debt adding to 110%. `share`
   * already refuses a card in credit a slice of its own; the denominator has to
   * refuse the credit too, and the sentence has to say the credit is there.
   */
  const grossOwedCents = bare.reduce((s, c) => s + Math.max(0, c.owedCents ?? 0), 0);
  const creditCents = grossOwedCents - owedCents;
  const inCredit = bare.filter((c) => (c.owedCents ?? 0) < 0).map((c) => c.name);
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
  const bareShares = bare.map((c) => share(c.owedCents, grossOwedCents));
  const bareLabels = shareLabels(bareShares);
  const cards: CardOwedLine[] = bare
    .map((c, i) => ({
      ...c,
      // ⛔ `x / 0` is Infinity and renders as "Infinity%". A card with nothing
      // owed has no shares to hand out, and the card says something else.
      sharePct: bareShares[i]!,
      shareLabel: bareLabels[i]!,
      asOfLabel:
        sharedCheckedThrough !== null || c.checkedThrough === null
          ? null
          : dated(c.checkedThrough, today),
      caveat: c.caveat,
      // the same rule for the note: its date is the sentence's or the line above's, never its own (`noteFor`)
      note: noteFor(coverageById.get(c.accountId)),
      fees: feeLine(feesByAccount.get(c.accountId) ?? [], cats?.annualIds ?? new Set(), today),
    }))
    .sort((a, b) => (b.owedCents ?? -Infinity) - (a.owedCents ?? -Infinity) || a.name.localeCompare(b.name));

  // a card that owes something is never "Nothing owed", whatever another
  // card's credit nets the total down to
  const nothingOwed = grossOwedCents <= 0;
  const n = cards.length;

  const credit =
    creditCents > 0
      ? ` ${formatCents(creditCents)} of credit on ${inCredit.join(" and ")} is netted off, so each slice is of the ${formatCents(grossOwedCents)} actually owed.`
      : "";

  const floor =
    unpricedCards > 0
      ? ` ${unpricedCards} of them ${plural(unpricedCards, "has", "have")} no balance in the ledger, so this is a floor.`
      : "";
  const closed =
    closedOwedCents !== 0
      ? ` A closed card still carries ${formatCents(Math.abs(closedOwedCents))}, which is not counted here.`
      : "";

  /*
   * ⛔ "Not one moment" is a fact about the cards IN the total: statements closing on different
   * days, or a checked card beside one nothing checked. One card is one moment, a card with no
   * balance is not in the total, and cards no statement checked have no day to differ on.
   */
  const checkedInTotal = new Set(
    bare.flatMap((c) => (c.owedCents === null || c.checkedThrough === null ? [] : [c.checkedThrough])),
  );
  const uncheckedInTotal = bare.some((c) => c.owedCents !== null && c.checkedThrough === null);
  const notOneMoment = checkedInTotal.size > 1 || (checkedInTotal.size === 1 && uncheckedInTotal);

  const explanation = nothingOwed
    ? `Nothing is outstanding on ${n} ${plural(n, "card", "cards")}.` +
      (oldestCheckedThrough === null
        ? ""
        : ` The oldest of those balances was last checked ${dated(oldestCheckedThrough, today)}.`) +
      floor +
      closed
    : sharedCheckedThrough !== null
      ? `Across ${n} ${plural(n, "card", "cards")}, all as of ${dated(sharedCheckedThrough, today)}.` +
        credit +
        floor +
        closed
      : `Across ${n} ${plural(n, "card", "cards")}${asOfClause(cards, "")}` +
        `${notOneMoment ? " — so this is not one moment" : ""}.` +
        (oldestCheckedThrough === null
          ? ""
          : ` The oldest of them closed ${dated(oldestCheckedThrough, today)}.`) +
        credit +
        floor +
        closed;

  return {
    // net when it is a debt; when credits outweigh the debts the net is not
    // "what you owe" at all, and the gross is — with `credit` saying the rest
    headline: nothingOwed ? "Nothing owed" : formatCents(owedCents > 0 ? owedCents : grossOwedCents),
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
    provenance: composedProvenance(
      cards,
      active.map((a) => coverageById.get(a.id)).filter((c): c is AccountCoverage => c !== undefined),
      owedCents,
      today,
    ),
    today,
  };
}
