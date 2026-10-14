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
  /** every deposit attributed to the series inside the window — money that paid no payday too */
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

export interface PayShortfall {
  /** the window's paydays that have passed on days the ledger has checked */
  readPaydays: number;
  firstReadOn: string | null;
  lastReadOn: string | null;
  /** what those paydays were worth, each at its own rate */
  readCents: number;
  /** every deposit attributed to the series inside the window — net: money that paid no payday is in it */
  bankedInsideCents: number;
  /**
   * What the read paydays came to beyond that — `payGap`'s read part: the dashboard's "never reached a bank", over
   * this window. Zero when the window banked them; then there is no shortfall to explain.
   */
  shortCents: number;
  /** the money deposits OUTSIDE the window put into the read paydays, per deposit day, oldest first */
  paidOutside: readonly PaidOutside[];
  /** the shortfall less that money, never below zero — what no deposit, inside the window or out, made up */
  neverBankedCents: number;
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

  // ⛔ the one subtraction (`payGap`): the dashboard's, over this window — what is not read is not short
  const { readGapCents: shortCents } = payGap(e.impliedCents, e.bankedCents, e.impliedCents - e.read.cents);
  const outsideCents = paidOutside.reduce((sum, p) => sum + p.cents, 0);

  return {
    readPaydays: e.read.paydays,
    firstReadOn: e.read.firstOn,
    lastReadOn: e.read.lastOn,
    readCents: e.read.cents,
    bankedInsideCents: e.bankedCents,
    shortCents,
    paidOutside,
    neverBankedCents: Math.max(0, shortCents - outsideCents),
    unlookedPaydays: due.filter((o) => !checked(o.date) && !s.settledBy.has(o.date)).length,
    towardNoPayday: towardNoPayday(s, inWindow),
    paidAhead,
  };
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
