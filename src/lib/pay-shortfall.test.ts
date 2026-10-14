import { describe, expect, test } from "vitest";
import { payShortfall, type SettlementWalked } from "./pay-shortfall";
import { settlePaydaysBackwards, type AttributedDeposit, type PaydayOccurrence } from "./payday-settlement";

/**
 * A /spending window's paydays read against the settlement — the figures the shortfall note prints.
 *
 * ⛔ Every settlement here is `settlePaydaysBackwards`' own, never hand-built portions: the note must say what the
 * calendar and /budgets say of the same paydays, and the only way to hold it to that is to feed it the one rule.
 *
 * His ledger's own shape (a copy, 2026-10-13): cash weeks at $1,047.00 from Thu Jun 4, payroll at $1,141.92 from Aug 27
 * (§6A 55a: money pays only its own era's paydays), Wells Fargo checked through Thu Sep 24, deposits Jun 4 $1,047.00,
 * Jun 5 $400.00, Sep 23 $4,567.68 and Sep 24 $1,141.92.
 */

const CASH = 104_700;
const PAYROLL = 114_192;
const TODAY = "2026-10-13";
const CHECKED = "2026-09-24";

const thursdays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const HIS_PAYDAYS: PaydayOccurrence[] = thursdays("2026-06-04", "2026-10-15").map((date) => ({
  date,
  amountCents: date < "2026-08-27" ? CASH : PAYROLL,
}));
const HIS_DEPOSITS: AttributedDeposit[] = [
  { postedOn: "2026-06-04", amountCents: CASH },
  { postedOn: "2026-06-05", amountCents: 40_000 },
  { postedOn: "2026-09-23", amountCents: 4 * PAYROLL },
  { postedOn: "2026-09-24", amountCents: PAYROLL },
];

function walked(paydays: PaydayOccurrence[], deposits: AttributedDeposit[], today = TODAY): SettlementWalked {
  // what the service hands it: the paydays it drew and the money that had ARRIVED, settled by the one rule
  const arrived = deposits.filter((d) => d.postedOn <= today);
  const s = settlePaydaysBackwards({
    occurrences: paydays,
    deposits: arrived,
    toleranceDays: 3,
    periodOf: (day) => (day < "2026-08-27" ? 0 : 1),
  });
  return { settledBy: s.settledBy, portions: s.portions, paydays, deposits: arrived };
}

const his = (from: string, to: string, checkedThrough: string | null = CHECKED, today = TODAY) =>
  payShortfall(walked(HIS_PAYDAYS, HIS_DEPOSITS, today), { from, to, today, checkedThrough });

describe("payShortfall — a window's read paydays against the settlement", () => {
  test("August: one payday paid by a later deposit, three that no deposit paid", () => {
    expect(his("2026-08-01", "2026-08-31")).toEqual({
      readPaydays: 4,
      firstReadOn: "2026-08-06",
      lastReadOn: "2026-08-27",
      readCents: 3 * CASH + PAYROLL,
      bankedInsideCents: 0,
      paidOutside: [{ depositOn: "2026-09-24", paydays: ["2026-08-27"], cents: PAYROLL, early: false }],
      neverBankedCents: 3 * CASH,
      unlookedPaydays: 0,
      towardNoPayday: [],
    });
  });

  test("June: its own deposit paid Jun 4, the $400.00 beside it paid no payday, three paid nothing", () => {
    const s = his("2026-06-01", "2026-06-30");
    expect(s.readCents).toBe(4 * CASH);
    expect(s.bankedInsideCents).toBe(CASH);
    expect(s.paidOutside).toEqual([]);
    expect(s.neverBankedCents).toBe(3 * CASH);
    // the calendar's "toward no payday" (§6A 55b) — what makes $1,047.00 + $400.00 the page's $1,447.00 of Salary
    expect(s.towardNoPayday).toEqual([{ depositOn: "2026-06-05", cents: 40_000 }]);
  });

  test("September: every payday banked inside the window — nothing short", () => {
    const s = his("2026-09-01", "2026-09-30");
    expect(s.readPaydays).toBe(4);
    expect(s.bankedInsideCents).toBe(s.readCents);
    expect(s.neverBankedCents).toBe(0);
    expect(s.paidOutside).toEqual([]);
    // the Sep 24 deposit paid Aug 27: money of THIS window spent elsewhere is the surplus note's, not this
    expect(s.towardNoPayday).toEqual([]);
  });

  test("a window straddling the checked day: the paydays after it are not looked for, never short", () => {
    const s = his("2026-09-01", "2026-10-31");
    expect(s.readPaydays).toBe(4);
    expect(s.lastReadOn).toBe("2026-09-24");
    expect(s.readCents).toBe(4 * PAYROLL);
    // Oct 1 and Oct 8 have passed and no checked statement reaches them; Oct 15 has not happened
    expect(s.unlookedPaydays).toBe(2);
    expect(s.neverBankedCents).toBe(0);
  });

  test("…and a payday after the checked day that an imported deposit settled is not waiting on anything", () => {
    const s = payShortfall(
      walked(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-09-30", amountCents: PAYROLL }]),
      { from: "2026-08-01", to: "2026-10-31", today: TODAY, checkedThrough: CHECKED },
    );
    // Wed Sep 30 pays Thu Oct 1 (inside its tolerance); Oct 8 is the one still quiet
    expect(s.unlookedPaydays).toBe(1);
  });

  test("a payday paid by a deposit BEFORE the window was paid early (§6A 29)", () => {
    const s = payShortfall(walked(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-09-30", amountCents: PAYROLL }]), {
      from: "2026-10-01",
      to: "2026-10-31",
      today: TODAY,
      checkedThrough: "2026-10-12",
    });
    expect(s.readPaydays).toBe(2);
    expect(s.paidOutside).toEqual([{ depositOn: "2026-09-30", paydays: ["2026-10-01"], cents: PAYROLL, early: true }]);
    expect(s.neverBankedCents).toBe(PAYROLL);
    expect(s.bankedInsideCents).toBe(0);
  });

  test("a payday dated today has not passed until its deposit lands — cashEarnings' own rule", () => {
    const quiet = his("2026-10-01", "2026-10-31", "2026-10-08", "2026-10-08");
    expect(quiet.readPaydays).toBe(1);
    expect(quiet.lastReadOn).toBe("2026-10-01");
    const paid = payShortfall(
      walked(HIS_PAYDAYS, [...HIS_DEPOSITS, { postedOn: "2026-10-08", amountCents: PAYROLL }], "2026-10-08"),
      { from: "2026-10-01", to: "2026-10-31", today: "2026-10-08", checkedThrough: "2026-10-08" },
    );
    expect(paid.readPaydays).toBe(2);
    expect(paid.bankedInsideCents).toBe(PAYROLL);
  });

  test("an account with no checked record reads no payday — every quiet one is not looked for", () => {
    const s = his("2026-08-01", "2026-08-31", null);
    expect(s.readPaydays).toBe(0);
    expect(s.readCents).toBe(0);
    expect(s.firstReadOn).toBeNull();
    // Aug 27 is settled (by Sep 24), so three of August's four are waiting
    expect(s.unlookedPaydays).toBe(3);
  });

  test("a payday paid SHORT is short by what its deposit lacked", () => {
    const s = payShortfall(
      walked(thursdays("2026-09-03", "2026-09-10").map((date) => ({ date, amountCents: PAYROLL })), [
        { postedOn: "2026-09-03", amountCents: PAYROLL },
        { postedOn: "2026-09-10", amountCents: 110_000 },
      ]),
      { from: "2026-09-01", to: "2026-09-30", today: TODAY, checkedThrough: CHECKED },
    );
    // the anchor clause answers Sep 10 with the money there was
    expect(s.bankedInsideCents).toBe(PAYROLL + 110_000);
    expect(s.neverBankedCents).toBe(PAYROLL - 110_000);
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
    const s = payShortfall(
      walked(cashWeeks("2026-04-02", "2026-05-07"), [{ postedOn: "2026-04-30", amountCents: CASH }]),
      window("2026-04-01", "2026-04-30"),
    );
    expect(s).toEqual({
      readPaydays: 5,
      firstReadOn: "2026-04-02",
      lastReadOn: "2026-04-30",
      readCents: 5 * CASH,
      bankedInsideCents: CASH,
      paidOutside: [],
      neverBankedCents: 4 * CASH,
      unlookedPaydays: 0,
      towardNoPayday: [],
    });
  });

  test("a deposit on the last day (Fri Jul 31) banked Thursday's pay inside — never 'paid by the deposit of'", () => {
    const s = payShortfall(
      walked(cashWeeks("2026-07-02", "2026-08-06"), [{ postedOn: "2026-07-31", amountCents: CASH }]),
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
    const s = payShortfall(
      walked(cashWeeks("2026-07-02", "2026-08-06"), [
        { postedOn: "2026-07-30", amountCents: CASH },
        { postedOn: "2026-07-31", amountCents: 40_000 },
      ]),
      window("2026-07-01", "2026-07-31"),
    );
    expect(s.bankedInsideCents).toBe(CASH);
    expect(s.towardNoPayday).toEqual([{ depositOn: "2026-07-31", cents: 40_000 }]);
  });
});
