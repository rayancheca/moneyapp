import { describe, expect, test } from "vitest";
import {
  absenceIsEvidence,
  forecastConfidence,
  settledVerdict,
  type ConfidenceInput,
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

describe("settledVerdict", () => {
  test("a bill absent from a day the ledger HAS been shown is missed", () => {
    // The pass-45 case, which must keep working: $2,285.70 of overdue rent hid
    // behind a green budget. A covered, empty day is a real answer.
    expect(settledVerdict("bill", "2026-08-10", "2026-08-14")).toEqual({
      state: "missed",
      reason: null,
    });
  });

  test("a bill on the frontier day itself is still covered", () => {
    // Inclusive on purpose: `observedThrough` names a day that IS imported, not
    // the first day that is not. An exclusive read would misreport every bill
    // that lands exactly on the newest statement's closing day.
    expect(settledVerdict("bill", "2026-08-14", "2026-08-14").state).toBe("missed");
  });

  test("a bill past the frontier is unsettled, not missed", () => {
    expect(settledVerdict("subscription", "2026-08-15", "2026-08-12")).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("no frontier at all is the most cautious answer", () => {
    expect(settledVerdict("bill", "2026-08-10", null)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("income is never missed, however well covered the day is", () => {
    // The measured defect: three cash paydays drawn red in August 2026. Even a
    // day imported to the minute cannot disprove cash he was handed and has not
    // deposited.
    expect(settledVerdict("income", "2026-08-06", "2026-12-31")).toEqual({
      state: "unsettled",
      reason: "unbanked",
    });
  });

  test("income with no coverage reports unbanked, not not_imported", () => {
    // Both branches would say "unsettled"; the REASON is the whole point, and
    // "we have not imported this" would be the wrong sentence under a payday.
    expect(settledVerdict("income", "2026-08-20", null).reason).toBe("unbanked");
  });

  test("a reason is present exactly when the state is unsettled", () => {
    const cases = [
      settledVerdict("bill", "2026-01-01", "2026-06-01"),
      settledVerdict("bill", "2026-08-01", "2026-06-01"),
      settledVerdict("income", "2026-08-01", "2026-06-01"),
      settledVerdict("bill", "2026-08-01", null),
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
