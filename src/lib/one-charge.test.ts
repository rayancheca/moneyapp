import { describe, expect, test } from "vitest";
import { isOneCharge, oneChargePhrase, type OneChargeSchedule } from "./one-charge";

/**
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the Nov 11 car-insurance balance — monthly by its stored cadence, next and
 * last day both 2026-11-11, never billed — is ONE CHARGE, and reads "once · Nov 11". Car insurance itself (two charges
 * left, ends 2027-01-11) is a monthly bill in its last months and must never read "once", whatever its anchor says.
 */
const NOV_11_BALANCE: OneChargeSchedule = {
  cadence: "monthly",
  intervalDaysAvg: 30,
  anchorDay: null,
  nextExpectedOn: "2026-11-11",
  userEndsOn: "2026-11-11",
  // the series' own settle tolerance — what detection writes for a monthly cadence, and his ledger stores for it
  toleranceDays: 3,
};

describe("isOneCharge — a schedule that holds exactly one occurrence", () => {
  test("the Nov 11 balance, never billed, is one charge", () => {
    expect(isOneCharge(NOV_11_BALANCE, null)).toBe(true);
  });

  test("Car insurance as it stands (next Dec 11, ends Jan 11) is not", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2026-12-11", userEndsOn: "2027-01-11" }, "2026-08-12")).toBe(
      false,
    );
  });

  test("an open-ended series is never one charge", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, userEndsOn: null }, null)).toBe(false);
  });

  test("a series with no expected day is never one charge", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: null }, null)).toBe(false);
  });

  /*
   * 🔴 THE FINAL-MONTH TRAP. The stored anchor MOVES: on the owner's ledger 2026-10-08 Car insurance's own
   * `user_next_expected_on` already reads 2026-12-11 — re-anchored past the months the $1,000 paid early — one step
   * short of its 2027-01-11 end. Re-anchor it once more and "next day equals end day" is true of a six-payment policy.
   * What it has that the balance does not is a charge BEFORE that day's cycle: its schedule began in August.
   */
  test("a monthly bill re-anchored onto its last day, with charges before it, is still monthly", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2027-01-11", userEndsOn: "2027-01-11" }, "2026-08-12")).toBe(
      false,
    );
  });

  test("a charge exactly one step before the day belongs to the step before — not one charge", () => {
    expect(isOneCharge(NOV_11_BALANCE, "2026-10-11")).toBe(false);
  });

  /*
   * ⚖️ Decided 2026-10-08: once the balance POSTS it is still a schedule that held one charge — it reads "once" on
   * every surface that still names it, and is over (the forecast stops at its end day, the card counts it ended).
   * Posted a few days early is still that one charge, not a second one.
   */
  test("the one charge posted on its day, or a few days early, keeps it one charge", () => {
    expect(isOneCharge(NOV_11_BALANCE, "2026-11-11")).toBe(true);
    expect(isOneCharge(NOV_11_BALANCE, "2026-11-06")).toBe(true);
  });

  /*
   * 🔴 THE CUT-OFF WAS THE NOMINAL DAY (review of 8a4ac47). `posted_on` is the SETTLE date, so the charge for the
   * cycle before usually lands after that cycle's nominal day — his own Car insurance is due on the 11th and its first
   * linked charge posted 2026-08-12. A charge on Oct 12 read as the Nov 11 charge, so a two-payment bill (Oct + Nov)
   * read "once" in its last month. A linked charge within the series' own settle tolerance after the step before is
   * that cycle's charge, posted late.
   */
  test("the cycle before's charge, posted late inside the settle tolerance, still belongs to the cycle before", () => {
    for (const late of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      expect(isOneCharge(NOV_11_BALANCE, late), late).toBe(false);
    }
    // a day past Oct 11 + 3: no settle lag reaches it, so it is the one charge, paid early
    expect(isOneCharge(NOV_11_BALANCE, "2026-10-15")).toBe(true);
  });

  /*
   * 🔴 THE CUT-OFF THEN MOVED TO HALFWAY (review of 3044ea6): a charge nearer the step before than the day counted as
   * the cycle before's, so his balance paid Oct 12–26 read monthly again — on a copy of his ledger a -$72.74 row
   * posted 2026-10-20 and attached to it put $72.74 a month back in the card's headline ($3,738.18 → $3,810.92) and
   * emptied its one-offs. He has paid this insurer early before: the $1,000 on Sep 3 is what made this balance. Settle
   * lag is days, not half a month.
   */
  test("the Nov 11 balance paid three weeks early is still one charge", () => {
    for (const early of ["2026-10-20", "2026-10-26", "2026-10-27"]) {
      expect(isOneCharge(NOV_11_BALANCE, early), early).toBe(true);
    }
  });

  test("the window is the series' own tolerance — a wider one keeps a later charge in the cycle before", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, toleranceDays: 7 }, "2026-10-18")).toBe(false);
    expect(isOneCharge({ ...NOV_11_BALANCE, toleranceDays: 7 }, "2026-10-19")).toBe(true);
  });

  test("his Car insurance as a two-payment policy (Aug + Sep 11) is not one charge in September", () => {
    const twoPayments: OneChargeSchedule = { ...NOV_11_BALANCE, nextExpectedOn: "2026-09-11", userEndsOn: "2026-09-11" };
    expect(isOneCharge(twoPayments, "2026-08-12")).toBe(false);
  });

  test("a weekly schedule steps back a week, not a month", () => {
    // detection's weekly tolerance is 2 days
    const weekly: OneChargeSchedule = { ...NOV_11_BALANCE, cadence: "weekly", intervalDaysAvg: 7, toleranceDays: 2 };
    // a day after Nov 4's nominal day is Nov 4's charge, posted a day late
    expect(isOneCharge(weekly, "2026-11-05")).toBe(false);
    expect(isOneCharge(weekly, "2026-11-06")).toBe(false);
    expect(isOneCharge(weekly, "2026-11-07")).toBe(true);
  });
});

/*
 * 🔴 THE PREDICATE READ "next day = end day", NOT "the schedule holds one charge" (review of 8a4ac47). The one
 * charge's date token writes the next day, and the walk (`projectOccurrences`) still finds exactly one occurrence
 * when that day moves earlier inside the end — moved to Nov 8 it charges once, on Nov 8, and must read so.
 */
describe("isOneCharge — one occurrence between the next day and the end, whatever the gap", () => {
  const weekly: OneChargeSchedule = { ...NOV_11_BALANCE, cadence: "weekly", intervalDaysAvg: 7, toleranceDays: 2 };

  test("the one charge moved earlier inside its end is still one charge", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2026-11-08" }, null)).toBe(true);
    expect(isOneCharge({ ...weekly, nextExpectedOn: "2026-11-05" }, null)).toBe(true);
  });

  test("two occurrences before the end are not one charge", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2026-10-11" }, null)).toBe(false);
    expect(isOneCharge({ ...weekly, nextExpectedOn: "2026-11-04" }, null)).toBe(false);
  });

  test("a next day past the end holds no occurrence at all — not one charge", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2026-11-14" }, null)).toBe(false);
  });

  test("the earlier-charge test measures from the day the one charge falls on, not the end", () => {
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2026-11-08" }, "2026-10-09")).toBe(false);
    expect(isOneCharge({ ...NOV_11_BALANCE, nextExpectedOn: "2026-11-08" }, "2026-11-08")).toBe(true);
  });
});

describe("oneChargePhrase — the words a cadence slot prints for it", () => {
  test("once · the day, the year riding along only when it is not this year's", () => {
    expect(oneChargePhrase("2026-11-11", "2026-10-08")).toBe("once · Nov 11");
    expect(oneChargePhrase("2027-01-11", "2026-10-08")).toBe("once · Jan 11, 2027");
  });
});
