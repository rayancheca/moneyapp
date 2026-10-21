import { payGap, silenceFrom, unbankedSplit } from "./cash-earnings";
import { addDays, compareDates } from "./dates";
import { formatCents } from "./money";
import { paydayIsRead, paydayLandingIsRead } from "./occurrence-verdict";
import {
  portionsAcross,
  type AttributedDeposit,
  type PaydayOccurrence,
  type PaydaySettlement,
  type SettlementPortion,
} from "./payday-settlement";

/**
 * A window's pay against the settlement — what /spending's two pay notes print beside its figures
 * (`cashEarningsSectionNotes`): the shortfall note, and the split of its mirror, the surplus note.
 *
 * 🔴 Read on his ledger 2026-10-13: /spending September said "banked $1,141.92 more than its paydays over Sep 3 – 24,
 * 2026 came to … a backlog clearing" (the Sep 24 deposit paid Aug 27), while August — whose paydays Aug 6, 13 and 20
 * no deposit paid and whose Aug 27 the Sep 24 deposit did — said nothing at all, beside "INCOME $54.12", and June read
 * Salary $1,447.00 against four paydays of $4,188.00 in silence. The dashboard's Earned vs banked said "$11,117.00 of
 * it never reached a bank" of the same weeks. The only sentence about unbanked pay was gated on a STALE series, and
 * his is "Awaiting statements" — two quiet paydays past Wells Fargo's checked Sep 24 — so every window was silent.
 *
 * ⚖️ THE FIGURE IS EARNED VS BANKED'S (decision 55, approved with its measured figures): what the window's READ paydays
 * imply less what was banked inside it — `payGap`, the dashboard's own subtraction, over the dashboard's own readings
 * (`WindowEarnings`, `cashEarnings`). Net, so money banked inside the window that paid no payday reduces it. 🔴 Built
 * from the settlement's unpaid weeks instead, /spending ALL and YTD said "$11,517.00 never reached a bank" beside the
 * dashboard's "$11,117.00 of it" for the same nineteen paydays — his Jun 5 $400.00 (review of a4b0fca, his ledger copy
 * 2026-10-13) — and a window that banked its whole schedule unevenly ($950.00 one week, $1,050.00 the next) read a
 * short week as money that "never reached a bank".
 *
 * ⛔ …LESS THE MONEY THAT PAID ANOTHER WINDOW'S PAYDAY (`paidAcross`). That money is the other window's: its note
 * names it paying its own payday, so netting it here too counted it twice. 🔴 Review of 2a415d5: with Wed Sep 30
 * paying Thu Oct 1 and Sep 17 never banked, September printed nothing while October named the $1,141.92 paid early;
 * on his ledger copy with the next Wells Fargo statement simulated, Q3 read "$7,234.08 never reached a bank" beside
 * July's $5,235.00 and August's $3,141.00, and June + Q3 came to $9,975.08 beside YTD's $11,117.00.
 *
 * ⛔ …AND ONLY INTO A READ PAYDAY: the mirror of the other window's `paidOutside`, which names money from outside it
 * paying its READ paydays and no others — so every portion is counted by exactly one window, or by none. A payday no
 * window reads — not yet passed (Wednesday's money for tomorrow's Thursday), or passed but after the checked day —
 * keeps its money netted here, as Earned vs banked nets it. Then the windows a period is cut into add up to it SIGNED
 * (what no deposit made up, less the money beyond the read paydays, which a window over them nets), and ALL and YTD
 * read the dashboard's figure to the cent. Unsigned they need not: a month's surplus is its quarter's netting — on the
 * copy below, Q3's $7,234.08 is July's $5,235.00 and August's $3,141.00 less the $1,141.92 September's note names
 * paying Oct 1 early. 🔴 Review of 3dc6527: crossing into any PASSED payday took Wed Sep 30's money for Thu Oct 1 out
 * of September and Q3 while Wells Fargo was checked through Sep 24 — and no window counts Oct 1, nor does the
 * dashboard, which nets that deposit. On his ledger copy with Sep 30 imported past the statement, June + Q3 + Q4 read
 * $11,117.00 never reached a bank beside YTD's and the dashboard's $9,975.08; checked through Wed Sep 30 with Sep 17
 * never banked, September read "$1,141.92 never reached a bank" while the window over it, the year and the dashboard
 * ("all of it is for paydays after Sep 30") said nothing of it.
 *
 * ⛔ NO SECOND ALLOCATION of who paid what. Which deposit outside the window paid which payday inside it — and which
 * deposit inside it paid a later payday early — is the settlement's `portions`, sorted by `portionsAcross`' one
 * spelling, so a payday this calls paid by the deposit of Sep 24 is one the calendar draws "paid by the deposit of"
 * Sep 24, and /budgets' fourth figure and its mirror count. Pure, so the boundaries are tested here.
 *
 * ⚖️ …SO MONEY OUT ON A DAY OF ITS OWN NEVER TAKES A PAID PAYDAY BACK (his decision 75: "a day of its own that banked
 * nothing, and the deposit's day pays as it always has"). It nets the window's money that paid no read payday, a whole
 * day at a time; a day that money cannot cover is named, whole, beside the split (`wentBackOut`) — the one rule
 * (`moneyOutOfWindow`) Earned vs banked reads too. So the window's own money is never below what paid its read
 * paydays, and a window with no read payday is short nothing. 🔴 Review of 36f212f: netted unnamed, October read
 * "paydays came to $0.00, and none of it reached a bank" and Sep 21 – 27 read Sep 24 unbanked beside the deposit that
 * paid it.
 *
 * ⛔ READ means passed AND on or before the day every account the pay lands in is checked through — `cashEarnings`'
 * own as-of-the-frontier reading: a payday dated today has passed only once a deposit lands today. A payday after the
 * checked day is never short; the note names it as not looked for (decision 65) when no deposit has settled it — and
 * the window's money that paid it (`paidUnread`), which a window over this one nets, is named too. 🔴 Review of
 * 36f212f: his ledger copy with Wed Oct 7 imported past the Sep 24 statement netted Oct 7's $1,141.92 into the year's
 * $8,833.16, and October, whose own Thu Oct 8 it paid, said nothing. ⛔ So is the money for a payday OUTSIDE the
 * window's passed ones that no window reads (`paidUncounted`), with the payday the settlement says it paid — "early"
 * when that payday is not before the window. 🔴 Review of f6da264: on that copy, on Wed Oct 7, October and Q4 said
 * Oct 7's $1,141.92 "went toward no payday on or before Thu, Sep 24, 2026" while the week said it paid Oct 8 early.
 *
 * ⚖️ …and "never reached a bank" only of a read payday checked through its DAYS TO LAND (`paydayLandingIsRead`): one
 * still inside them that no deposit settled is "not banked yet" (`paydaysNotBankedYet`, `unbankedSplit`), the words
 * the forecast's note and Earned vs banked say it in.
 */

/** A settlement, and what it walked: the paydays it drew and the deposits that had arrived. */
export interface SettlementWalked extends Pick<PaydaySettlement, "settledBy" | "portions"> {
  paydays: readonly PaydayOccurrence[];
  /** the days that BANKED money (`daysThatBanked`): each day's net, money in */
  deposits: readonly AttributedDeposit[];
  /** the days money went back out on, a day of its own (`daysThatWentBackOut`): each day's net, negative */
  wentBackOut: readonly AttributedDeposit[];
}

export interface PayShortfallWindow {
  /** the window, inclusive at both ends */
  from: string;
  to: string;
  today: string;
  /** the last day every account the pay lands in has been checked through (`checkedThroughBySeries`), or null */
  checkedThrough: string | null;
  /** the series' days to land (`toleranceDays`): how long after a payday its deposit can still answer it */
  toleranceDays: number;
}

/**
 * The window as Earned vs banked measures it — `cashEarnings` over the window, and again as of the checked day. ⛔ The
 * readings the dashboard's card subtracts, so `payGap` is handed the same numbers on both surfaces.
 */
export interface WindowEarnings {
  /** every passed payday inside the window, each at its own rate */
  impliedCents: number;
  /**
   * every deposit attributed to the series inside the window — money that paid no payday too — read by the DAY that
   * banked (`daysThatBanked`), as the settlement's `deposits` are: its portions are taken off it (`paidAcross`), and the
   * money out on a day of its own it can net (`moneyOutOfWindow`). ⛔ `cashEarnings`' own figure, before that rule.
   */
  bankedCents: number;
  /** of those paydays, the READ ones: on or before the checked day (none when nothing is checked) */
  read: { paydays: number; cents: number; firstOn: string | null; lastOn: string | null };
}

/** The money from one deposit day outside the window that paid read paydays inside it. */
export interface PaidOutside {
  depositOn: string;
  /** the paydays it went into, oldest first */
  paydays: readonly string[];
  cents: number;
  /** it landed before the window began — "paid early" (§6A 29); otherwise after it ended */
  early: boolean;
}

/** The money from one deposit day inside the window that paid a LATER payday early — one the window does not count. */
export interface PaidAhead {
  depositOn: string;
  /** the paydays it went into, oldest first */
  paydays: readonly string[];
  cents: number;
}

/** The money from one deposit day inside the window that paid a READ payday outside it — another window's. */
export interface PaidAcross extends PaidAhead {
  /** the payday is after the window — "paid early" (§6A 29); otherwise before it began */
  early: boolean;
}

export interface PayShortfall {
  /** the window's paydays that have passed on days the ledger has checked */
  readPaydays: number;
  firstReadOn: string | null;
  lastReadOn: string | null;
  /** what those paydays were worth, each at its own rate */
  readCents: number;
  /**
   * Of `readCents`, what was banked inside the window toward them — net (decision 55): with `paidOutside` and
   * `neverBankedCents` it adds up to `readCents`. Money that paid no payday is in it as far as it nets a payday no
   * deposit paid (`noPaydayInsideCents`); money that paid another window's payday never is (`paidAcross`). Never
   * below what the window's deposits paid into those paydays: money out on a day of its own takes none back.
   */
  bankedInsideCents: number;
  /** of `bankedInsideCents`, the money that paid no payday (`towardNoPayday`'s days) — "went toward no payday" */
  noPaydayInsideCents: number;
  /**
   * What the read paydays came to beyond the window's own money — `payGap`'s read part over every deposit inside it
   * less `paidAcross`, net of the money out it could net (`wentBackOut`): the dashboard's "never reached a bank", over
   * this window. Zero when the window banked them — and always when it reads no payday.
   */
  shortCents: number;
  /** the money deposits OUTSIDE the window put into the read paydays, per deposit day, oldest first */
  paidOutside: readonly PaidOutside[];
  /**
   * What no deposit, inside the window or out, made up — the shortfall less that money, never below zero — for paydays
   * checked through their days to land: "never reached a bank".
   */
  neverBankedCents: number;
  /**
   * …and the rest of it, for read paydays no deposit settled that are still inside their days to land
   * (`paydaysNotBankedYet`, `unbankedSplit`): "not banked yet". With `neverBankedCents`, what no deposit made up.
   */
  notBankedYetCents: number;
  /** those paydays, oldest first — none when `notBankedYetCents` is zero */
  notBankedYetPaydays: readonly string[];
  /**
   * The money deposits INSIDE the window put into READ paydays OUTSIDE it, per side (before it, then after it) and
   * deposit day, oldest first — counted by the window whose payday it paid, so never against this one's. Money for a
   * payday no window reads is not in it: it stays this window's own, netted (`otherBeyondCents` when it is beyond).
   */
  paidAcross: readonly PaidAcross[];
  /**
   * The rest of the window's own money: what was banked inside it beyond `bankedInsideCents` and `paidAcross` —
   * money that paid no payday and had no unpaid payday left to net (`noPaydayBeyondCents`), and the rest
   * (`otherBeyondCents`: pay for a payday not yet read or not yet passed — `paidUnread`, `paidUncounted` — or change
   * over a payday's worth).
   */
  noPaydayBeyondCents: number;
  otherBeyondCents: number;
  /** the window's passed paydays after the checked day that no deposit has settled — not looked for */
  unlookedPaydays: number;
  /** deposit days inside the window whose money paid no payday at all (`PaydayReading.towardNoPayday`) */
  towardNoPayday: readonly { depositOn: string; cents: number }[];
  /**
   * The money deposits INSIDE the window put into paydays after the ones it counts — a later window's, or its own not
   * yet passed — per deposit day, oldest first: "paid early" (§6A 29), named from the payday's side by /budgets.
   */
  paidAhead: readonly PaidAhead[];
  /**
   * The money deposits INSIDE the window put into its OWN passed paydays after the checked day — paydays no window
   * reads, so a window over this one nets that money as Earned vs banked does — per deposit day, oldest first. Part of
   * `otherBeyondCents` as far as it is beyond the read paydays.
   */
  paidUnread: readonly PaidAhead[];
  /**
   * The money deposits INSIDE the window put into paydays OUTSIDE its passed ones that no window reads — not yet
   * passed (Wednesday's money for tomorrow's Thursday), or passed but after the checked day, before the window or
   * after it — per side (before it, then from its first day on) and deposit day, oldest first. `paidAcross`' other
   * half: no window counts these paydays, so the money stays this window's own, netted as Earned vs banked nets it, and
   * part of `otherBeyondCents` as far as it is beyond the read paydays. `early` when the payday is on or after the
   * window's first day — after the deposit, the surplus note's "paid early" (§6A 29); otherwise paid late.
   */
  paidUncounted: readonly PaidAcross[];
  /**
   * ⚖️ Money that went back out on a day of its own inside the window and that the window's money paying no read
   * payday could not take (decision 75: the deposit's day pays as it always has) — per day, whole, oldest first.
   * Never taken off the banked figure: with it, the window's parts add up to what it banked, net.
   */
  wentBackOut: readonly WentBackOut[];
  /**
   * What the window banked by the one rule (`moneyOutOfWindow`): its days that banked, less the money out it netted —
   * Earned vs banked's figure, and every banked figure /spending prints of the window. Less `wentBackOut`, it is every
   * row inside the window, net.
   */
  bankedCents: number;
}

/** A day money went back out on, a day of its own (decision 75): the day's net, as money out — positive. */
export interface WentBackOut {
  postedOn: string;
  cents: number;
}

/** A window's banked figure by the one rule for money out on a day of its own, and the days it names. */
export interface WindowMoneyOut {
  /** the window's days that banked, less the money out on days of their own that it netted */
  bankedCents: number;
  /** the days of money out it could not net, each whole, oldest first */
  wentBackOut: readonly WentBackOut[];
}

/** `cashEarnings`' rule: a payday has passed by `today` — one dated today only once a deposit has landed today. */
function passedBy(s: Pick<SettlementWalked, "deposits">, today: string): (day: string) => boolean {
  const paidToday = s.deposits.some((d) => d.postedOn === today);
  return (day) => compareDates(day, today) < 0 || (day === today && paidToday);
}

/** The window's passed paydays (`passedBy`). */
function duePaydays(s: Pick<SettlementWalked, "paydays" | "deposits">, w: PayShortfallWindow): PaydayOccurrence[] {
  const passed = passedBy(s, w.today);
  return s.paydays.filter(
    (o) => compareDates(o.date, w.from) >= 0 && compareDates(o.date, w.to) <= 0 && passed(o.date),
  );
}

/** The paydays a window's checked pay is "not banked yet" for, and what they come to. */
export interface NotBankedYet {
  /** oldest first */
  paydays: readonly string[];
  cents: number;
}

/**
 * The window's passed paydays no deposit settled that were checked on their day (`paydayIsRead`) but not through their
 * days to land (`paydayLandingIsRead`) — a deposit can still answer them on a day the ledger has not read. The
 * forecast's checked paydays short of its warning (`pastGraceOccurrenceCount`), over any window: what Earned vs banked
 * and /spending's shortfall note call "not banked yet" (`unbankedSplit`), never "never reached a bank".
 *
 * ⛔ Settled is the settlement's answer (`settledBy`), never a date match: a deposit that paid the payday has come, and
 * its payday stays checked. Measured on his ledger copy 2026-10-21, Wells Fargo checked through Thu Sep 24, whose
 * payday its own deposit paid: read instead as a frontier moved back by the days to land (Sep 21), Earned vs banked's
 * "$11,117.00 of it never reached a bank" (decision 55's figure) became $9,975.08, and "the other $3,425.76 is for
 * paydays after Sep 24" became $4,567.68 — Sep 24's paid $1,141.92 among it.
 */
export function paydaysNotBankedYet(
  s: Pick<SettlementWalked, "paydays" | "deposits" | "settledBy">,
  w: PayShortfallWindow,
): NotBankedYet {
  const pending = duePaydays(s, w)
    .filter((o) => !s.settledBy.has(o.date))
    .filter((o) => paydayIsRead(o.date, w.checkedThrough))
    .filter((o) => !paydayLandingIsRead(o.date, w.toleranceDays, w.checkedThrough))
    .sort((a, b) => compareDates(a.date, b.date));
  return { paydays: pending.map((o) => o.date), cents: pending.reduce((sum, o) => sum + o.amountCents, 0) };
}

/** Where a schedule's silence is read: where it opens, today, and how far its pay has been checked and may land. */
export interface ScheduleSilence {
  /** the last day that banked money (`CashEarnings.lastBankedOn`), or null when none has */
  lastBankedOn: string | null;
  /** the schedule's first payday (`PaySeries.startedOn`): where the silence opens when nothing has banked */
  startedOn: string;
  today: string;
  checkedThrough: string | null;
  toleranceDays: number;
}

/**
 * Of a schedule's SILENCE, the paydays not banked yet (`paydaysNotBankedYet`), oldest first: what a stale schedule's
 * quiet says of the checked paydays still inside their days to land — Earned vs banked's verdict
 * (`checkedSilentNotBankedYet`) and /spending's note for a stale schedule, both schedule-wide sentences.
 *
 * ⛔ THE SILENCE'S paydays, never a window's: strictly after the day it opens on (`silenceFrom`) through today, as
 * `cashEarnings` counts `periodsSinceBanked` and `checkedSilence` caps it — an unpaid payday before the last deposit is
 * the difference's not-banked-yet part, never the silence's. 🔴 Review of c02a4b0: /spending's note took them from the
 * WINDOW's shortfall, so August (no Sep 3 in it) printed the same schedule-wide sentence without Sep 3's reason, and a
 * window holding Aug 13 — unpaid before Fri Aug 14's deposit — named it where the verdict named Aug 20, Aug 27 and
 * Sep 3.
 *
 * ⛔ …and with nothing banked, from the schedule's first payday, where the sentence counts it from ("no deposit has
 * ever been attributed to it"). Earned vs banked's verdict prints its no-deposit sentence then and names none. 🔴
 * Review of 147f167 (MEDIUM): it returned none — "there is no 'since' to count from" — so with the only payroll a
 * $1,000.00 on Thu Jun 4 returned the same day (decision 75), Chase read through Sat Sep 5 and today Sep 15, every
 * /spending window read "14 expected paydays have passed … or the ledger has not looked for its deposit" and left out
 * Sep 3, which the window's shortfall and the dashboard's difference both called not banked yet.
 */
export function silentPaydaysNotBankedYet(
  s: Pick<SettlementWalked, "paydays" | "deposits" | "settledBy">,
  silence: ScheduleSilence,
): readonly string[] {
  const { lastBankedOn, startedOn, today, checkedThrough, toleranceDays } = silence;
  // a payday unchecked on its day is never one (`paydayIsRead`) — nor, with nothing checked, is any
  const from = addDays(silenceFrom(lastBankedOn, startedOn), 1);
  return paydaysNotBankedYet(s, { from, to: today, today, checkedThrough, toleranceDays }).paydays;
}

/** The window's days as every reading here takes them: inside it, passed (`passedBy`) and checked. */
function windowDays(s: SettlementWalked, w: PayShortfallWindow) {
  const inWindow = (day: string): boolean => compareDates(day, w.from) >= 0 && compareDates(day, w.to) <= 0;
  // `cashEarnings`' rule: today's payday is earned only once a deposit has landed today
  const passed = passedBy(s, w.today);
  const checked = (day: string): boolean => paydayIsRead(day, w.checkedThrough);
  return { inWindow, passed, checked };
}

export function payShortfall(s: SettlementWalked, w: PayShortfallWindow, e: WindowEarnings): PayShortfall {
  const { inWindow, passed, checked } = windowDays(s, w);

  const due = duePaydays(s, w);
  const readDays = new Set(due.filter((o) => checked(o.date)).map((o) => o.date));
  const dueDays = new Set(due.map((o) => o.date));

  const { paidByAnotherWindow } = portionsAcross(s.portions, {
    paydayInside: (day) => readDays.has(day),
    depositInside: inWindow,
  });
  // …and the other way: this window's money in a payday it does not count, later than its own — never one before it
  const { paidForAnotherWindow } = portionsAcross(s.portions, {
    paydayInside: (day) => dueDays.has(day),
    depositInside: inWindow,
  });
  const paidOutside = byDepositDay(paidByAnotherWindow).map((p) => ({
    ...p,
    early: compareDates(p.depositOn, w.from) < 0,
  }));
  const paidAhead = byDepositDay(paidForAnotherWindow.filter((p) => compareDates(p.paydayOn, w.from) >= 0));
  // ⛔ another window's money: a READ payday outside this one, which that window's `paidOutside` names — never one
  // not yet due, nor one past the checked day, which no window counts and Earned vs banked nets
  const read = (p: SettlementPortion): boolean => passed(p.paydayOn) && checked(p.paydayOn);
  const crossed = paidForAnotherWindow.filter(read);
  const paidAcross = [
    ...byDepositDay(crossed.filter((p) => compareDates(p.paydayOn, w.from) < 0)).map((p) => ({ ...p, early: false })),
    ...byDepositDay(crossed.filter((p) => compareDates(p.paydayOn, w.to) > 0)).map((p) => ({ ...p, early: true })),
  ];
  // …and the rest of it, for a payday no window reads: the window's own money still, named with the payday it paid
  const uncounted = paidForAnotherWindow.filter((p) => !read(p));
  const beforeWindow = (p: SettlementPortion): boolean => compareDates(p.paydayOn, w.from) < 0;
  const paidUncounted = [
    ...byDepositDay(uncounted.filter(beforeWindow)).map((p) => ({ ...p, early: false })),
    ...byDepositDay(uncounted.filter((p) => !beforeWindow(p))).map((p) => ({ ...p, early: true })),
  ];
  // what the window's money that paid its read paydays came to: what the banked figure holds beyond it was netted
  const paidReadCents = centsOf(s.portions.filter((p) => inWindow(p.depositOn) && readDays.has(p.paydayOn)));
  // ⛔ the one rule for money out on a day of its own — Earned vs banked's figure — then less another window's money
  const back = moneyOutOfWindow(s, w, e.bankedCents);
  const ownCents = back.bankedCents - centsOf(crossed);

  // ⛔ the one subtraction (`payGap`): the dashboard's, over this window's own money — what is not read is not short,
  // and the window's own money is never below what paid its read paydays, so a window with none read is short nothing
  const { readGapCents: shortCents } = payGap(e.impliedCents, ownCents, e.impliedCents - e.read.cents);
  const outsideCents = centsOf(paidOutside);
  const unmadeUpCents = Math.max(0, shortCents - outsideCents);
  // ⛔ the one split (`unbankedSplit`): "never reached a bank" only of paydays checked through their days to land
  const notBankedYet = paydaysNotBankedYet(s, w);
  const { notBankedYetCents, neverCents: neverBankedCents } = unbankedSplit(unmadeUpCents, notBankedYet.cents);
  // ⛔ the sentence's split adds up to the paydays, and every deposit outside keeps the money it put in — so when
  // outside money paid more than the net shortfall (money inside paid no payday), the banked figure is what is left
  const bankedInsideCents = Math.max(0, e.read.cents - outsideCents - unmadeUpCents);

  const noPayday = towardNoPayday(s, inWindow);
  const noPaydayInsideCents = Math.min(centsOf(noPayday), Math.max(0, bankedInsideCents - paidReadCents));
  const beyondCents = Math.max(0, ownCents - bankedInsideCents);
  const noPaydayBeyondCents = Math.min(beyondCents, centsOf(noPayday) - noPaydayInsideCents);

  return {
    readPaydays: e.read.paydays,
    firstReadOn: e.read.firstOn,
    lastReadOn: e.read.lastOn,
    readCents: e.read.cents,
    bankedInsideCents,
    noPaydayInsideCents,
    shortCents,
    paidOutside,
    neverBankedCents,
    notBankedYetCents,
    notBankedYetPaydays: notBankedYetCents > 0 ? notBankedYet.paydays : [],
    paidAcross,
    noPaydayBeyondCents,
    otherBeyondCents: beyondCents - noPaydayBeyondCents,
    unlookedPaydays: due.filter((o) => !checked(o.date) && !s.settledBy.has(o.date)).length,
    towardNoPayday: noPayday,
    paidAhead,
    paidUnread: byDepositDay(
      s.portions.filter((p) => inWindow(p.depositOn) && dueDays.has(p.paydayOn) && !readDays.has(p.paydayOn)),
    ),
    paidUncounted,
    wentBackOut: back.wentBackOut,
    bankedCents: back.bankedCents,
  };
}

const centsOf = (parts: readonly { cents: number }[]): number => parts.reduce((sum, p) => sum + p.cents, 0);

/**
 * ⚖️ MONEY OUT ON A DAY OF ITS OWN (his decision 75: "a day of its own that banked nothing, and the deposit's day
 * pays as it always has") against a window's banked figure — THE ONE RULE: Earned vs banked's card and every /spending
 * note read it (`cashEarningsReadings`, `payShortfall`). `bankedCents` is the window's days that banked
 * (`daysThatBanked`, `cashEarnings`' own figure), which a later day's money out never touched. The money out nets the
 * window's money that paid NO READ payday, inside the window or out — the payroll a statement has not yet placed,
 * returned before it does; money toward no payday; change — a whole day at a time, oldest first, while that money
 * covers the day; a day it cannot cover is named WHOLE (`wentBackOut`) and never taken off a payday a deposit paid. So
 * the calendar, the card and /spending agree on which paydays were paid, and the money out is named with its day.
 *
 * 🔴 Two rules, one each side of the merge (2026-10-21): Earned vs banked's banked figure took nothing off for a later
 * day's money out and named none (d75-banked, 82f6a3a), while /spending netted it against that figure as if it had —
 * so it netted every return, named none, and the year read $9,975.08 never reached a bank, not $11,117.00, with Wed
 * Sep 30's payroll back out on Fri Oct 2 (his ledger copy 2026-10-21, checked through Thu Sep 24; on it, October and
 * Q4 printed no note at all). Before that, netted unnamed: October read "paydays came to $0.00, and none of it reached
 * a bank", and Sep 21 – 27 read Sep 24 unbanked beside the deposit that paid it (review of 36f212f).
 *
 * ⚖️ DEFAULT (A), BUILT, NOT ASKED (2026-10-21; he said "no more questions"): the card names a later-day return as
 * /spending does, on its day (`wentBackOutPhrase`). Measured on his ledger copy 2026-10-21 with a hypothetical
 * $1,141.92 of pay back out on Fri Sep 25: the card read only "$11,117.00 of it never reached a bank; the other
 * $3,425.76 is for paydays after Sep 24 …" and /spending named the day nowhere; now both name "$1,141.92 went back out
 * on Fri, Sep 25, 2026", the card banks $7,156.60, and the calendar keeps Sep 24 paid by the deposit of Wed, Sep 23.
 * Latent: no money out is linked to his pay on that copy.
 */
export function moneyOutOfWindow(s: SettlementWalked, w: PayShortfallWindow, bankedCents: number): WindowMoneyOut {
  const { inWindow, passed, checked } = windowDays(s, w);
  // the window's money that paid a READ payday, wherever that payday falls: money out never takes it back
  const paidReadCents = centsOf(
    s.portions.filter((p) => inWindow(p.depositOn) && passed(p.paydayOn) && checked(p.paydayOn)),
  );
  const freeCents = Math.max(0, bankedCents - paidReadCents);
  const { leftCents, named } = s.wentBackOut
    .filter((d) => inWindow(d.postedOn))
    .reduce(
      (acc, d) =>
        -d.amountCents <= acc.leftCents
          ? { leftCents: acc.leftCents + d.amountCents, named: acc.named }
          : { leftCents: acc.leftCents, named: [...acc.named, { postedOn: d.postedOn, cents: -d.amountCents }] },
      { leftCents: freeCents, named: [] as WentBackOut[] },
    );
  // what it netted is what it took of that money; a day it named is no part of the figure, which never held it
  return { bankedCents: bankedCents - (freeCents - leftCents), wentBackOut: named };
}

/** "A and B", "A, B, and C" — the platform's list. */
const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * "$1,141.92 went back out on Fri, Oct 2, 2026" — the days `moneyOutOfWindow` names, each whole, oldest first, every
 * day once: the one spelling /spending's notes and Earned vs banked print.
 */
export function wentBackOutPhrase(days: readonly WentBackOut[], formatDay: (iso: string) => string): string {
  const on = [...new Set(days.map((d) => d.postedOn))].sort(compareDates);
  return `${formatCents(centsOf(days))} went back out on ${AND_LIST.format(on.map(formatDay))}`;
}

function byDepositDay(portions: readonly SettlementPortion[]): PaidAhead[] {
  const days = new Map<string, { paydays: Set<string>; cents: number }>();
  for (const p of portions) {
    const day = days.get(p.depositOn) ?? { paydays: new Set<string>(), cents: 0 };
    days.set(p.depositOn, { paydays: new Set([...day.paydays, p.paydayOn]), cents: day.cents + p.cents });
  }
  return [...days]
    .sort(([a], [b]) => compareDates(a, b))
    .map(([depositOn, d]) => ({ depositOn, paydays: [...d.paydays].sort(compareDates), cents: d.cents }));
}

/**
 * The window's deposit days whose money paid no payday at all — the calendar's "toward no payday", read by DAY as
 * `lib/per-payday` reads it (settlement names money by its deposit's day). Change left over from a deposit that paid
 * a payday is not one of them: that day's money answered a week.
 */
function towardNoPayday(s: SettlementWalked, inWindow: (day: string) => boolean): { depositOn: string; cents: number }[] {
  const paying = new Set(s.portions.map((p) => p.depositOn));
  const days = new Map<string, number>();
  for (const d of s.deposits) {
    if (d.amountCents <= 0 || !inWindow(d.postedOn) || paying.has(d.postedOn)) continue;
    days.set(d.postedOn, (days.get(d.postedOn) ?? 0) + d.amountCents);
  }
  return [...days].sort(([a], [b]) => compareDates(a, b)).map(([depositOn, cents]) => ({ depositOn, cents }));
}
