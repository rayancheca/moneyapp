import { describe, expect, test } from "vitest";
import {
  DateOutOfRangeError,
  MAX_FINANCIAL_DATE,
  MIN_FINANCIAL_DATE,
  assertWithinFinancialWindow,
  financialWindowMessage,
  isWithinFinancialWindow,
} from "./date-window";

describe("isWithinFinancialWindow", () => {
  test.each(["2026-07-08", "2024-06-04", MIN_FINANCIAL_DATE, MAX_FINANCIAL_DATE])(
    "accepts %s (bounds are inclusive)",
    (day) => expect(isWithinFinancialWindow(day)).toBe(true),
  );

  test.each(["1026-05-05", "1969-12-31", "2100-01-01", "9999-12-31"])(
    "rejects the fat-fingered year %s",
    (day) => expect(isWithinFinancialWindow(day)).toBe(false),
  );

  test("never throws on garbage — it chains after an isValidIsoDate refinement", () => {
    // zod runs every refinement in a chain even after an earlier one failed, so
    // this predicate sees strings isValidIsoDate has already rejected
    for (const junk of ["", "junk", "2026-13-40", "20260-01-01", "2026-7-8", "2026-02-30"]) {
      expect(isWithinFinancialWindow(junk)).toBe(false);
    }
  });
});

describe("assertWithinFinancialWindow", () => {
  test("passes an in-window date through silently", () => {
    expect(() => assertWithinFinancialWindow("anchoredOn", "2026-07-08")).not.toThrow();
  });

  test("rejects out-of-range, naming the field and the value", () => {
    expect(() => assertWithinFinancialWindow("anchoredOn", "9999-12-31")).toThrow(DateOutOfRangeError);
    expect(() => assertWithinFinancialWindow("anchoredOn", "9999-12-31")).toThrow(
      /anchoredOn must be between 1970-01-01 and 2099-12-31 — got "9999-12-31"/,
    );
  });

  test("rejects rather than clamping — a clamped date would invent data", () => {
    let thrown: unknown;
    try {
      assertWithinFinancialWindow("postedOn", "1026-05-05");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DateOutOfRangeError);
    // nothing to "return": the helper has no success value a caller could
    // mistake for a corrected date
    expect(assertWithinFinancialWindow("postedOn", "2026-05-05")).toBeUndefined();
  });
});

describe("financialWindowMessage", () => {
  test("names the field it guards", () => {
    expect(financialWindowMessage("occurredOn")).toBe(
      `occurredOn must be between ${MIN_FINANCIAL_DATE} and ${MAX_FINANCIAL_DATE}`,
    );
  });
});
