import { describe, expect, test } from "vitest";
import { diffDays } from "./dates";
import { formatDayShort } from "./format-date";
import { holdingPriceAge, isStaleClose, priceDatesDiffer } from "./holding-price-age";
import { holdingPriceSectionNotes } from "./section-notes";

const TODAY = "2026-08-14";

/** the real helpers, so these tests pin the strings that actually render */
const age = (quotedOn: string | null, today = TODAY) =>
  holdingPriceAge(quotedOn, today, diffDays, formatDayShort);

describe("isStaleClose", () => {
  test("a close from before today is stale", () => {
    expect(isStaleClose("2026-08-06", TODAY, diffDays)).toBe(true);
  });

  test("a close from today is not stale", () => {
    expect(isStaleClose(TODAY, TODAY, diffDays)).toBe(false);
  });

  test("a close dated in the FUTURE is not stale — it is wrong, not old", () => {
    expect(isStaleClose("2026-08-20", TODAY, diffDays)).toBe(false);
  });
});

describe("priceDatesDiffer", () => {
  const rows = (...quotedOn: (string | null)[]) => quotedOn.map((q) => ({ quotedOn: q }));

  test("holdings that all carry the same close date do NOT differ", () => {
    // the owner's real portfolio today: ten holdings, one shared close date.
    // The page note says that once; ten identical row dates would be noise.
    expect(priceDatesDiffer(rows("2026-08-06", "2026-08-06", "2026-08-06"))).toBe(false);
  });

  test("one holding left behind is a disagreement", () => {
    expect(priceDatesDiffer(rows(TODAY, "2026-08-06"))).toBe(true);
  });

  test("an unpriced holding is not a disagreement — it already says 'no price'", () => {
    expect(priceDatesDiffer(rows("2026-08-06", null, "2026-08-06"))).toBe(false);
  });

  test("rows with no closes at all cannot disagree", () => {
    expect(priceDatesDiffer(rows(null, null))).toBe(false);
    expect(priceDatesDiffer([])).toBe(false);
  });

  test("a single holding never disagrees with itself", () => {
    expect(priceDatesDiffer(rows("2026-08-06"))).toBe(false);
  });
});

describe("holdingPriceAge", () => {
  test("says nothing for a holding with no close at all", () => {
    // the cell already prints a "no price" warning; two labels for one
    // condition is worse than one
    expect(age(null)).toBeNull();
  });

  test("says nothing when the close is today's", () => {
    expect(age(TODAY)).toBeNull();
  });

  test("says nothing for a close dated after today", () => {
    expect(age("2026-08-20")).toBeNull();
  });

  test("prints the date the close came from", () => {
    expect(age("2026-08-06")?.text).toBe("as of Aug 6");
  });

  test("the visible text is a DATE, never the subtotal label's words", () => {
    // the selection subtotal's label is deliberately bare ("Today" / "Last
    // close") because a selection can span rows quoted on different days. These
    // dates disambiguate that label and must not compete with it.
    const text = age("2026-08-06")!.text;
    expect(text).not.toMatch(/Today|Last close/);
  });

  test("the boundary is one day, not zero", () => {
    expect(age("2026-08-14")).toBeNull();
    expect(age("2026-08-13")?.text).toBe("as of Aug 13");
  });

  test("counts a single day in the singular", () => {
    expect(age("2026-08-13")?.title).toMatch(/^Priced 1 day ago\./);
  });

  test("counts several days in the plural", () => {
    expect(age("2026-08-06")?.title).toMatch(/^Priced 8 days ago\./);
  });

  test("the title explains that the number is stored, not live", () => {
    expect(age("2026-08-06")?.title).toMatch(/stored close, not a live quote/);
  });

  test("crosses a month boundary without arithmetic drift", () => {
    expect(age("2026-07-31")?.title).toMatch(/^Priced 14 days ago\./);
  });
});

describe("the row date and the page note", () => {
  const note = (quotedOn: (string | null)[], today = TODAY) =>
    holdingPriceSectionNotes({
      rows: quotedOn.map((q) => ({ quotedOn: q })),
      today,
      daysBetween: diffDays,
      formatDay: (iso) => iso,
    });

  test("ONE freshly-priced row silences the note while its neighbours still print dates", () => {
    // This is the whole reason per-row dates exist, and it looks like an
    // inconsistency until you know why. The note is gated on the NEWEST close
    // across the page; a row is gated on its own. Do not "fix" this by making
    // them agree — the note would then have to name every stale symbol, which
    // is what the rows already do.
    const rows = [TODAY, "2026-08-06", "2026-08-06"];

    expect(note(rows)).toEqual([]);
    expect(age(rows[1]!)?.text).toBe("as of Aug 6");
  });

  test("they share one definition of stale, so the boundary cannot drift apart", () => {
    // same population, same day: either both speak or neither does
    expect(note([TODAY])).toEqual([]);
    expect(age(TODAY)).toBeNull();

    expect(note(["2026-08-13"])).toHaveLength(1);
    expect(age("2026-08-13")).not.toBeNull();
  });
});
