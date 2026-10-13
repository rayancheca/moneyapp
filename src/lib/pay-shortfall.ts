import { compareDates } from "./dates";
import {
  portionsAcross,
  type AttributedDeposit,
  type PaydayOccurrence,
  type PaydaySettlement,
} from "./payday-settlement";

/**
 * A window's READ paydays against the settlement — what /spending's shortfall note prints
 * (`cashEarningsSectionNotes`), the mirror of its surplus note.
 *
 * 🔴 Read on his ledger 2026-10-13: /spending September said "banked $1,141.92 more than its paydays over Sep 3 – 24,
 * 2026 came to … a backlog clearing" (the Sep 24 deposit paid Aug 27), while August — whose paydays Aug 6, 13 and 20
 * no deposit paid and whose Aug 27 the Sep 24 deposit did — said nothing at all, beside "INCOME $54.12", and June read
 * Salary $1,447.00 against four paydays of $4,188.00 in silence. The dashboard's Earned vs banked said "$11,117.00 of
 * it never reached a bank" of the same weeks. The only sentence about unbanked pay was gated on a STALE series, and
 * his is "Awaiting statements" — two quiet paydays past Wells Fargo's checked Sep 24 — so every window was silent.
 *
 * ⛔ NO SECOND ALLOCATION. The paydays are the ones the settlement walked (`SeriesPaydaySettlement.paydays`, each at its
 * own era's rate) and the money is its `portions`, sorted by the window in `portionsAcross`' one spelling — so a payday
 * this calls paid by the deposit of Sep 24 is one the calendar draws "paid by the deposit of" Sep 24, and /budgets'
 * fourth figure counts. Pure, so the boundaries are tested here and not through a ledger.
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

/** The money from one deposit day outside the window that paid read paydays inside it. */
export interface PaidOutside {
  depositOn: string;
  /** the paydays it went into, oldest first */
  paydays: readonly string[];
  cents: number;
  /** it landed before the window began — "paid early" (§6A 29); otherwise after it ended */
  early: boolean;
}

export interface PayShortfall {
  /** the window's paydays that have passed on days the ledger has checked */
  readPaydays: number;
  firstReadOn: string | null;
  lastReadOn: string | null;
  /** what those paydays were worth, each at its own rate — the settlement's own drawing */
  readCents: number;
  /** of that, the money deposits INSIDE the window put into them */
  bankedInsideCents: number;
  /** …the money deposits OUTSIDE it put into them, per deposit day, oldest first */
  paidOutside: readonly PaidOutside[];
  /** …and the rest, which no deposit put into them */
  neverBankedCents: number;
  /** the window's passed paydays after the checked day that no deposit has settled — not looked for */
  unlookedPaydays: number;
  /** deposit days inside the window whose money paid no payday at all (`PaydayReading.towardNoPayday`) */
  towardNoPayday: readonly { depositOn: string; cents: number }[];
}

export function payShortfall(s: SettlementWalked, w: PayShortfallWindow): PayShortfall {
  const inWindow = (day: string): boolean => compareDates(day, w.from) >= 0 && compareDates(day, w.to) <= 0;
  // `cashEarnings`' rule: today's payday is earned only once a deposit has landed today
  const paidToday = s.deposits.some((d) => d.postedOn === w.today);
  const passed = (day: string): boolean => compareDates(day, w.today) < 0 || (day === w.today && paidToday);
  const checked = (day: string): boolean => w.checkedThrough !== null && compareDates(day, w.checkedThrough) <= 0;

  const due = s.paydays
    .filter((o) => inWindow(o.date) && passed(o.date))
    .sort((a, b) => compareDates(a.date, b.date));
  const read = due.filter((o) => checked(o.date));
  const readDays = new Set(read.map((o) => o.date));

  const bankedInsideCents = s.portions
    .filter((p) => readDays.has(p.paydayOn) && inWindow(p.depositOn))
    .reduce((sum, p) => sum + p.cents, 0);
  const { paidByAnotherWindow } = portionsAcross(s.portions, {
    paydayInside: (day) => readDays.has(day),
    depositInside: inWindow,
  });
  const paidOutside = byDepositDay(paidByAnotherWindow, w.from);
  const readCents = read.reduce((sum, o) => sum + o.amountCents, 0);
  const outsideCents = paidOutside.reduce((sum, p) => sum + p.cents, 0);

  return {
    readPaydays: read.length,
    firstReadOn: read[0]?.date ?? null,
    lastReadOn: read.at(-1)?.date ?? null,
    readCents,
    bankedInsideCents,
    paidOutside,
    neverBankedCents: readCents - bankedInsideCents - outsideCents,
    unlookedPaydays: due.filter((o) => !checked(o.date) && !s.settledBy.has(o.date)).length,
    towardNoPayday: towardNoPayday(s, inWindow),
  };
}

function byDepositDay(portions: readonly PaydaySettlement["portions"][number][], from: string): PaidOutside[] {
  const days = new Map<string, { paydays: Set<string>; cents: number }>();
  for (const p of portions) {
    const day = days.get(p.depositOn) ?? { paydays: new Set<string>(), cents: 0 };
    days.set(p.depositOn, { paydays: new Set([...day.paydays, p.paydayOn]), cents: day.cents + p.cents });
  }
  return [...days]
    .sort(([a], [b]) => compareDates(a, b))
    .map(([depositOn, d]) => ({
      depositOn,
      paydays: [...d.paydays].sort(compareDates),
      cents: d.cents,
      early: compareDates(depositOn, from) < 0,
    }));
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
