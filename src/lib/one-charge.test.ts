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
   * read "once" in its last month. A linked charge belongs to the occurrence it lands NEARER; a tie goes to the
   * earlier one, so a monthly bill in its final month never flips to once.
   */
  test("the cycle before's charge, posted late, still belongs to the cycle before", () => {
    for (const late of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-26"]) {
      expect(isOneCharge(NOV_11_BALANCE, late), late).toBe(false);
    }
    // 16 days after Oct 11, 15 before Nov 11: nearer the one charge, so it IS the one charge, posted early
    expect(isOneCharge(NOV_11_BALANCE, "2026-10-27")).toBe(true);
  });

  test("a tie halfway goes to the earlier occurrence", () => {
    // Sep 11 → Oct 11 is 30 days: Sep 26 is 15 from each
    const oct11: OneChargeSchedule = { ...NOV_11_BALANCE, nextExpectedOn: "2026-10-11", userEndsOn: "2026-10-11" };
    expect(isOneCharge(oct11, "2026-09-26")).toBe(false);
    expect(isOneCharge(oct11, "2026-09-27")).toBe(true);
  });

  test("his Car insurance as a two-payment policy (Aug + Sep 11) is not one charge in September", () => {
    const twoPayments: OneChargeSchedule = { ...NOV_11_BALANCE, nextExpectedOn: "2026-09-11", userEndsOn: "2026-09-11" };
    expect(isOneCharge(twoPayments, "2026-08-12")).toBe(false);
  });

  test("a weekly schedule steps back a week, not a month — and halves a week", () => {
    const weekly: OneChargeSchedule = { ...NOV_11_BALANCE, cadence: "weekly", intervalDaysAvg: 7 };
    // a day after Nov 4's nominal day is Nov 4's charge, posted a day late
    expect(isOneCharge(weekly, "2026-11-05")).toBe(false);
    expect(isOneCharge(weekly, "2026-11-07")).toBe(false);
    expect(isOneCharge(weekly, "2026-11-08")).toBe(true);
  });
});

/*
 * 🔴 THE PREDICATE READ "next day = end day", NOT "the schedule holds one charge" (review of 8a4ac47). The one
 * charge's date token writes the next day, and the walk (`projectOccurrences`) still finds exactly one occurrence
 * when that day moves earlier inside the end — moved to Nov 8 it charges once, on Nov 8, and must read so.
 */
describe("isOneCharge — one occurrence between the next day and the end, whatever the gap", () => {
  const weekly: OneChargeSchedule = { ...NOV_11_BALANCE, cadence: "weekly", intervalDaysAvg: 7 };

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
