import { describe, expect, it } from "vitest";
import { clampPage, pageCount, parseFilters } from "./query";

/**
 * URL params are user input at a system boundary: `?page=` arrives unvalidated
 * from a paste, a stale bookmark, or a fuzzer. parseFilters owns the lower
 * bound and the absurdity cap; clampPage owns the upper bound, which only a
 * caller holding the result count can enforce.
 */
describe("parseFilters page", () => {
  it("defaults to page 1 and keeps a valid page", () => {
    expect(parseFilters({}).page).toBe(1);
    expect(parseFilters({ page: "7" }).page).toBe(7);
  });

  it("floors malformed, zero, negative and fractional pages to 1", () => {
    for (const page of ["0", "-3", "1.5", "abc", "", "1e999"]) {
      expect(parseFilters({ page }).page).toBe(1);
    }
  });

  it("caps an absurd page so it can never become an absurd SQL offset", () => {
    const parsed = parseFilters({ page: "1e21" });
    expect(parsed.page).toBe(1_000_000);
    expect(Number.isSafeInteger(parsed.page)).toBe(true);
    expect(parseFilters({ page: "99999" }).page).toBe(99999); // below the cap, untouched
  });
});

describe("pageCount", () => {
  it("is at least 1, even with zero rows", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(1, 50)).toBe(1);
  });

  it("counts partial trailing pages", () => {
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(9688, 50)).toBe(194);
  });

  it("falls back to 1 for a nonsense page size or total", () => {
    expect(pageCount(100, 0)).toBe(1);
    expect(pageCount(100, -5)).toBe(1);
    expect(pageCount(Number.NaN, 50)).toBe(1);
  });
});

describe("clampPage", () => {
  it("pulls an out-of-range page back to the last page", () => {
    const filters = parseFilters({ page: "99999", view: "review" });
    const clamped = clampPage(filters, 9688, 50);
    expect(clamped.page).toBe(194);
    expect(clamped.view).toBe("review"); // every other filter survives
    expect(filters.page).toBe(99999); // input untouched
  });

  it("clamps to page 1 when nothing matches", () => {
    expect(clampPage(parseFilters({ page: "12" }), 0, 50).page).toBe(1);
  });

  it("returns the same object when the page is already in range", () => {
    const filters = parseFilters({ page: "2" });
    expect(clampPage(filters, 9688, 50)).toBe(filters);
    expect(clampPage(parseFilters({ page: "194" }), 9688, 50).page).toBe(194);
  });
});
