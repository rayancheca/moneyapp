import { payGap } from "./cash-earnings";
import { compareDates } from "./dates";
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
 * ⛔ READ means passed AND on or before the day every account the pay lands in is checked through — `cashEarnings`'
 * own as-of-the-frontier reading: a payday dated today has passed only once a deposit lands today. A payday after the
 * checked day is never short; the note names it as not looked for (decision 65) when no deposit has settled it.
 */

/** A settlement, and what it walked: the paydays it drew and the deposits that had arrived. */
export interface SettlementWalked extends Pick<PaydaySettlement, "settledBy" | "portions"> {
  paydays: readonly PaydayOccurrence[];
  deposits: readonly AttributedDeposit[];
}

export interface PayShortfallWindow {
  /** the window, inclusive at both ends */
  from: string;
  to: string;
  today: string;
  /** the last day every account the pay lands in has been checked through (`checkedThroughBySeries`), or null */
  checkedThrough: string | null;
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
   * banked (`daysThatBanked`), as the settlement's `deposits` are: its portions are taken off it (`paidAcross`)
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
   * deposit paid (`noPaydayInsideCents`); money that paid another window's payday never is (`paidAcross`).
   */
  bankedInsideCents: number;
  /** of `bankedInsideCents`, the money that paid no payday (`towardNoPayday`'s days) — "went toward no payday" */
  noPaydayInsideCents: number;
  /**
   * What the read paydays came to beyond the window's own money — `payGap`'s read part over every deposit inside it
   * less `paidAcross`: the dashboard's "never reached a bank", over this window. Zero when the window banked them;
   * then there is no shortfall to explain.
   */
  shortCents: number;
  /** the money deposits OUTSIDE the window put into the read paydays, per deposit day, oldest first */
  paidOutside: readonly PaidOutside[];
  /** the shortfall less that money, never below zero — what no deposit, inside the window or out, made up */
  neverBankedCents: number;
  /**
   * The money deposits INSIDE the window put into READ paydays OUTSIDE it, per side (before it, then after it) and
   * deposit day, oldest first — counted by the window whose payday it paid, so never against this one's. Money for a
   * payday no window reads is not in it: it stays this window's own, netted (`otherBeyondCents` when it is beyond).
   */
  paidAcross: readonly PaidAcross[];
  /**
   * The rest of the window's own money: what was banked inside it beyond `bankedInsideCents` and `paidAcross` —
   * money that paid no payday and had no unpaid payday left to net (`noPaydayBeyondCents`), and the rest
   * (`otherBeyondCents`: pay for a payday not yet read or not yet passed, or change over a payday's worth).
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
}

export function payShortfall(s: SettlementWalked, w: PayShortfallWindow, e: WindowEarnings): PayShortfall {
  const inWindow = (day: string): boolean => compareDates(day, w.from) >= 0 && compareDates(day, w.to) <= 0;
  // `cashEarnings`' rule: today's payday is earned only once a deposit has landed today
  const paidToday = s.deposits.some((d) => d.postedOn === w.today);
  const passed = (day: string): boolean => compareDates(day, w.today) < 0 || (day === w.today && paidToday);
  const checked = (day: string): boolean => w.checkedThrough !== null && compareDates(day, w.checkedThrough) <= 0;

  const due = s.paydays.filter((o) => inWindow(o.date) && passed(o.date));
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
  const crossed = paidForAnotherWindow.filter((p) => passed(p.paydayOn) && checked(p.paydayOn));
  const paidAcross = [
    ...byDepositDay(crossed.filter((p) => compareDates(p.paydayOn, w.from) < 0)).map((p) => ({ ...p, early: false })),
    ...byDepositDay(crossed.filter((p) => compareDates(p.paydayOn, w.to) > 0)).map((p) => ({ ...p, early: true })),
  ];
  const ownCents = e.bankedCents - centsOf(crossed);

  // ⛔ the one subtraction (`payGap`): the dashboard's, over this window's own money — what is not read is not short
  const { readGapCents: shortCents } = payGap(e.impliedCents, ownCents, e.impliedCents - e.read.cents);
  const outsideCents = centsOf(paidOutside);
  const neverBankedCents = Math.max(0, shortCents - outsideCents);
  // ⛔ the sentence's split adds up to the paydays, and every deposit outside keeps the money it put in — so when
  // outside money paid more than the net shortfall (money inside paid no payday), the banked figure is what is left
  const bankedInsideCents = Math.max(0, e.read.cents - outsideCents - neverBankedCents);

  const noPayday = towardNoPayday(s, inWindow);
  // what the window's money that paid its read paydays came to: what the banked figure holds beyond it was netted
  const paidReadCents = centsOf(s.portions.filter((p) => inWindow(p.depositOn) && readDays.has(p.paydayOn)));
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
    paidAcross,
    noPaydayBeyondCents,
    otherBeyondCents: beyondCents - noPaydayBeyondCents,
    unlookedPaydays: due.filter((o) => !checked(o.date) && !s.settledBy.has(o.date)).length,
    towardNoPayday: noPayday,
    paidAhead,
  };
}

const centsOf = (parts: readonly { cents: number }[]): number => parts.reduce((sum, p) => sum + p.cents, 0);

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
