import { describe, expect, test } from "vitest";
import { diffDays } from "./dates";
import { formatDayShort } from "./format-date";
import { holdingPriceAge, isStaleClose, priceColumnAge } from "./holding-price-age";
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

describe("priceColumnAge", () => {
  const rows = (...quotedOn: (string | null)[]) => quotedOn.map((q) => ({ quotedOn: q }));
  const column = (quotedOn: (string | null)[], today = TODAY) =>
    priceColumnAge(rows(...quotedOn), today, diffDays, formatDayShort);

  test("one shared stale close is stated ONCE, on the column header", () => {
    // the owner's real portfolio: ten holdings, one shared close date. The fact
    // belongs to the whole column, so the column says it — not ten rows.
    const col = column(["2026-08-06", "2026-08-06", "2026-08-06"]);

    expect(col.header?.text).toBe("as of Aug 6");
    expect(col.row("2026-08-06")).toBeNull();
  });

  test("a shared close that is NOT stale says nothing anywhere", () => {
    const col = column([TODAY, TODAY]);

    expect(col.header).toBeNull();
    expect(col.row(TODAY)).toBeNull();
  });

  test("when the rows disagree the header goes silent and each stale row speaks", () => {
    // the header can no longer describe the column, so it must not try: a single
    // date over a mixed column would be a false claim about the fresh rows.
    const col = column([TODAY, "2026-08-06"]);

    expect(col.header).toBeNull();
    expect(col.row("2026-08-06")?.text).toBe("as of Aug 6");
    expect(col.row(TODAY)).toBeNull();
  });

  test("exactly one of the header and the row ever speaks about a given row", () => {
    // The invariant the shape exists to make unrepresentable. Both speaking is
    // repetition; neither speaking is the blind spot pass 56 shipped this for.
    for (const dates of [["2026-08-06", "2026-08-06"], [TODAY, "2026-08-06"], [TODAY, TODAY]]) {
      const col = column(dates);
      for (const d of dates) {
        const spoken = [col.header, col.row(d)].filter((a) => a !== null);
        // a fresh close is the one case with nothing to say at all
        expect(spoken.length).toBe(isStaleClose(d, TODAY, diffDays) ? 1 : 0);
      }
    }
  });

  test("an unpriced holding does not break the shared date — it says 'no price' itself", () => {
    const col = column(["2026-08-06", null, "2026-08-06"]);

    expect(col.header?.text).toBe("as of Aug 6");
    expect(col.row(null)).toBeNull();
  });

  test("a column with nothing priced at all is silent", () => {
    expect(column([null, null]).header).toBeNull();
    expect(column([]).header).toBeNull();
    expect(column([]).row(null)).toBeNull();
  });

  test("a single holding is a shared date, not a disagreement", () => {
    expect(column(["2026-08-06"]).header?.text).toBe("as of Aug 6");
    expect(column(["2026-08-06"]).row("2026-08-06")).toBeNull();
  });

  test("the header carries the same explanation a row would have carried", () => {
    // one definition of the sentence, so the two surfaces cannot word the same
    // fact differently
    expect(column(["2026-08-06"]).header?.title).toBe(age("2026-08-06")?.title);
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
