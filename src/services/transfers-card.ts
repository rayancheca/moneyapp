import { and, eq, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatMonthYear, monthWindowLabel } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { cancelledTransferNote } from "@/lib/cancelled-transfer-note";
import { listAccounts } from "./accounts";
import { activeTxnsInRange, loadCategoryIndex, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { baselineWindow, SPEND_BASELINE_MONTHS } from "./committed";
import { transferFlow } from "./transfer-flow";
import { cancelledTransfers, transferCandidates, transferCategoryResolver } from "./transfer-links";

/**
 * How much of the money crossing these accounts is just the owner moving his
 * own money — and how much of it the app can prove landed.
 *
 * Measured over 2026-02 → 2026-07 (`scripts/probe-transfers-card.ts`): $190,022.58
 * arrives and $168,951.10 leaves under the top-level `Transfers` category across
 * 523 rows. Read as income and spending that would be the largest thing on the
 * dashboard by a wide margin. It is neither: a transfer takes nothing out of net
 * worth and puts nothing in. This card is where that money is allowed to be
 * large without being alarming — and where the part the app CANNOT account for
 * is said out loud rather than netted into silence.
 *
 * ## 🔴 "Transfers" is not one population, and the difference is 46% of the story
 *
 * The brief's framing — 523 rows, 331 of them unlinked, "roughly two thirds are
 * unlinked, that is the story" — is arithmetically right and reads wrong, and
 * the measurement says why. Only **286** of those 523 rows move money between
 * two of the owner's own accounts. Of the other **237**, all of them unlinked:
 *
 *  - **151** sit in categories the owner added under `Transfers` that name a
 *    counterparty outside the ledger — 126 `Reimbursements` (Zelle with
 *    friends), 16 `Pass-through` (his father's wires, which `year-summary`
 *    already describes as "money that moves through your accounts on its way to
 *    someone else"), 8 `Gifts received`, 1 `Loans`. The other leg is in
 *    somebody else's bank. Nothing can ever pair them.
 *  - **69** are `Crypto Money Movement` in Robinhood Cash. That IS his own
 *    money moving between his own accounts — and it still cannot be paired,
 *    because the far side is a crypto position, not a transaction. A holding is
 *    not a leg.
 *  - **17** are odds and ends filed in the bare `Transfers` parent with no
 *    sub-category at all.
 *
 * So 72% of the "unlinked" rows are unlinked by construction and not one of
 * them is a defect. Against the population the question is actually about, the
 * unlinked share is **94 of 286 legs, 32.9%** — a third, not two thirds.
 * Publishing 63% would have been a fault report about the pairer built almost
 * entirely out of rows the pairer is right to leave alone. That is the same
 * error `moversCard` refuses when it will not compare a part month to whole
 * ones: the number is real and the comparison is not.
 *
 * ## ⛔ Which rows are "your own accounts" — asked, not invented
 *
 * `transferCategoryResolver` (transfer-links.ts) is the one function in the
 * tree that answers "given accounts of mine, what category does a transfer
 * between them get". Every path that marks a transfer — the detector, the bulk
 * toggle, the manual pair linker — resolves through it. So the set of
 * own-account categories is obtained by ASKING it, once per real account, and
 * taking the union: `Internal Transfer`, `Credit Card Payment`,
 * `Investment Contribution` on this ledger. Anything it cannot produce is a
 * transfer the pairer would never stamp, and is reported separately rather than
 * classified by this module — naming those categories here would be a second
 * definition of a thing transfer-links already owns, and it would silently
 * follow the owner's future categories in whichever direction I guessed.
 *
 * (`renameCategory`, `moveCategory` and `deleteCategory` all refuse
 * transfer-kind rows — "transfer detection matches on them" — so the three
 * names the resolver depends on cannot drift out from under it.)
 *
 * ## ⛔ Sign is DIRECTION here, not refund-versus-purchase
 *
 * The house rule is that refunds NET and are never filtered on sign, because in
 * an expense category a positive row is a purchase coming back and dropping it
 * understates spending — pass 66 found twelve of them worth $487.50. That rule
 * does not transplant into a transfer category, and applying it here would
 * destroy the card: the two legs of one transfer are equal and opposite, so
 * netting them returns **exactly zero** for every movement that worked. Sign in
 * a transfer category is which END of the movement a row is, not whether the
 * money came back.
 *
 * So this card counts DEPARTURES — outflow legs — and it counts them once. It
 * does not filter money away: the arrival side is published too, in its own
 * line, precisely because an arrival with no departure is the interesting half.
 * `activeTxnsInRange` is still the source, so splits expand exactly as they do
 * everywhere else (measured: zero split parts sit in transfer categories today,
 * which is a fact about this ledger and not a licence to query around them).
 *
 * ## 🔴 Double counting, and why the headline is the OUT side
 *
 * A linked transfer has two legs. Summing both publishes every movement twice;
 * on this window that is the difference between $74,980.12 and $167,105.67.
 * The headline counts the DEPARTURE only — one dollar leaving one account for
 * another is one dollar moved — which is `transferFlow`'s own convention (the
 * outflow leg keys the group and its magnitude is the edge, "so a wire fee on
 * the receiving side can never inflate the edge").
 *
 * A round trip therefore counts twice, and that is correct rather than
 * tolerated: money that went to Robinhood and came back really did leave an
 * account on two occasions. The card says so in the sentence under the
 * headline, and publishes `churnCents` — `transferFlow`'s figure, not a second
 * one — so a reader can see how much of the total is the same money going
 * round.
 *
 * ## ⛔ Reuse: `transferFlow` owns the routes, this module owns the gap
 *
 * `transferFlow(db, range)` already answers "of the money the pairer LINKED,
 * which account sent it to which, how many times, and how much came back". It
 * is imported whole; no edge, no churn figure and no account label is
 * recomputed here. What it structurally cannot see is the other population —
 * its query is `isNotNull(transferGroupId)`, so every unlinked leg is invisible
 * to it by construction. That gap is this module's entire reason to exist, and
 * the two populations are disjoint by definition (group id null vs not), so
 * they add rather than overlap.
 *
 * ## 🔴 A transfer_group_id is not a proof
 *
 * Measured: four groups in this window resolve into no route. Two are legs
 * whose partner posted on 2026-01-31, two days before the window opens — real
 * transfers, correctly linked, outside the frame. Two are groups with exactly
 * one member in the entire ledger ($115.00 each): a link to nothing, which is
 * the "24 transfer groups with one active member" the handoff has carried for
 * four passes. So the card does not say "linked" and mean "proved". It says
 * what the routes add up to, and it reports the remainder as a link the window
 * could not resolve, in money, rather than dropping $218.64 and hoping.
 */

/**
 * How many routes the card names.
 *
 * Five, and the remainder is summed into one line rather than dropped, so the
 * rows on screen still reconcile with the routed total above them. This is
 * `TOP_MOVERS`' reasoning applied to a different list — deliberately NOT that
 * constant imported, because coupling two unrelated dashboard lists means one
 * cannot be lengthened without silently lengthening the other.
 */
export const TOP_ROUTES = 5;

/** One directed route the pairer resolved: this account sent to that one. */
export interface TransferRoute {
  /** `${fromAccountId}>${toAccountId}` — `transferFlow`'s own edge id */
  id: string;
  fromLabel: string;
  toLabel: string;
  /** cents on this route over the window; the departure side, counted once */
  cents: number;
  /** how many transfer groups make it up */
  count: number;
  /** "20 transfers" / "1 transfer" — the card's only count phrasing */
  countLabel: string;
}

/** What the app can and cannot show about where the departures landed. */
export interface TransferProof {
  /** departures carrying a link to an arrival */
  linkedCount: number;
  linkedCents: number;
  /** departures with no transfer group at all */
  unpairedCount: number;
  unpairedCents: number;
  /** unpaired share of departures, 0–100 */
  unpairedPct: number;
  /** the whole verdict, in words */
  sentence: string;
  /**
   * Unpaired departures whose counterpart is already visible — null when none.
   *
   * `transferCandidates` is the app's own answer to "what could this row pair
   * with"; a candidate whose `amountDeltaCents` is 0 is an exact mirror. It is
   * asked rather than re-derived, so the card can never point at a row the
   * manual linker would not offer.
   */
  mirrorNote: string | null;
  mirrorCount: number;
  mirrorCents: number;
  /** linked money that resolved into no route — null when it all did */
  strandedNote: string | null;
  strandedCents: number;
}

export interface TransfersCard {
  /** every dollar that left one of your accounts for another, counted once */
  movedCents: number;
  departureCount: number;
  /** "$74,980.12" */
  headline: string;
  /** "left one account for another, Feb 2026 to Jul 2026" */
  headlineNoun: string;
  /** why this is not income, not spending, and not double counted */
  summary: string;

  /** what the routes below add up to — `transferFlow`'s gross, unmodified */
  routedCents: number;
  routes: TransferRoute[];
  /** everything under the cut, so the rows still reconcile */
  otherRouteCount: number;
  otherRouteCents: number;
  otherRouteNote: string | null;

  proof: TransferProof;

  /** how much of the routed money came straight back — null when none did */
  churnNote: string | null;
  churnCents: number;
  /** money that landed with no departure recorded — null when none */
  arrivalNote: string | null;
  arrivalCount: number;
  arrivalCents: number;
  /** the transfer rows this card is NOT about — null when there are none */
  otherPartyNote: string | null;
  otherPartyCount: number;
  /** transfers that left an account and came back to it — null when none */
  cancelledNote: string | null;
  /** cancelled transfers (groups) with a leg in the window */
  cancelledCount: number;
  /** the money that went out and came back, once per cancelled transfer */
  cancelledCents: number;

  months: number;
  fromMonth: string;
  toMonth: string;
  fromLabel: string;
  toLabel: string;
  today: string;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The categories the app itself stamps on a transfer between two of the owner's
 * accounts. Asked of `transferCategoryResolver` rather than named here — see
 * the header note. One account is enough per call: the resolver keys off that
 * account's type and investment side, so the union over every account is the
 * complete set of categories it can ever produce.
 */
function ownAccountTransferCategoryIds(db: AppDatabase): Set<string> {
  const resolve = transferCategoryResolver(db);
  return new Set(listAccounts(db).map((a) => resolve([a.id])));
}

/**
 * `transferGroupId` per transaction id over the window.
 *
 * `activeTxnsInRange` deliberately does not carry it — no analytics consumer
 * needs it — so it is fetched alongside rather than by re-querying the rows.
 * A SPLIT part inherits its parent row's link, which is the truthful reading:
 * `linkTransferPair` refuses to link a split row at all, so a part can only
 * ever be as linked as the row it came from.
 */
function transferGroupIds(db: AppDatabase, from: string, to: string): Map<string, string | null> {
  const rows = db
    .select({ id: transactions.id, transferGroupId: transactions.transferGroupId })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), gte(transactions.postedOn, from), lte(transactions.postedOn, to)))
    .all();
  return new Map(rows.map((r) => [r.id, r.transferGroupId] as const));
}

/**
 * Money moving between the owner's own accounts, over the last complete
 * calendar months.
 *
 * The window is `SPEND_BASELINE_MONTHS` and the current month is excluded, for
 * the reason the runway card already publishes three inches away: a part month
 * beside whole ones reads as a fall that has not happened. Importing the
 * constant rather than picking one keeps two cards on the same screen from
 * quoting different windows for the same ledger.
 *
 * Returns null when the ledger cannot answer, which is two refusals rather than
 * two zeroes:
 *
 *  - there is no `Transfers` taxonomy, so no row can be one — and
 *    `transferCategoryResolver` would THROW on the missing category path rather
 *    than answer, so this guard has to come before it;
 *  - nothing DEPARTED in the window. That covers both "no own-account transfer
 *    rows at all" and "rows, but every one of them is an arrival"; an explicit
 *    empty-rows guard was written first and deleted, because it could never
 *    change the answer — no rows implies no departures implies this line. The
 *    all-arrivals case costs the card its arrival note, and that is the trade:
 *    "$0.00 left one account for another" printed over real money is a card of
 *    zeroes, and a ledger where money only ever lands is broken in a way a
 *    dashboard card is the wrong place to report.
 */
export function transfersCard(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = SPEND_BASELINE_MONTHS,
): TransfersCard | null {
  const idx: CategoryIndex = loadCategoryIndex(db);
  const transfersTop = [...idx.byId.values()].find((c) => c.parentId === null && c.kind === "transfer");
  // no transfer taxonomy at all — nothing here can be a transfer, and
  // `transferCategoryResolver` would throw rather than answer
  if (transfersTop === undefined) return null;

  /*
   * ⛔ ONE WINDOW, ONE PLACE — `baselineWindow` floors this at the first month
   * the ledger covers in full. Building it here from the constant alone let a
   * young ledger put two different windows in two captions on one dashboard.
   */
  const window = baselineWindow(db, today, months);
  const { fromMonth, toMonth, from } = window;
  // the calendar owns month lengths, not this module
  const to = periodBounds(`${toMonth}-01`, "monthly").end;

  const own = ownAccountTransferCategoryIds(db);
  const groupOf = transferGroupIds(db, from, to);
  const linkOf = (t: AnalyticsTxn): string | null => groupOf.get(t.id) ?? null;

  const inTransfers = activeTxnsInRange(db, from, to).filter(
    (t) => t.categoryId !== null && idx.topLevelOf(t.categoryId).id === transfersTop.id,
  );
  const ownLegs = inTransfers.filter((t) => own.has(t.categoryId!));

  /*
   * 🔴 A CANCELLED transfer moved nothing between accounts — one group, two
   * legs in ONE account, cancelling (transfer-links' `isCancelledTransfer`).
   * Measured on the owner's ledger, 2026-09-15: linked as a group and read like
   * any other, Chase Checking's cancelled $115.00 card payment became a LINKED
   * departure, and the stranded clause grew $24.27 → $139.27 while saying "its
   * other leg is not inside these months" — of a leg on the same day, in the
   * same account. So its legs are neither departures nor arrivals, and the card
   * says it was cancelled. Asked over the WHOLE group, so a return that posted
   * in the running month does not turn the payment back into a departure — the
   * membership `transferFlow` asks too, so its routes and this card agree.
   */
  const cancelled = cancelledTransfers(
    db,
    ownLegs.map(linkOf).filter((g): g is string => g !== null),
  );
  const movingLegs = ownLegs.filter((t) => {
    const group = linkOf(t);
    return group === null || !cancelled.has(group);
  });
  const cancelledCents = [...cancelled.values()].reduce((sum, cents) => sum + cents, 0);

  /*
   * Departures and arrivals — the two ENDS of a movement, not spending and its
   * refund. A zero-amount row is neither and is deliberately in neither bucket;
   * it moves nothing, so it can inflate no total (measured: none exist).
   */
  const departures = movingLegs.filter((t) => t.amountCents < 0);
  const arrivals = movingLegs.filter((t) => t.amountCents > 0);
  // amountCents is strictly negative here, so the negation cannot produce -0
  const movedCents = departures.reduce((sum, t) => sum - t.amountCents, 0);
  if (movedCents === 0) return null;

  const linked = departures.filter((t) => linkOf(t) !== null);
  const unpaired = departures.filter((t) => linkOf(t) === null);
  const linkedCents = linked.reduce((sum, t) => sum - t.amountCents, 0);
  const unpairedCents = unpaired.reduce((sum, t) => sum - t.amountCents, 0);

  // ── the routes: `transferFlow`'s, unmodified ─────────────────────────────
  const flow = transferFlow(db, { from, to });
  const labelOf = new Map(flow.accounts.map((a) => [a.id, a.label] as const));
  /*
   * Both endpoints of an edge are always in `flow.accounts`: `transferFlow`
   * adds them to `touchedAccounts` in the same step that creates the edge, and
   * only paired groups make edges. A `?? accountId` fallback here would be a
   * branch no test could reach and no reader could trust — an untestable
   * default that would print a UUID on screen if it ever did fire.
   */
  const allRoutes: TransferRoute[] = flow.edges.map((e) => ({
    id: e.id,
    fromLabel: labelOf.get(e.fromAccountId)!,
    toLabel: labelOf.get(e.toAccountId)!,
    cents: e.cents,
    count: e.count,
    countLabel: `${e.count} ${plural(e.count, "transfer", "transfers")}`,
  }));
  const routes = allRoutes.slice(0, TOP_ROUTES);
  const rest = allRoutes.slice(TOP_ROUTES);
  const otherRouteCents = rest.reduce((sum, r) => sum + r.cents, 0);

  /*
   * Linked departures whose group resolved into no route inside this window.
   *
   * A residual rather than a second walk over the groups, and it cannot go
   * negative: `transferFlow` only ever adds an outflow leg it found IN RANGE,
   * carrying a group id, in a group with exactly one out and one in — so every
   * cent of `routedCents` is also a cent of `linkedCents`. The tests assert it.
   */
  const routedCents = flow.totals.grossCents;
  const strandedCents = linkedCents - routedCents;

  // ── which unpaired departures already have their partner in view ─────────
  /*
   * `transferCandidates` sorts by amount distance first and slices to its own
   * limit, so an exact mirror — distance 0 — is always inside the slice when
   * one exists. Measured 36ms across the 47 unpaired departures on the real
   * ledger; the query is indexed on status/date and this runs once per card.
   */
  let mirrorCount = 0;
  let mirrorCents = 0;
  for (const leg of unpaired) {
    if (!transferCandidates(db, leg.id).some((c) => c.amountDeltaCents === 0)) continue;
    mirrorCount += 1;
    mirrorCents -= leg.amountCents;
  }

  // ── the rows this card is NOT about ──────────────────────────────────────
  const otherParty = inTransfers.filter((t) => !own.has(t.categoryId!));
  const otherPartyIn = otherParty.filter((t) => t.amountCents > 0).reduce((sum, t) => sum + t.amountCents, 0);
  const otherPartyOut = otherParty.filter((t) => t.amountCents < 0).reduce((sum, t) => sum - t.amountCents, 0);
  const otherPartyPaired = otherParty.filter((t) => linkOf(t) !== null).length;

  const arrivalCents = arrivals
    .filter((t) => linkOf(t) === null)
    .reduce((sum, t) => sum + t.amountCents, 0);
  const arrivalCount = arrivals.filter((t) => linkOf(t) === null).length;

  // `monthWindowLabel` for the SENTENCE, so a one-month window reads "Sep 2022"
  // rather than "Sep 2022 to Sep 2022" — the divergence the three migrated
  // cards would otherwise have from this one. The two single-month fields below
  // stay `formatMonthYear`: one end is not a window.
  const windowLabel = monthWindowLabel(fromMonth, toMonth);
  const fromLabel = formatMonthYear(from);
  const toLabel = formatMonthYear(`${toMonth}-01`);

  return {
    movedCents,
    departureCount: departures.length,
    headline: formatCents(movedCents),
    headlineNoun: `left one account for another, ${windowLabel}`,
    summary:
      "None of this is income and none of it is spending — nothing here left your net worth, it only changed pockets. " +
      "It is counted once, on the way out: a transfer's two legs are one movement. Money that went somewhere and came " +
      "back counts twice, because it really did leave twice.",

    routedCents,
    routes,
    otherRouteCount: rest.length,
    otherRouteCents,
    otherRouteNote:
      rest.length === 0
        ? null
        : `${rest.length} smaller ${plural(rest.length, "route", "routes")}`,

    proof: {
      linkedCount: linked.length,
      linkedCents,
      unpairedCount: unpaired.length,
      unpairedCents,
      // departures.length > 0 is guaranteed by the movedCents === 0 return
      unpairedPct: (unpaired.length / departures.length) * 100,
      sentence:
        unpaired.length === 0
          ? `Every one of the ${departures.length} ${plural(departures.length, "departure", "departures")} is linked to an arrival, so the app can show where all of it went.`
          : `${linked.length} of ${departures.length} departures — ${formatCents(linkedCents)} — are linked to an arrival. The other ${unpaired.length}, ${formatCents(unpairedCents)}, have no partner in the ledger, so nothing here can show where that money landed.`,
      mirrorNote:
        mirrorCount === 0
          ? null
          : `${mirrorCount} of those ${plural(mirrorCount, "is", "are")} already sitting opposite an exact-amount row in another account — ${formatCents(mirrorCents)} that one link would account for.`,
      mirrorCount,
      mirrorCents,
      strandedNote:
        strandedCents === 0
          ? null
          : `Of that linked money, ${formatCents(routedCents)} is in the routes above. The last ${formatCents(strandedCents)} carries a link this window could not resolve into a route — its other leg is not inside these months.`,
      strandedCents,
    },

    churnCents: flow.totals.churnCents,
    churnNote:
      flow.totals.churnCents === 0
        ? null
        : `${formatCents(flow.totals.churnCents)} of the routed money came straight back — the same two accounts sending in both directions. The routes are gross rather than netted, because netting a pair against itself would erase movements that really happened.`,

    arrivalCount,
    arrivalCents,
    arrivalNote:
      arrivalCount === 0
        ? null
        : `${formatCents(arrivalCents)} arrived across ${arrivalCount} ${plural(arrivalCount, "leg", "legs")} with no departure linked to it. The money is there and the ledger holds it; what is missing is the other end, so the app cannot say which account it came out of.`,

    cancelledCount: cancelled.size,
    cancelledCents,
    cancelledNote: cancelledTransferNote(cancelled.size, cancelledCents, formatCents, "counted above"),

    otherPartyCount: otherParty.length,
    otherPartyNote:
      otherParty.length === 0
        ? null
        : `${otherParty.length} more transfer ${plural(otherParty.length, "row", "rows")} — ${formatCents(otherPartyIn)} in, ${formatCents(otherPartyOut)} out — sit in categories the pairer never stamps, and ${otherPartyPaired === 0 ? "not one of them is paired" : `${otherPartyPaired} of them ${plural(otherPartyPaired, "is", "are")} paired`}. Money moves there too, but nothing here can tell which of it went between two of your own accounts and which went to somebody else, so none of it is counted above.`,

    // the window's OWN month count, which the ledger may have shortened
    months: window.months,
    fromMonth,
    toMonth,
    fromLabel,
    toLabel,
    today,
  };
}
