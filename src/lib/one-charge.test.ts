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

  test("a weekly schedule steps back a week, not a month", () => {
    const weekly: OneChargeSchedule = { ...NOV_11_BALANCE, cadence: "weekly", intervalDaysAvg: 7 };
    expect(isOneCharge(weekly, "2026-11-05")).toBe(true);
    expect(isOneCharge(weekly, "2026-11-04")).toBe(false);
  });
});

describe("oneChargePhrase — the words a cadence slot prints for it", () => {
  test("once · the day, the year riding along only when it is not this year's", () => {
    expect(oneChargePhrase("2026-11-11", "2026-10-08")).toBe("once · Nov 11");
    expect(oneChargePhrase("2027-01-11", "2026-10-08")).toBe("once · Jan 11, 2027");
  });
});
