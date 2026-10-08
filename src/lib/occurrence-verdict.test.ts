import { describe, expect, test } from "vitest";
import {
  absenceIsEvidence,
  dueDayIsRead,
  forecastConfidence,
  lastDueDayRead,
  settledVerdict,
  type ConfidenceInput,
  type DueDayReading,
} from "./occurrence-verdict";

describe("absenceIsEvidence", () => {
  test("money out can be disproven by a covered day", () => {
    expect(absenceIsEvidence("bill")).toBe(true);
    expect(absenceIsEvidence("subscription")).toBe(true);
    expect(absenceIsEvidence("transfer")).toBe(true);
    expect(absenceIsEvidence("other")).toBe(true);
  });

  test("money in cannot", () => {
    expect(absenceIsEvidence("income")).toBe(false);
  });
});

/** The accounts a series bills on imported through `observedThrough`, with `graceDays` for a payment to post. */
const read = (observedThrough: string | null, graceDays = 3): DueDayReading => ({ observedThrough, graceDays });

/*
 * ⚖️ His decision 60 (2026-10-08): a bill reads "not posted" — and the calendar's red ✕ — only once statements cover
 * the due day PLUS the bill's tolerance, the days a payment may still post on; until then "no import has covered it
 * yet", quiet. 🔴 Read on the due day itself, the e2e fixture's Meal Kit (due Jul 5, its card imported through Jul 5)
 * was drawn ✕ "missed" while a payment on Jul 6, 7 or 8 would still have paid it — days no import had reached.
 */
describe("dueDayIsRead — the one predicate (§6A 60)", () => {
  test("THE BOUNDARY: imported through the due day + its grace − 1 is not read; through due + grace is", () => {
    expect(dueDayIsRead("2026-10-01", read("2026-10-03"))).toBe(false);
    expect(dueDayIsRead("2026-10-01", read("2026-10-04"))).toBe(true);
  });

  test("imported through the due day itself is not read while a payment may still post", () => {
    expect(dueDayIsRead("2026-07-05", read("2026-07-05"))).toBe(false);
  });

  test("the grace is the series' own: none reads the due day itself, a week waits a week", () => {
    expect(dueDayIsRead("2026-10-01", read("2026-10-01", 0))).toBe(true);
    expect(dueDayIsRead("2026-10-01", read("2026-10-07", 7))).toBe(false);
    expect(dueDayIsRead("2026-10-01", read("2026-10-08", 7))).toBe(true);
  });

  test("nothing imported reads nothing", () => {
    expect(dueDayIsRead("2026-10-01", read(null))).toBe(false);
    expect(lastDueDayRead(read(null))).toBeNull();
  });

  test("lastDueDayRead is the last due day the imports vouch for — the frontier less the grace, across a month", () => {
    expect(lastDueDayRead(read("2026-10-04"))).toBe("2026-10-01");
    expect(lastDueDayRead(read("2026-10-02"))).toBe("2026-09-29");
    expect(lastDueDayRead(read("2026-10-02", 0))).toBe("2026-10-02");
  });
});

describe("settledVerdict", () => {
  test("a bill absent from a day the ledger HAS been shown, and its grace after it, is missed", () => {
    // The pass-45 case, which must keep working: $2,285.70 of overdue rent hid
    // behind a green budget. A covered, empty day is a real answer.
    expect(settledVerdict("bill", "2026-08-10", read("2026-08-14"), true)).toEqual({
      state: "missed",
      reason: null,
    });
  });

  /*
   * ⚖️ §6A 60 (2026-10-08). Inclusive on purpose, as before: `observedThrough` names a day that IS imported, so a bill
   * whose grace ends exactly on the newest statement's closing day is graded. 🔴 It used to grade the due day itself
   * ("a bill on the frontier day itself is still covered"): a red ✕ over days a payment could still post on.
   */
  test("THE BOUNDARY: not imported through due + grace − 1, missed through due + grace", () => {
    expect(settledVerdict("bill", "2026-10-01", read("2026-10-03"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
    expect(settledVerdict("bill", "2026-10-01", read("2026-10-04"), true)).toEqual({
      state: "missed",
      reason: null,
    });
  });

  test("a bill on the frontier day itself is not yet known — its grace has not been imported", () => {
    expect(settledVerdict("bill", "2026-08-14", read("2026-08-14"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("a bill past the frontier is unsettled, not missed", () => {
    expect(settledVerdict("subscription", "2026-08-15", read("2026-08-12"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("no frontier at all is the most cautious answer", () => {
    expect(settledVerdict("bill", "2026-08-10", read(null), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("income is never missed, however well covered the day is", () => {
    // The measured defect: three cash paydays drawn red in August 2026. Even a
    // day imported to the minute cannot disprove cash he was handed and has not
    // deposited.
    expect(settledVerdict("income", "2026-08-06", read("2026-12-31"), true)).toEqual({
      state: "unsettled",
      reason: "unbanked",
    });
  });

  test("income with no coverage reports unbanked, not not_imported", () => {
    // Both branches would say "unsettled"; the REASON is the whole point, and
    // "we have not imported this" would be the wrong sentence under a payday.
    expect(settledVerdict("income", "2026-08-20", read(null), true).reason).toBe("unbanked");
  });

  test("a series with too few postings cannot support a missed claim", () => {
    // FPL: ONE posting, from which the app extrapolated a due date that was
    // wrong by thirteen days — and then reported the biller as delinquent on it.
    expect(settledVerdict("bill", "2026-08-10", read("2026-08-14"), false)).toEqual({
      state: "unsettled",
      reason: "schedule_unproven",
    });
  });

  test("an unimported day outranks an unproven schedule", () => {
    // Both are true; "we have not been shown this day" is the stronger and more
    // actionable answer, so it is the one reported.
    expect(settledVerdict("bill", "2026-08-20", read("2026-08-12"), false).reason).toBe("not_imported");
    // …and a day imported without its grace is not shown either
    expect(settledVerdict("bill", "2026-08-10", read("2026-08-12"), false).reason).toBe("not_imported");
  });

  test("a proven schedule on a covered day is still missed", () => {
    expect(settledVerdict("bill", "2026-08-10", read("2026-08-13"), true)).toEqual({
      state: "missed",
      reason: null,
    });
  });

  test("a reason is present exactly when the state is unsettled", () => {
    const cases = [
      settledVerdict("bill", "2026-01-01", read("2026-06-01"), true),
      settledVerdict("bill", "2026-08-01", read("2026-06-01"), true),
      settledVerdict("bill", "2026-05-31", read("2026-06-01"), true),
      settledVerdict("income", "2026-08-01", read("2026-06-01"), true),
      settledVerdict("bill", "2026-08-01", read(null), true),
    ];
    for (const v of cases) {
      expect(v.reason === null).toBe(v.state === "missed");
    }
  });
});

describe("forecastConfidence", () => {
  const base: ConfidenceInput = {
    status: "confirmed",
    userAmountCents: null,
    userNextExpectedOn: null,
    userEndsOn: null,
  };

  test("detected is predicted — nobody has agreed to it", () => {
    expect(forecastConfidence({ ...base, status: "detected" })).toBe("predicted");
  });

  test("a detected series the owner happened to edit is still predicted", () => {
    // Confirming is the act that raises confidence, not typing a number into a
    // guess. Otherwise an amount override on a bad detection would promote it.
    expect(forecastConfidence({ ...base, status: "detected", userAmountCents: -999 })).toBe(
      "predicted",
    );
  });

  test("confirmed with figures from history is expected", () => {
    expect(forecastConfidence(base)).toBe("expected");
  });

  test.each([
    ["userAmountCents", { userAmountCents: -55989 }],
    ["userNextExpectedOn", { userNextExpectedOn: "2026-09-11" }],
    ["userEndsOn", { userEndsOn: "2028-08-11" }],
  ])("confirmed plus a typed %s is scheduled", (_label, override) => {
    expect(forecastConfidence({ ...base, ...override })).toBe("scheduled");
  });

  test("dismissed and ended never reach the forecast, and read as predicted", () => {
    // Neither is projected by `recurringCalendar`, so this is a total-function
    // guard rather than a live path: it must not throw or return undefined.
    expect(forecastConfidence({ ...base, status: "dismissed" })).toBe("predicted");
    expect(forecastConfidence({ ...base, status: "ended" })).toBe("predicted");
  });
});
