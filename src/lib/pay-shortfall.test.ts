import { describe, expect, test } from "vitest";
import { cashEarnings, type PaySeries } from "./cash-earnings";
import { payShortfall, type PayShortfallWindow, type WindowEarnings } from "./pay-shortfall";
import { settlePaydaysBackwards, type AttributedDeposit, type PaydayOccurrence } from "./payday-settlement";

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
  return payShortfall({ settledBy: s.settledBy, portions: s.portions, paydays, deposits: arrived }, w, e);
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
      shortCents: 3 * CASH + PAYROLL,
      paidOutside: [{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: PAYROLL, early: false }],
      neverBankedCents: 3 * CASH,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
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
    // the calendar's "toward no payday" (§6A 55b), named inside the banked figure
    expect(s.towardNoPayday).toEqual([{ depositOn: "2026-06-05", cents: 40_000 }]);
  });

  test("September: it banked more than its paydays came to — nothing short, and nothing it paid ahead", () => {
    const s = his("2026-09-01", "2026-09-30");
    expect(s.readPaydays).toBe(4);
    expect(s.bankedInsideCents).toBe(5 * PAYROLL);
    expect(s.shortCents).toBe(0);
    expect(s.neverBankedCents).toBe(0);
    expect(s.paidOutside).toEqual([]);
    // the Sep 24 deposit paid Aug 27 — EARLIER pay, the surplus note's backlog — and no later payday
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
      shortCents: 4 * CASH,
      paidOutside: [],
      neverBankedCents: 4 * CASH,
      unlookedPaydays: 0,
      towardNoPayday: [],
      paidAhead: [],
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
