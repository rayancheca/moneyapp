import { describe, expect, test } from "vitest";
import { cashEarnings, type PaySeries } from "./cash-earnings";
import { formatDayLong } from "./format-date";
import {
  payShortfall,
  wentBackOutPhrase,
  type PayShortfall,
  type PayShortfallWindow,
  type WindowEarnings,
} from "./pay-shortfall";
import { settlePaydaysBackwards, type AttributedDeposit, type PaydayOccurrence } from "./payday-settlement";
import { daysThatBanked, daysThatWentBackOut } from "./posted-average";

/**
 * A /spending window's pay read against the settlement — the figures the shortfall note prints, and the split of the
 * surplus note.
 *
 * ⛔ Every settlement here is `settlePaydaysBackwards`' own, never hand-built portions, and every figure `cashEarnings`'
 * own, read as the service reads it (over the window, and as of the checked day): the note must say what the calendar,
 * /budgets and the dashboard's Earned vs banked say of the same paydays, and the only way to hold it to that is to feed
 * it the one rule.
 *
 * His ledger's own shape (a copy, 2026-10-13): cash weeks at $1,047.00 from Thu Jun 4, payroll at $1,141.92 from Aug 27
 * (§6A 55a: money pays only its own era's paydays), Wells Fargo checked through Thu Sep 24, deposits Jun 4 $1,047.00,
 * Jun 5 $400.00, Sep 23 $4,567.68 and Sep 24 $1,141.92.
 */

const CASH = 104_700;
const PAYROLL = 114_192;
const TODAY = "2026-10-13";
const CHECKED = "2026-09-24";
const PAYROLL_FROM = "2026-08-27";

const thursdays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const HIS_PAYDAYS: PaydayOccurrence[] = thursdays("2026-06-04", "2026-10-15").map((date) => ({
  date,
  amountCents: date < PAYROLL_FROM ? CASH : PAYROLL,
}));
const HIS_DEPOSITS: AttributedDeposit[] = [
  { postedOn: "2026-06-04", amountCents: CASH },
  { postedOn: "2026-06-05", amountCents: 40_000 },
  { postedOn: "2026-09-23", amountCents: 4 * PAYROLL },
  { postedOn: "2026-09-24", amountCents: PAYROLL },
];

/**
 * The window as the service reads it: the settlement walked over the paydays and the money that had ARRIVED, and
 * `cashEarnings` over the window and again as of the checked day — Earned vs banked's readings.
 */
function shortfallOf(paydays: PaydayOccurrence[], deposits: AttributedDeposit[], w: PayShortfallWindow) {
  const arrived = deposits.filter((d) => d.postedOn <= w.today);
  const s = settlePaydaysBackwards({
    occurrences: paydays,
    deposits: arrived,
    toleranceDays: 3,
    periodOf: (day) => (day < PAYROLL_FROM ? 0 : 1),
  });
  const twoEras = paydays.some((o) => o.amountCents !== paydays[0]!.amountCents);
  const series: PaySeries = {
    cadence: "weekly",
    intervalDaysAvg: 7,
    anchorDay: null,
    amountCents: paydays.at(-1)!.amountCents,
    amountHistory: twoEras ? [{ throughOn: "2026-08-26", amountCents: CASH }] : null,
    startedOn: paydays[0]!.date,
    // the schedule the settlement walked, and no further: one set of paydays for both readings
    endedOn: paydays.at(-1)!.date,
  };
  const reading = cashEarnings({ series, banked: arrived, from: w.from, to: w.to, today: w.today });
  const c = w.checkedThrough;
  const asChecked =
    c === null
      ? null
      : cashEarnings({
          series,
          banked: arrived,
          from: w.from,
          to: w.to < c ? w.to : c,
          today: c,
          todayIsComplete: c < w.today,
        });
  const e: WindowEarnings = {
    impliedCents: reading.impliedCents,
    bankedCents: reading.bankedCents,
    read:
      asChecked === null
        ? { paydays: 0, cents: 0, firstOn: null, lastOn: null }
        : {
            paydays: asChecked.periodsCovered,
            cents: asChecked.impliedCents,
            firstOn: asChecked.firstPeriodOn,
            lastOn: asChecked.lastPeriodOn,
          },
  };
  // what the service hands it (`paydaySettlement`): the days that banked, and the days money went back out on
  const banked = daysThatBanked(arrived).map((d) => ({ postedOn: d.postedOn, amountCents: d.amountCents }));
  const wentBackOut = daysThatWentBackOut(arrived).map((d) => ({ postedOn: d.postedOn, amountCents: d.amountCents }));
  return payShortfall({ settledBy: s.settledBy, portions: s.portions, paydays, deposits: banked, wentBackOut }, w, e);
}

const his = (from: string, to: string, checkedThrough: string | null = CHECKED, today = TODAY) =>
  shortfallOf(HIS_PAYDAYS, HIS_DEPOSITS, { from, to, today, checkedThrough });

describe("payShortfall — a window's read paydays against what it banked, and the settlement", () => {
  test("August: one payday paid by a later deposit, three that no deposit paid", () => {
    expect(his("2026-08-01", "2026-08-31")).toEqual({
      readPaydays: 4,
      firstReadOn: "2026-08-06",
      lastReadOn: "2026-08-27",
      readCents: 3 * CASH + PAYROLL,
      bankedInsideCents: 0,
      noPaydayInsideCents: 0,
      shortCents: 3 * CASH + PAYROLL,
      paidOutside: [{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: PAYROLL, early: false }],
      neverBankedCents: 3 * CASH,
      paidAcross: [],
      noPaydayBeyondCents: 0,
      otherBeyondCents: 0,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
      paidUnread: [],
      paidUncounted: [],
      wentBackOut: [],
      // August banked nothing: Sep 24's deposit is September's money
      bankedCents: 0,
    });
  });

  test("June: the $400.00 that paid no payday was banked inside the window, so it nets the shortfall (decision 55)", () => {
    const s = his("2026-06-01", "2026-06-30");
    expect(s.readCents).toBe(4 * CASH);
    // the page's Salary $1,447.00, and Earned vs banked's banked figure — every deposit inside the window
    expect(s.bankedInsideCents).toBe(CASH + 40_000);
    expect(s.paidOutside).toEqual([]);
    // 🔴 it read $3,141.00 — the settlement's three unpaid weeks — where the dashboard's arithmetic reads $2,741.00
    expect(s.shortCents).toBe(274_100);
    expect(s.neverBankedCents).toBe(274_100);
    // the calendar's "toward no payday" (§6A 55b), named inside the banked figure — all of it, nothing left over
    expect(s.towardNoPayday).toEqual([{ depositOn: "2026-06-05", cents: 40_000 }]);
    expect([s.noPaydayInsideCents, s.noPaydayBeyondCents, s.otherBeyondCents]).toEqual([40_000, 0, 0]);
  });

  test("September: it banked more than its paydays came to — nothing short, and nothing it paid ahead", () => {
    const s = his("2026-09-01", "2026-09-30");
    expect(s.readPaydays).toBe(4);
    // the Sep 23 lump banked the window's four paydays; Sep 24's deposit is August's (below)
    expect(s.bankedInsideCents).toBe(4 * PAYROLL);
    expect(s.shortCents).toBe(0);
    expect(s.neverBankedCents).toBe(0);
    expect(s.paidOutside).toEqual([]);
    // the Sep 24 deposit paid Aug 27 — EARLIER pay, the surplus note's backlog — and no later payday
    expect(s.paidAcross).toEqual([{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: PAYROLL, early: false }]);
    expect(s.paidAhead).toEqual([]);
    expect(s.towardNoPayday).toEqual([]);
  });

  test("Sep 23 – Sep 23: the lump paid Sep 24, after the window, early — and three weeks before it", () => {
    const s = his("2026-09-23", "2026-09-23");
    expect(s.readPaydays).toBe(0);
    expect(s.paidAhead).toEqual([{ depositOn: "2026-09-23", paydays: ["2026-09-24"], cents: PAYROLL }]);
  });

  test("Wed Sep 30 paying Thu Oct 1 is September's money paid ahead, and October's paid early, by the same day", () => {
    const deposits = [...HIS_DEPOSITS, { postedOn: "2026-09-30", amountCents: PAYROLL }];
    const window = (from: string, to: string) => ({ from, to, today: TODAY, checkedThrough: "2026-10-12" });
    const september = shortfallOf(HIS_PAYDAYS, deposits, window("2026-09-01", "2026-09-30"));
    expect(september.paidAhead).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL }]);
    const october = shortfallOf(HIS_PAYDAYS, deposits, window("2026-10-01", "2026-10-31"));
    expect(october.paidOutside).toEqual([
      { depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true },
    ]);
  });

  test("money that paid one of the window's own paydays past the checked day is never paid ahead", () => {
    // checked through Sun Sep 20: Thu Sep 24 is the window's, unread — the Sep 23 lump paid it inside September
    const s = his("2026-09-01", "2026-09-30", "2026-09-20");
    expect(s.readPaydays).toBe(3);
    expect(s.paidAhead).toEqual([]);
  });

  test("a window straddling the checked day: the paydays after it are not looked for, never short", () => {
    const s = his("2026-09-01", "2026-10-31");
    expect(s.readPaydays).toBe(4);
    expect(s.lastReadOn).toBe("2026-09-24");
    expect(s.readCents).toBe(4 * PAYROLL);
    // Oct 1 and Oct 8 have passed and no checked statement reaches them; Oct 15 has not happened
    expect(s.unlookedPaydays).toBe(2);
    expect(s.shortCents).toBe(0);
    expect(s.neverBankedCents).toBe(0);
  });

  test("…and a payday after the checked day that an imported deposit settled is not waiting on anything", () => {
    const s = shortfallOf(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-09-30", amountCents: PAYROLL }], {
      from: "2026-08-01",
      to: "2026-10-31",
      today: TODAY,
      checkedThrough: CHECKED,
    });
    // Wed Sep 30 pays Thu Oct 1 (inside its tolerance); Oct 8 is the one still quiet
    expect(s.unlookedPaydays).toBe(1);
  });

  test("a payday paid by a deposit BEFORE the window was paid early (§6A 29)", () => {
    const s = shortfallOf(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-09-30", amountCents: PAYROLL }], {
      from: "2026-10-01",
      to: "2026-10-31",
      today: TODAY,
      checkedThrough: "2026-10-12",
    });
    expect(s.readPaydays).toBe(2);
    expect(s.paidOutside).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true }]);
    expect(s.shortCents).toBe(2 * PAYROLL);
    expect(s.neverBankedCents).toBe(PAYROLL);
    expect(s.bankedInsideCents).toBe(0);
  });

  test("a payday dated today has not passed until its deposit lands — cashEarnings' own rule", () => {
    const quiet = his("2026-10-01", "2026-10-31", "2026-10-08", "2026-10-08");
    expect(quiet.readPaydays).toBe(1);
    expect(quiet.lastReadOn).toBe("2026-10-01");
    const paid = shortfallOf(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-10-08", amountCents: PAYROLL }], {
      from: "2026-10-01",
      to: "2026-10-31",
      today: "2026-10-08",
      checkedThrough: "2026-10-08",
    });
    expect(paid.readPaydays).toBe(2);
    expect(paid.bankedInsideCents).toBe(PAYROLL);
  });

  test("an account with no checked record reads no payday — every quiet one is not looked for", () => {
    const s = his("2026-08-01", "2026-08-31", null);
    expect(s.readPaydays).toBe(0);
    expect(s.readCents).toBe(0);
    expect(s.firstReadOn).toBeNull();
    // nothing read is short, however much the window's paydays came to
    expect(s.shortCents).toBe(0);
    // Aug 27 is settled (by Sep 24), so three of August's four are waiting
    expect(s.unlookedPaydays).toBe(3);
  });

  test("a payday paid SHORT is short by what its deposit lacked", () => {
    const s = shortfallOf(
      thursdays("2026-09-03", "2026-09-10").map((date) => ({ date, amountCents: PAYROLL })),
      [
        { postedOn: "2026-09-03", amountCents: PAYROLL },
        { postedOn: "2026-09-10", amountCents: 110_000 },
      ],
      { from: "2026-09-01", to: "2026-09-30", today: TODAY, checkedThrough: CHECKED },
    );
    // the anchor clause answers Sep 10 with the money there was
    expect(s.bankedInsideCents).toBe(PAYROLL + 110_000);
    expect(s.neverBankedCents).toBe(PAYROLL - 110_000);
  });

  test("…but a short week the next week's deposit made up is not short at all: the window banked its schedule", () => {
    // 🔴 review of a4b0fca: $950.00 then $1,050.00 against two $1,000.00 weeks read "$50.00 never reached a bank" —
    // the anchor clause settles Sep 10 short, and the $50.00 over on Sep 17 can pay no other week
    const s = shortfallOf(
      thursdays("2026-09-03", "2026-09-24").map((date) => ({ date, amountCents: 100_000 })),
      [
        { postedOn: "2026-09-03", amountCents: 100_000 },
        { postedOn: "2026-09-10", amountCents: 95_000 },
        { postedOn: "2026-09-17", amountCents: 105_000 },
        { postedOn: "2026-09-24", amountCents: 100_000 },
      ],
      { from: "2026-09-01", to: "2026-09-30", today: "2026-09-28", checkedThrough: "2026-09-26" },
    );
    expect(s.readCents).toBe(400_000);
    expect(s.bankedInsideCents).toBe(400_000);
    expect(s.shortCents).toBe(0);
    expect(s.neverBankedCents).toBe(0);
  });
});

/**
 * 🔴 Review of 2a415d5 (HIGH): the net counted money that crossed the window line twice — every deposit inside the
 * window made up its paydays, including money the settlement says paid ANOTHER window's, which that window's note
 * names too. On his ledger copy with the next Wells Fargo statement simulated (Wed Sep 30 and Oct 7, checked through
 * Thu Oct 8), Q3 read $7,234.08 never reached a bank beside July's $5,235.00 and August's $3,141.00. ⛔ The windows a
 * period is cut into add up to it, and every figure of one window adds up to its paydays and to its deposits.
 */
describe("payShortfall — money that crossed the window line is the other window's", () => {
  const NEXT = [
    ...HIS_DEPOSITS,
    ...["2026-09-30", "2026-10-07"].map((postedOn) => ({ postedOn, amountCents: PAYROLL })),
  ];
  const next = (from: string, to: string) =>
    shortfallOf(HIS_PAYDAYS, NEXT, { from, to, today: TODAY, checkedThrough: "2026-10-08" });
  const bankedIn = (deposits: readonly AttributedDeposit[], from: string, to: string): number =>
    deposits.filter((d) => d.postedOn >= from && d.postedOn <= to).reduce((sum, d) => sum + d.amountCents, 0);

  test("the months add up to the quarter, and the quarters to the year: one $11,117.00", () => {
    const never = (from: string, to: string): number => next(from, to).neverBankedCents;
    const [jul, aug, sep] = [
      never("2026-07-01", "2026-07-31"),
      never("2026-08-01", "2026-08-31"),
      never("2026-09-01", "2026-09-30"),
    ];
    expect([jul, aug, sep]).toEqual([5 * CASH, 3 * CASH, 0]);
    const q3 = never("2026-07-01", "2026-09-30");
    expect(q3).toBe(jul + aug + sep);
    expect(never("2026-06-01", "2026-06-30") + q3 + never("2026-10-01", "2026-12-31")).toBe(1_111_700);
    expect(never("2026-01-01", TODAY)).toBe(1_111_700);
  });

  test("Q3: Wed Sep 30's $1,141.92 paid Oct 1 early — named, and never netted against July's weeks", () => {
    const q3 = next("2026-07-01", "2026-09-30");
    expect(q3.bankedInsideCents).toBe(5 * PAYROLL);
    expect(q3.neverBankedCents).toBe(8 * CASH);
    expect(q3.paidAcross).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true }]);
  });

  test("Aug 14 – Sep 23: Aug 27 by Sep 24 at the $1,141.92 it paid, and Aug 20's cash week never banked", () => {
    // 🔴 it read "$1,047.00 (Aug 27) was paid by the deposit of Thu, Sep 24, 2026": the net shortfall, as a deposit's
    const s = his("2026-08-14", "2026-09-23");
    expect(s.readCents).toBe(CASH + 4 * PAYROLL);
    expect(s.paidOutside).toEqual([{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: PAYROLL, early: false }]);
    expect(s.neverBankedCents).toBe(CASH);
    expect(s.bankedInsideCents).toBe(3 * PAYROLL);
    expect(s.paidAcross).toEqual([{ depositOn: "2026-09-23", paydays: ["2026-09-24"], cents: PAYROLL, early: true }]);
  });

  test("every window's figures add up — to its read paydays, and to the money banked inside it", () => {
    const windows: [string, string][] = [
      ["2026-06-01", "2026-06-30"],
      ["2026-06-05", "2026-06-05"],
      ["2026-08-01", "2026-09-23"],
      ["2026-08-14", "2026-09-23"],
      ["2026-09-01", "2026-09-30"],
      ["2026-09-23", "2026-09-23"],
      ["2026-09-24", "2026-09-30"],
      ["2026-10-01", "2026-10-31"],
      ["2026-01-01", TODAY],
    ];
    for (const [from, to] of windows) {
      for (const [s, deposits] of [
        [his(from, to), HIS_DEPOSITS],
        [next(from, to), NEXT],
      ] as const) {
        const outside = s.paidOutside.reduce((sum, p) => sum + p.cents, 0);
        const across = s.paidAcross.reduce((sum, p) => sum + p.cents, 0);
        expect(s.bankedInsideCents + outside + s.neverBankedCents, `${from} – ${to}`).toBe(s.readCents);
        expect(s.bankedInsideCents + across + s.noPaydayBeyondCents + s.otherBeyondCents, `${from} – ${to}`).toBe(
          bankedIn(deposits, from, to),
        );
      }
    }
  });

  test("money that paid no payday beyond what it can net: the outside deposit keeps its own figure", () => {
    // Wed Sep 30 pays Thu Oct 1 early, Wed Oct 7 pays Oct 8, and Fri Oct 9's $400.00 finds Oct 8 settled (§6A 55b)
    const deposits = [...NEXT, { postedOn: "2026-10-09", amountCents: 40_000 }];
    const s = shortfallOf(HIS_PAYDAYS, deposits, {
      from: "2026-10-01",
      to: "2026-10-31",
      today: TODAY,
      checkedThrough: "2026-10-12",
    });
    expect(s.towardNoPayday).toEqual([{ depositOn: "2026-10-09", cents: 40_000 }]);
    // 🔴 it read "$741.92 (Oct 1) was paid early" of a deposit that paid $1,141.92
    expect(s.paidOutside).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true }]);
    expect(s.neverBankedCents).toBe(0);
    expect(s.bankedInsideCents).toBe(PAYROLL);
    expect([s.noPaydayInsideCents, s.noPaydayBeyondCents, s.otherBeyondCents]).toEqual([0, 40_000, 0]);
  });

  test("money for a payday no window has counted yet stays netted, as Earned vs banked nets it", () => {
    // Wed Oct 14 pays Thu Oct 15, read on the Wednesday: no window counts Oct 15, so the window keeps that money
    const deposits = [...NEXT, { postedOn: "2026-10-14", amountCents: PAYROLL }];
    const s = shortfallOf(HIS_PAYDAYS, deposits, {
      from: "2026-01-01",
      to: "2026-10-14",
      today: "2026-10-14",
      checkedThrough: "2026-10-14",
    });
    expect(s.paidAhead).toEqual([{ depositOn: "2026-10-14", paydays: ["2026-10-15"], cents: PAYROLL }]);
    expect(s.paidAcross).toEqual([]);
    expect(s.neverBankedCents).toBe(1_111_700 - PAYROLL);
  });
});

/**
 * 🔴 Review of 3dc6527 (MEDIUM): money was taken out of a window's own for ANY passed payday outside it — but a passed
 * payday after the checked day is read by no window (`paidOutside` names only read ones) and by no Earned vs banked,
 * which nets that deposit. His ledger copy with Wed Sep 30's $1,141.92 imported past the statement (Wells Fargo still
 * checked through Thu Sep 24 — a Rocket Money CSV leaves exactly this): June + Q3 + Q4 read $11,117.00 never reached
 * a bank beside YTD's and the dashboard's $9,975.08. ⛔ Money crosses the window line only into a payday another window
 * READS — the mirror of that window's `paidOutside` — so every portion is counted by one window or by none.
 */
describe("payShortfall — the frontier between Wednesday's deposit and the Thursday it pays", () => {
  const IMPORTED = [...HIS_DEPOSITS, { postedOn: "2026-09-30", amountCents: PAYROLL }];
  const imported = (from: string, to: string) =>
    shortfallOf(HIS_PAYDAYS, IMPORTED, { from, to, today: TODAY, checkedThrough: CHECKED });
  /**
   * What a window says, signed: what no deposit made up, less its own money beyond its read paydays — the surplus a
   * window over it nets (decision 55). The shortfall clamps at zero; this is what adds up.
   */
  const net = (s: PayShortfall): number => s.neverBankedCents - s.noPaydayBeyondCents - s.otherBeyondCents;
  const sum = (cuts: readonly (readonly [string, string])[]): number =>
    cuts.reduce((total, [from, to]) => total + net(imported(from, to)), 0);
  // Earned vs banked on that copy: "$9,975.08 of it never reached a bank; the other $2,283.84 is for paydays after …"
  const DASHBOARD = 1_111_700 - PAYROLL;

  test("Oct 1 has passed but is not read: Q3 keeps Sep 30's money, nets it, and names no payday it paid", () => {
    const q3 = imported("2026-07-01", "2026-09-30");
    expect(q3.paidAcross).toEqual([]);
    // 🔴 it read $8,376.00 and "another $1,141.92 … paid Oct 1's payday early", which no window or dashboard counts
    expect(q3.neverBankedCents).toBe(8 * CASH - PAYROLL);
    expect(q3.bankedInsideCents).toBe(6 * PAYROLL);
    // September holds it as money beyond its read paydays — the surplus its note names paying Oct 1 early
    const september = imported("2026-09-01", "2026-09-30");
    expect(september.paidAhead).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL }]);
    expect(net(september)).toBe(-PAYROLL);
  });

  test("the windows the year is cut into add up to it, and the year is Earned vs banked's figure", () => {
    expect(net(imported("2026-01-01", TODAY))).toBe(DASHBOARD);
    expect(
      sum([
        ["2026-01-01", "2026-06-30"],
        ["2026-07-01", "2026-09-30"],
        ["2026-10-01", TODAY],
      ]),
    ).toBe(DASHBOARD);
    expect(
      sum([
        ["2026-01-01", "2026-06-30"],
        ["2026-07-01", "2026-07-31"],
        ["2026-08-01", "2026-08-31"],
        ["2026-09-01", "2026-09-30"],
        ["2026-10-01", TODAY],
      ]),
    ).toBe(DASHBOARD);
    // a cut between the Wednesday and its Thursday, and one on the checked day itself
    expect(
      sum([
        ["2026-01-01", "2026-09-24"],
        ["2026-09-25", "2026-09-30"],
        ["2026-10-01", TODAY],
      ]),
    ).toBe(DASHBOARD);
  });

  test("…and once a statement reads Oct 1, the same money crosses into October, which names it paid early", () => {
    const read = (from: string, to: string) =>
      shortfallOf(HIS_PAYDAYS, IMPORTED, { from, to, today: TODAY, checkedThrough: "2026-10-01" });
    expect(read("2026-07-01", "2026-09-30").paidAcross).toEqual([
      { depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true },
    ]);
    expect(read("2026-10-01", "2026-10-31").paidOutside).toEqual([
      { depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true },
    ]);
    const year = net(read("2026-01-01", TODAY));
    expect(net(read("2026-01-01", "2026-09-30")) + net(read("2026-10-01", TODAY))).toBe(year);
  });
});

/**
 * 🔴 Found in review 2026-10-13: `inWindow`'s last day could read `< 0` with every test green — no payday, deposit or
 * left-over money in any of them sat on a window's last day, and a month ends on a payday or a deposit day as often as
 * on any other. The window is inclusive at both ends (`PayShortfallWindow`), as /spending's `range.to` is.
 */
describe("payShortfall — the window's LAST day is inside it", () => {
  const cashWeeks = (from: string, to: string): PaydayOccurrence[] =>
    thursdays(from, to).map((date) => ({ date, amountCents: CASH }));
  const window = (from: string, to: string) => ({ from, to, today: TODAY, checkedThrough: CHECKED });

  test("a payday on the last day (Thu Apr 30) is read, and its own deposit that day banked it inside", () => {
    const s = shortfallOf(
      cashWeeks("2026-04-02", "2026-05-07"),
      [{ postedOn: "2026-04-30", amountCents: CASH }],
      window("2026-04-01", "2026-04-30"),
    );
    expect(s).toEqual({
      readPaydays: 5,
      firstReadOn: "2026-04-02",
      lastReadOn: "2026-04-30",
      readCents: 5 * CASH,
      bankedInsideCents: CASH,
      noPaydayInsideCents: 0,
      shortCents: 4 * CASH,
      paidOutside: [],
      neverBankedCents: 4 * CASH,
      paidAcross: [],
      noPaydayBeyondCents: 0,
      otherBeyondCents: 0,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
      paidUnread: [],
      paidUncounted: [],
      wentBackOut: [],
      bankedCents: CASH,
    });
  });

  test("a deposit on the last day (Fri Jul 31) banked Thursday's pay inside — never 'paid by the deposit of'", () => {
    const s = shortfallOf(
      cashWeeks("2026-07-02", "2026-08-06"),
      [{ postedOn: "2026-07-31", amountCents: CASH }],
      window("2026-07-01", "2026-07-31"),
    );
    // Fri Jul 31 anchors Thu Jul 30, one day inside its tolerance; Aug 6 is past its reach
    expect(s.lastReadOn).toBe("2026-07-30");
    expect(s.bankedInsideCents).toBe(CASH);
    expect(s.paidOutside).toEqual([]);
    expect(s.neverBankedCents).toBe(4 * CASH);
  });

  test("money on the last day that paid no payday is named toward no payday", () => {
    // June's shape a month later: Thu Jul 30 pays its own week, and Fri Jul 31's $400.00 finds that week settled
    const s = shortfallOf(
      cashWeeks("2026-07-02", "2026-08-06"),
      [
        { postedOn: "2026-07-30", amountCents: CASH },
        { postedOn: "2026-07-31", amountCents: 40_000 },
      ],
      window("2026-07-01", "2026-07-31"),
    );
    expect(s.bankedInsideCents).toBe(CASH + 40_000);
    expect(s.towardNoPayday).toEqual([{ depositOn: "2026-07-31", cents: 40_000 }]);
  });

  test("a payday paid ahead on the window's last day is the window's money, never a deposit from outside it", () => {
    // Wed Sep 30 pays Thu Oct 1: inside September, ahead of it — and with `to` exclusive it would vanish from both
    const s = shortfallOf(
      thursdays("2026-09-03", "2026-10-08").map((date) => ({ date, amountCents: PAYROLL })),
      ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30"].map((postedOn) => ({
        postedOn,
        amountCents: PAYROLL,
      })),
      window("2026-09-01", "2026-09-30"),
    );
    expect(s.paidAhead).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL }]);
  });
});

/**
 * What a window says, signed: what no deposit made up and the money that went back out, less its own money beyond its
 * read paydays — the surplus a window over it nets (decision 55). The windows a period is cut into add up to it.
 */
const signed = (s: PayShortfall): number =>
  s.neverBankedCents - s.noPaydayBeyondCents - s.otherBeyondCents + s.wentBackOut.reduce((sum, d) => sum + d.cents, 0);

/**
 * Every figure of a window adds up — to its read paydays, and to the money banked inside it, net: every row, money out
 * too. ⛔ The one rule's banked figure (`moneyOutOfWindow`, Earned vs banked's) is that too, with the days it names.
 */
function expectItAddsUp(s: PayShortfall, deposits: readonly AttributedDeposit[], from: string, to: string): void {
  const outside = s.paidOutside.reduce((sum, p) => sum + p.cents, 0);
  const across = s.paidAcross.reduce((sum, p) => sum + p.cents, 0);
  const out = s.wentBackOut.reduce((sum, d) => sum + d.cents, 0);
  const banked = deposits
    .filter((d) => d.postedOn >= from && d.postedOn <= to && d.postedOn <= TODAY)
    .reduce((sum, d) => sum + d.amountCents, 0);
  expect(s.bankedInsideCents + outside + s.neverBankedCents, `${from} – ${to}: the split`).toBe(s.readCents);
  expect(s.bankedInsideCents + across + s.noPaydayBeyondCents + s.otherBeyondCents - out, `${from} – ${to}`).toBe(
    banked,
  );
  expect(s.bankedCents - out, `${from} – ${to}: the card's banked figure`).toBe(banked);
}

/**
 * 🔴 Review of 36f212f on the integration (MEDIUM): a payroll returned on a LATER day. Settlement reads the return's
 * day as a day of its own that banked nothing — the deposit's day pays as it always has (decision 75) — while the
 * window's banked figure nets it. On his ledger copy (Wells Fargo checked through Thu Sep 24) with Wed Sep 30's
 * $1,141.92 and its return on Fri Oct 2, /spending October and Q4 read "paydays came to $0.00, and none of it reached
 * a bank" — no payday read at all — and with the return on Fri Sep 25, Sep 21 – 27 read Sep 24 "none of it reached a
 * bank" while the calendar draws it paid by Sep 23's deposit, inside that week. Re-measured on his copy 2026-10-21.
 */
describe("payShortfall — money that went back out on a day of its own", () => {
  const RETURNED_OCT_2 = [
    ...HIS_DEPOSITS,
    { postedOn: "2026-09-30", amountCents: PAYROLL },
    { postedOn: "2026-10-02", amountCents: -PAYROLL },
  ];
  const oct2 = (from: string, to: string) =>
    shortfallOf(HIS_PAYDAYS, RETURNED_OCT_2, { from, to, today: TODAY, checkedThrough: CHECKED });

  test("October reads no payday: nothing is short, and the $1,141.92 that went back out is named on its day", () => {
    const october = oct2("2026-10-01", "2026-10-31");
    expect(october.readPaydays).toBe(0);
    // 🔴 it was $1,141.92: the window's money, net of the return, below zero — "paydays came to $0.00"
    expect([october.shortCents, october.neverBankedCents, october.bankedInsideCents]).toEqual([0, 0, 0]);
    expect(october.wentBackOut).toEqual([{ postedOn: "2026-10-02", cents: PAYROLL }]);
    expect(signed(october)).toBe(PAYROLL);
  });

  test("the year nets the return against Sep 30's money for unread Oct 1 — the dashboard's figure", () => {
    const year = oct2("2026-01-01", TODAY);
    expect(year.wentBackOut).toEqual([]);
    expect(year.neverBankedCents).toBe(1_111_700);
    // ⛔ the card's banked figure, by the same rule: Sep 30's money is back out, so Jun 4 – Sep 24's $7,156.60
    // (🔴 $8,298.52 on the merge of d75-banked: a later day's money out took nothing off there, so it read $9,975.08)
    expect(year.bankedCents).toBe(CASH + 40_000 + 5 * PAYROLL);
    // June, Q3 — which nets Sep 30's money — and Q4, which names the money that went back out
    const cuts = [
      ["2026-01-01", "2026-06-30"],
      ["2026-07-01", "2026-09-30"],
      ["2026-10-01", TODAY],
    ] as const;
    expect(cuts.reduce((sum, [from, to]) => sum + signed(oct2(from, to)), 0)).toBe(1_111_700);
  });

  test("Sep 21 – 27, the return on Fri Sep 25: Sep 24 stays paid by Sep 23's deposit, and the return is named", () => {
    const deposits = [...HIS_DEPOSITS, { postedOn: "2026-09-25", amountCents: -PAYROLL }];
    const week = shortfallOf(HIS_PAYDAYS, deposits, {
      from: "2026-09-21",
      to: "2026-09-27",
      today: TODAY,
      checkedThrough: CHECKED,
    });
    // 🔴 it read "came to $1,141.92, and none of it reached a bank" beside Sep 23's lump naming only $3,425.76
    expect(week.bankedInsideCents).toBe(PAYROLL);
    expect(week.neverBankedCents).toBe(0);
    expect(week.paidAcross).toEqual([
      {
        depositOn: "2026-09-23",
        paydays: ["2026-09-03", "2026-09-10", "2026-09-17"],
        cents: 3 * PAYROLL,
        early: false,
      },
      { depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: PAYROLL, early: false },
    ]);
    expect(week.wentBackOut).toEqual([{ postedOn: "2026-09-25", cents: PAYROLL }]);
    // …and the year names it too: the only money there that paid none of its read paydays is Jun 5's $400.00
    const year = shortfallOf(HIS_PAYDAYS, deposits, {
      from: "2026-01-01",
      to: TODAY,
      today: TODAY,
      checkedThrough: CHECKED,
    });
    expect(year.wentBackOut).toEqual([{ postedOn: "2026-09-25", cents: PAYROLL }]);
    expect(year.neverBankedCents).toBe(1_111_700);
    expect(signed(year)).toBe(1_111_700 + PAYROLL);
    // ⚖️ the card banks the days that banked — Sep 24 stays paid — and names the day beside it (default (A), 2026-10-21)
    expect(year.bankedCents).toBe(CASH + 40_000 + 5 * PAYROLL);
    expect(wentBackOutPhrase(year.wentBackOut, formatDayLong)).toBe("$1,141.92 went back out on Fri, Sep 25, 2026");
  });

  test("a return that money paying no read payday covers is netted against it, a day at a time — never split", () => {
    // the $400.00 of Jun 5 paid no payday: a $400.00 return beside it nets it, a $500.00 one is named whole
    const at = (cents: number) =>
      shortfallOf(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-06-12", amountCents: -cents }], {
        from: "2026-06-01",
        to: "2026-06-30",
        today: TODAY,
        checkedThrough: CHECKED,
      });
    expect(at(40_000).wentBackOut).toEqual([]);
    expect(at(40_000).neverBankedCents).toBe(274_100 + 40_000);
    expect(at(50_000).wentBackOut).toEqual([{ postedOn: "2026-06-12", cents: 50_000 }]);
    expect(at(50_000).neverBankedCents).toBe(274_100);
  });

  test("every window's figures add up, with the money that went back out among the window's own", () => {
    const variants = [
      RETURNED_OCT_2,
      [...HIS_DEPOSITS, { postedOn: "2026-09-25", amountCents: -PAYROLL }],
      [
        ...HIS_DEPOSITS,
        { postedOn: "2026-09-30", amountCents: PAYROLL },
        { postedOn: "2026-09-25", amountCents: -PAYROLL },
      ],
    ];
    const windows: [string, string][] = [
      ["2026-06-01", "2026-06-30"],
      ["2026-09-01", "2026-09-30"],
      ["2026-09-21", "2026-09-27"],
      ["2026-09-25", "2026-10-01"],
      ["2026-10-01", "2026-10-31"],
      ["2026-10-02", "2026-10-13"],
      ["2026-07-01", "2026-09-30"],
      ["2026-01-01", TODAY],
    ];
    for (const deposits of variants) {
      for (const [from, to] of windows) {
        const s = shortfallOf(HIS_PAYDAYS, deposits, { from, to, today: TODAY, checkedThrough: CHECKED });
        expectItAddsUp(s, deposits, from, to);
        // ⛔ nothing that is not read is short
        if (s.readPaydays === 0) expect(s.shortCents, `${from} – ${to}`).toBe(0);
      }
    }
  });
});

describe("wentBackOutPhrase — the one spelling of money out on a day of its own", () => {
  test("every day once, oldest first, with the money of them all — two pay series out on one day name it once", () => {
    const days = [
      { postedOn: "2026-10-02", cents: PAYROLL },
      { postedOn: "2026-09-25", cents: 50_000 },
      { postedOn: "2026-10-02", cents: 100 },
    ];
    expect(wentBackOutPhrase(days, formatDayLong)).toBe(
      "$1,642.92 went back out on Fri, Sep 25, 2026 and Fri, Oct 2, 2026",
    );
  });
});

/**
 * 🔴 Review of 36f212f (MEDIUM): a payroll imported past the statement into a month with no read payday. On his ledger
 * copy (Wells Fargo checked through Thu Sep 24) with Wed Sep 30 and Wed Oct 7 imported, YTD, ALL and the dashboard said
 * $8,833.16 never reached a bank; June said $2,741.00 and Q3 $7,234.08 — and October and Q4 printed nothing, though the
 * year nets Oct 7's $1,141.92, which paid Thu Oct 8: a payday of October's own past the checked day, which no window
 * reads. Re-measured on his copy 2026-10-21: the same figures.
 */
describe("payShortfall — a window whose own unread payday holds money the year nets", () => {
  const IMPORTED = [
    ...HIS_DEPOSITS,
    ...["2026-09-30", "2026-10-07"].map((postedOn) => ({ postedOn, amountCents: PAYROLL })),
  ];
  const imported = (from: string, to: string) =>
    shortfallOf(HIS_PAYDAYS, IMPORTED, { from, to, today: TODAY, checkedThrough: CHECKED });
  // Earned vs banked on that copy: "$8,833.16 of it never reached a bank" — Sep 30 and Oct 7 net
  const DASHBOARD = 1_111_700 - 2 * PAYROLL;

  test("October names Oct 7's money paying its own Oct 8 — the money the year nets", () => {
    const october = imported("2026-10-01", "2026-10-31");
    expect(october.readPaydays).toBe(0);
    expect(october.paidUnread).toEqual([{ depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: PAYROLL }]);
    expect(october.otherBeyondCents).toBe(PAYROLL);
    expect(signed(october)).toBe(-PAYROLL);
  });

  test("June, Q3 and Q4 add up to the year, and the year is the dashboard's", () => {
    expect(signed(imported("2026-01-01", TODAY))).toBe(DASHBOARD);
    const cuts = [
      ["2026-01-01", "2026-06-30"],
      ["2026-07-01", "2026-09-30"],
      ["2026-10-01", TODAY],
    ] as const;
    expect(cuts.reduce((sum, [from, to]) => sum + signed(imported(from, to)), 0)).toBe(DASHBOARD);
    for (const [from, to] of cuts) expectItAddsUp(imported(from, to), IMPORTED, from, to);
  });

  test("…once a statement reads Oct 1, its payday paid early leaves Oct 7's money beside it, named", () => {
    const read = shortfallOf(HIS_PAYDAYS, IMPORTED, {
      from: "2026-10-01",
      to: "2026-10-31",
      today: TODAY,
      checkedThrough: "2026-10-01",
    });
    expect(read.readPaydays).toBe(1);
    expect(read.shortCents).toBe(0);
    expect(read.paidUnread).toEqual([{ depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: PAYROLL }]);
    expect(read.otherBeyondCents).toBe(PAYROLL);
    // …and once one reads Oct 8, the money that paid it banked a read payday: none of it is unread
    const both = shortfallOf(HIS_PAYDAYS, IMPORTED, {
      from: "2026-10-01",
      to: "2026-10-31",
      today: TODAY,
      checkedThrough: "2026-10-08",
    });
    expect([both.readPaydays, both.bankedInsideCents, both.paidUnread, both.otherBeyondCents]).toEqual([
      2,
      PAYROLL,
      [],
      0,
    ]);
  });
});

/**
 * 🔴 Review of f6da264 (MEDIUM): money a window's deposit put into a payday no window reads, other than one of the
 * window's own passed ones — the Thursday after a payroll Wednesday, not yet passed, or a passed payday before the
 * window that the ledger has not read — had no name of its own: the note called it money that "went toward no payday
 * on or before Thu, Sep 24, 2026", while the settlement, the calendar and the week's surplus note say it paid that
 * payday early. Measured on his ledger copy 2026-10-21 with Wed Sep 30 and Wed Oct 7 imported past the Sep 24
 * statement, on Wed Oct 7: /spending October and Q4.
 */
describe("payShortfall — money for a payday no window counts, named with the payday it paid", () => {
  const IMPORTED = [
    ...HIS_DEPOSITS,
    ...["2026-09-30", "2026-10-07"].map((postedOn) => ({ postedOn, amountCents: PAYROLL })),
  ];

  test("on Wed Oct 7, Oct 7's money paid Thu Oct 8, not yet passed: paid early — never one of October's own", () => {
    const october = shortfallOf(HIS_PAYDAYS, IMPORTED, {
      from: "2026-10-01",
      to: "2026-10-31",
      today: "2026-10-07",
      checkedThrough: CHECKED,
    });
    expect(october.readPaydays).toBe(0);
    expect(october.paidUnread).toEqual([]);
    expect(october.paidUncounted).toEqual([
      { depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: PAYROLL, early: true },
    ]);
    expect(october.otherBeyondCents).toBe(PAYROLL);
  });

  test("a lump that walked back before the window, to a payday the ledger has not read: paid, not early", () => {
    // no Sep 30: Wed Oct 7's two weeks pay its own Oct 8 and walk back to Oct 1 — before Oct 5 – 18, past Sep 24
    const deposits = [...HIS_DEPOSITS, { postedOn: "2026-10-07", amountCents: 2 * PAYROLL }];
    const window = shortfallOf(HIS_PAYDAYS, deposits, {
      from: "2026-10-05",
      to: "2026-10-18",
      today: "2026-10-20",
      checkedThrough: CHECKED,
    });
    expect(window.paidUnread).toEqual([{ depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: PAYROLL }]);
    expect(window.paidUncounted).toEqual([
      { depositOn: "2026-10-07", paydays: ["2026-10-01"], cents: PAYROLL, early: false },
    ]);
  });

  test("money for a READ payday outside the window is the other window's — named across it, never uncounted", () => {
    // checked through Sat Oct 10: Oct 8 is read, so Oct 7's money crosses into the window that reads it
    const window = shortfallOf(HIS_PAYDAYS, IMPORTED, {
      from: "2026-10-01",
      to: "2026-10-07",
      today: TODAY,
      checkedThrough: "2026-10-10",
    });
    expect(window.paidAcross).toEqual([
      { depositOn: "2026-10-07", paydays: ["2026-10-08"], cents: PAYROLL, early: true },
    ]);
    expect(window.paidUncounted).toEqual([]);
  });
});
