import { describe, expect, test } from "vitest";
import {
  absenceIsEvidence,
  dueDayIsRead,
  forecastConfidence,
  lastDueDayRead,
  paydayIsRead,
  settledVerdict,
  type ConfidenceInput,
  type DueDayReading,
  type OccurrenceReading,
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

/**
 * The accounts a series bills on imported through `observedThrough`, with `graceDays` for a payment to post — and, by
 * default, not through today, so an import is what an unread day waits for.
 */
const read = (observedThrough: string | null, graceDays = 3, readsToToday = false): DueDayReading => ({
  observedThrough,
  graceDays,
  readsToToday,
});

/** A bill's reading: what `settledVerdict` grades money out by — its due day's (`read`). */
const bill = (observedThrough: string | null, graceDays = 3): OccurrenceReading => ({
  dueDay: read(observedThrough, graceDays),
  paydaysCheckedThrough: null,
});

/**
 * A pay series' reading: the accounts its pay lands in now checked through `checkedThrough` — and, by default, a bills'
 * reading that has read nothing, so a verdict that graded a payday by it would show.
 */
const pay = (checkedThrough: string | null, dueDay: DueDayReading = read(null)): OccurrenceReading => ({
  dueDay,
  paydaysCheckedThrough: checkedThrough,
});

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

/*
 * Whether the ledger has looked for a payday's deposit: the day every pay sentence names (`checkedThroughBySeries`),
 * a payday ON it read, with no grace — `unbankedIncomeForSeries`' rule, shared with the calendar.
 */
describe("paydayIsRead — the one predicate for a passed payday", () => {
  test("THE BOUNDARY: a payday on the checked day was looked for; the day after was not", () => {
    expect(paydayIsRead("2026-09-24", "2026-09-24")).toBe(true);
    expect(paydayIsRead("2026-09-17", "2026-09-24")).toBe(true);
    expect(paydayIsRead("2026-09-25", "2026-09-24")).toBe(false);
  });

  test("an account the pay lands in with no checked record: nothing was looked for", () => {
    expect(paydayIsRead("2026-06-11", null)).toBe(false);
  });
});

describe("settledVerdict", () => {
  test("a bill is graded by its due day's reading, whatever the pay's frontier says", () => {
    const reading: OccurrenceReading = { dueDay: read("2026-08-12"), paydaysCheckedThrough: "2026-12-31" };
    expect(settledVerdict("bill", "2026-08-20", reading, true).reason).toBe("not_imported");
  });

  test("a bill absent from a day the ledger HAS been shown, and its grace after it, is missed", () => {
    // The pass-45 case, which must keep working: $2,285.70 of overdue rent hid
    // behind a green budget. A covered, empty day is a real answer.
    expect(settledVerdict("bill", "2026-08-10", bill("2026-08-14"), true)).toEqual({
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
    expect(settledVerdict("bill", "2026-10-01", bill("2026-10-03"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
    expect(settledVerdict("bill", "2026-10-01", bill("2026-10-04"), true)).toEqual({
      state: "missed",
      reason: null,
    });
  });

  /*
   * 🔴 An archived card or a cash wallet is read through today (`silenceReadThrough`), so all a day due inside its last
   * grace waits for is days still to come — and it read "no import has covered it yet" of an import that will never
   * come (review of the 2026-10-08 batch). ⚖️ No new verdict: unsettled, as before; the reason names what it waits for.
   */
  test("unread on accounts read through today: its days to post are not over — unsettled, never missed", () => {
    const throughToday = (graceDays: number): OccurrenceReading => ({
      dueDay: read("2026-10-08", graceDays, true),
      paydaysCheckedThrough: null,
    });
    expect(settledVerdict("bill", "2026-10-06", throughToday(3), true)).toEqual({
      state: "unsettled",
      reason: "in_grace",
    });
    // …and read once those days are over, as any day: missed
    expect(settledVerdict("bill", "2026-10-05", throughToday(3), true)).toEqual({ state: "missed", reason: null });
    // …and the cautious reasons come first wherever they apply — a payday is graded by the pay's own frontier
    expect(settledVerdict("income", "2026-10-06", throughToday(3), true).reason).toBe("not_imported");
  });

  test("a bill on the frontier day itself is not yet known — its grace has not been imported", () => {
    expect(settledVerdict("bill", "2026-08-14", bill("2026-08-14"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("a bill past the frontier is unsettled, not missed", () => {
    expect(settledVerdict("subscription", "2026-08-15", bill("2026-08-12"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("no frontier at all is the most cautious answer", () => {
    expect(settledVerdict("bill", "2026-08-10", bill(null), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
  });

  test("income is never missed, however well covered the day is", () => {
    // The measured defect: three cash paydays drawn red in August 2026. Even a
    // day imported to the minute cannot disprove cash he was handed and has not
    // deposited.
    expect(settledVerdict("income", "2026-08-06", pay("2026-12-31"), true)).toEqual({
      state: "unsettled",
      reason: "unbanked",
    });
  });

  /*
   * 🔴 This was "income with no coverage reports unbanked, not not_imported". Measured on his ledger copy 2026-10-12,
   * the calendar drew Oct 1 and Oct 8 "not yet known (not banked yet)" while the dashboard, the forecast and /budgets
   * said they "fall after Sep 24, the last day every account that pay lands in has been checked through — so the
   * ledger has not looked for their deposits". "Not banked yet" claims someone looked.
   */
  test("a payday after the day its accounts are checked through: no import has covered it yet", () => {
    expect(settledVerdict("income", "2026-10-01", pay("2026-09-24"), true)).toEqual({
      state: "unsettled",
      reason: "not_imported",
    });
    // …and with no checked record at all, nothing has looked
    expect(settledVerdict("income", "2026-08-20", pay(null), true).reason).toBe("not_imported");
  });

  test("THE BOUNDARY: a payday on or before the day its accounts are checked through is not banked yet", () => {
    expect(settledVerdict("income", "2026-09-24", pay("2026-09-24"), true).reason).toBe("unbanked");
    expect(settledVerdict("income", "2026-09-25", pay("2026-09-24"), true).reason).toBe("not_imported");
    expect(settledVerdict("income", "2026-06-11", pay("2026-09-24"), true).reason).toBe("unbanked");
  });

  /*
   * ⛔ Never the bills' reading. Measured on his ledger copy 2026-10-12, `dueDayReadings` reads the pay through Chase
   * Checking's Aug 12 — an account it once landed in — and would call Aug 13 unread beside a dashboard that counts it
   * checked through Wells Fargo's Sep 24; and a bills' reading far ahead must not vouch for a payday nobody checked.
   */
  test("a payday is graded by its pay's frontier, whatever the bills' reading says", () => {
    expect(settledVerdict("income", "2026-08-13", pay("2026-09-24", read("2026-08-12")), true).reason).toBe("unbanked");
    expect(settledVerdict("income", "2026-10-01", pay("2026-09-24", read("2026-12-31", 0)), true).reason).toBe(
      "not_imported",
    );
  });

  test("a series with too few postings cannot support a missed claim", () => {
    // FPL: ONE posting, from which the app extrapolated a due date that was
    // wrong by thirteen days — and then reported the biller as delinquent on it.
    expect(settledVerdict("bill", "2026-08-10", bill("2026-08-14"), false)).toEqual({
      state: "unsettled",
      reason: "schedule_unproven",
    });
  });

  test("an unimported day outranks an unproven schedule", () => {
    // Both are true; "we have not been shown this day" is the stronger and more
    // actionable answer, so it is the one reported.
    expect(settledVerdict("bill", "2026-08-20", bill("2026-08-12"), false).reason).toBe("not_imported");
    // …and a day imported without its grace is not shown either
    expect(settledVerdict("bill", "2026-08-10", bill("2026-08-12"), false).reason).toBe("not_imported");
  });

  test("a proven schedule on a covered day is still missed", () => {
    expect(settledVerdict("bill", "2026-08-10", bill("2026-08-13"), true)).toEqual({
      state: "missed",
      reason: null,
    });
  });

  test("a reason is present exactly when the state is unsettled", () => {
    const cases = [
      settledVerdict("bill", "2026-01-01", bill("2026-06-01"), true),
      settledVerdict("bill", "2026-08-01", bill("2026-06-01"), true),
      settledVerdict("bill", "2026-05-31", bill("2026-06-01"), true),
      settledVerdict("income", "2026-08-01", pay("2026-06-01"), true),
      settledVerdict("bill", "2026-08-01", bill(null), true),
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
