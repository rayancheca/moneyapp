import { describe, expect, test } from "vitest";
import { comparePeriods } from "./compared-windows";
import { resolvePeriod } from "./period";

/**
 * Whether /spending may set a period against the one before it, and over which
 * days.
 *
 * The owner's ledger opens on 2022-08-25 (its first active row), and on
 * 2026-09-14 every account he spends from has been imported through Aug 12
 * (Chase Checking; `spendingCoverageThrough`). The dates below are those two
 * edges, so each case is a window a reader can reach with the ‹ arrow or a pill.
 */
const TODAY = "2026-09-14";
const OPENS = "2022-08-25";
const at = (key: string, today = TODAY) => resolvePeriod({ period: key }, today, OPENS);

describe("comparePeriods — the opening edge", () => {
  // every account imported through today: nothing is cut, so only the opening edge speaks
  const open = { today: TODAY, importedThrough: TODAY, ledgerOpens: OPENS };

  test("a prior window wholly inside the ledger is compared whole, under both periods' own names", () => {
    expect(comparePeriods({ period: at("2024"), ...open })).toMatchObject({
      kind: "whole",
      current: { from: "2024-01-01", to: "2024-12-31", label: "2024" },
      prior: { from: "2023-01-01", to: "2023-12-31", label: "2023" },
    });
  });

  /**
   * 🔴 Q8. `/spending?period=ALL` printed "All time against Aug 4, 2018 – Aug 24,
   * 2022 — 20 up · 0 down": a window holding no row at all, read as a measured
   * $0 in every category, so every category that spent anything "rose".
   */
  test("a prior window wholly before the ledger is refused, and the sentence says why", () => {
    expect(comparePeriods({ period: at("ALL"), ...open })).toEqual({
      kind: "refused",
      reason: "before-records",
      sentence:
        "There is no comparison with Aug 4, 2018 – Aug 24, 2022: the ledger opens on Aug 25, 2022, after all of it.",
    });
  });

  /**
   * 🔴 S8. `/spending?period=2023` read "2023 against 2022 — 15 up · 0 down" while
   * /summary/2023 already refused the same comparison: the ledger holds Aug 25 –
   * Dec 31 of 2022, so a change against it describes when importing started.
   */
  test("a prior window the ledger holds only part of is refused in /summary's words", () => {
    expect(comparePeriods({ period: at("2023"), ...open })).toEqual({
      kind: "refused",
      reason: "partly-covered",
      sentence:
        "There is no comparison with 2022: the ledger opens on Aug 25, 2022, so that window is only partly in it and a change measured against it would describe when importing started.",
    });
    // …and a month is the same rule: August 2022 holds 7 of its 31 days
    expect(comparePeriods({ period: at("2022-09"), ...open })).toMatchObject({
      kind: "refused",
      reason: "partly-covered",
    });
  });

  /**
   * ⛔ Both sides of the edge. A prior window that STARTS on the ledger's first
   * day is wholly inside it — `emptyPeriodReason`'s own strictness, and
   * /summary's `priorFrom >= ledgerStart`. On the real ledger that is
   * 2022-08-26 against Aug 25, 2022.
   */
  test("a prior window starting ON the first day is compared; one day earlier is not", () => {
    expect(comparePeriods({ period: at("2022-08-26"), ...open })).toMatchObject({
      kind: "whole",
      prior: { from: "2022-08-25", to: "2022-08-25", label: "Aug 25, 2022" },
    });
    expect(comparePeriods({ period: at("2022-08-25"), ...open })).toMatchObject({
      kind: "refused",
      reason: "before-records",
    });

    const july = resolvePeriod({ period: "2026-07" }, TODAY);
    expect(comparePeriods({ period: july, ...open, ledgerOpens: "2026-06-01" }).kind).toBe("whole");
    expect(comparePeriods({ period: july, ...open, ledgerOpens: "2026-06-02" })).toMatchObject({
      kind: "refused",
      reason: "partly-covered",
    });
  });

  test("an empty ledger has nothing to compare", () => {
    expect(comparePeriods({ period: at("2024"), ...open, ledgerOpens: null })).toMatchObject({
      kind: "refused",
      reason: "no-ledger",
    });
    expect(comparePeriods({ period: at("2024"), ...open, importedThrough: null })).toMatchObject({
      kind: "refused",
      reason: "no-ledger",
    });
  });
});

/**
 * 🔴 S1 / S2. `/spending?period=2026-09&where=relief` read "September 2026
 * against August 2026 — 2 up · 7 down" and "Housing … -$2,229.85 on August
 * 2026": fourteen days of September — two of them unimported, and nothing past
 * Aug 12 for Chase Checking — set against a whole August holding the Aug 4 rent.
 * Owner decision 2026-09-14: CUT both windows to the same days, ending at the
 * last day every account he spends from has been imported through, and name
 * the cut windows.
 */
describe("comparePeriods — the closing edge", () => {
  const CUT = "2026-08-12";
  const cut = (key: string, importedThrough = CUT, today = TODAY) =>
    comparePeriods({ period: resolvePeriod({ period: key }, today, OPENS), today, importedThrough, ledgerOpens: OPENS });

  test("August is cut on both sides to the days every account you spend from has been imported through", () => {
    expect(cut("2026-08")).toMatchObject({
      kind: "clipped",
      current: { from: "2026-08-01", to: "2026-08-12", label: "Aug 1 – 12, 2026" },
      prior: { from: "2026-07-01", to: "2026-07-12", label: "Jul 1 – 12, 2026" },
      through: "2026-08-12",
      note: "Both windows stop on Aug 12, 2026, the last day every account you spend from has been imported through, so the same days are set side by side.",
    });
  });

  test("a quarter steps back three calendar months; a year and year-to-date twelve, the same way", () => {
    expect(cut("2026-Q3")).toMatchObject({
      kind: "clipped",
      current: { from: "2026-07-01", to: "2026-08-12", label: "Jul 1 – Aug 12, 2026" },
      prior: { from: "2026-04-01", to: "2026-05-12", label: "Apr 1 – May 12, 2026" },
    });
    const year = {
      kind: "clipped",
      current: { from: "2026-01-01", to: "2026-08-12", label: "Jan 1 – Aug 12, 2026" },
      prior: { from: "2025-01-01", to: "2025-08-12", label: "Jan 1 – Aug 12, 2025" },
    };
    expect(cut("2026")).toMatchObject(year);
    // ⛔ YTD's prior is the same days a year earlier already; cut, it must land
    // on exactly the year's windows, or two pills name one cut two ways
    expect(cut("YTD")).toMatchObject(year);
  });

  test("a window that ends on or before the cut is compared whole", () => {
    expect(cut("2026-07")).toMatchObject({
      kind: "whole",
      current: { label: "July 2026" },
      prior: { label: "June 2026" },
    });
    // a custom window ending ON the cut keeps its whole labels
    const custom = resolvePeriod({ from: "2026-08-01", to: "2026-08-12" }, TODAY);
    expect(comparePeriods({ period: custom, today: TODAY, importedThrough: CUT, ledgerOpens: OPENS })).toMatchObject({
      kind: "whole",
      current: { label: "Aug 1 – 12, 2026" },
      prior: { from: "2026-07-20", to: "2026-07-31", label: "Jul 20 – 31, 2026" },
    });
  });

  /**
   * 🔴 The cut is the EARLIEST of the live spenders' frontiers. On 2026-09-14
   * this refusal read "every account you spend from has only been imported
   * through Aug 12, 2026" while three of the four were imported into September
   * (Venture X Sep 13, Discover Sep 8, Chase Sapphire Sep 2). It names the day
   * in the clipped note's own words instead.
   */
  test("a window that starts after the cut is refused, and the refusal names the cut as the last day ALL of them reach", () => {
    expect(cut("2026-09")).toEqual({
      kind: "refused",
      reason: "not-imported",
      sentence:
        "There is no comparison for September 2026 yet: Aug 12, 2026, the last day every account you spend from has been imported through, comes before any of it. A gap there would be missing statements, not less spending.",
    });
    for (const key of ["W2026-09-07", "2026-09-12"]) {
      expect(cut(key)).toMatchObject({ kind: "refused", reason: "not-imported" });
    }
  });

  test("both ends of the cut: ON the first day is one day, the day before is refused, the last day is whole", () => {
    expect(cut("2026-08", "2026-08-01")).toMatchObject({
      kind: "clipped",
      current: { from: "2026-08-01", to: "2026-08-01", label: "Aug 1, 2026" },
      prior: { from: "2026-07-01", to: "2026-07-01", label: "Jul 1, 2026" },
    });
    expect(cut("2026-08", "2026-07-31")).toMatchObject({ kind: "refused", reason: "not-imported" });
    expect(cut("2026-08", "2026-08-31")).toMatchObject({ kind: "whole", current: { label: "August 2026" } });
  });

  test("a period still running is cut at today even when every account is current, and says so", () => {
    const running = {
      kind: "clipped",
      current: { from: "2026-08-01", to: "2026-08-26", label: "Aug 1 – 26, 2026" },
      prior: { from: "2026-07-01", to: "2026-07-26", label: "Jul 1 – 26, 2026" },
      note: "August 2026 is still running, so both windows stop on Aug 26, 2026, today, and the same days are set side by side.",
    };
    expect(cut("2026-08", "2026-08-26", "2026-08-26")).toMatchObject(running);
    // a frontier past today cannot reach days that have not happened
    expect(cut("2026-08", "2026-09-01", "2026-08-26")).toMatchObject(running);
  });

  test("a day the prior window does not have clamps to its last day, never an invalid date", () => {
    expect(cut("2026-03", "2026-03-30", "2026-03-30")).toMatchObject({
      prior: { from: "2026-02-01", to: "2026-02-28", label: "Feb 1 – 28, 2026" },
    });
    expect(cut("2028", "2028-02-29", "2028-02-29")).toMatchObject({
      current: { label: "Jan 1 – Feb 29, 2028" },
      prior: { from: "2027-01-01", to: "2027-02-28", label: "Jan 1 – Feb 28, 2027" },
    });
  });

  test("a period that has not started is not called unimported", () => {
    expect(cut("2026-10")).toMatchObject({ kind: "refused", reason: "future" });
  });

  /**
   * 🔴 The refusal at the opening edge was built from the CUT prior window. On
   * 2026-09-14 `/spending?period=ALL` read "There is no comparison with Aug 4,
   * 2018 – Jul 22, 2022" — All time's span stepped back from the Aug 12 cut, a
   * window no ‹ arrow names — and the same page with every account current
   * named Aug 4, 2018 – Aug 24, 2022. One refusal, two names, depending on
   * import state.
   */
  test("a cut period refused at the opening edge names the prior window uncut, whatever the imports reach", () => {
    const before = {
      kind: "refused",
      reason: "before-records",
      sentence:
        "There is no comparison with Aug 4, 2018 – Aug 24, 2022: the ledger opens on Aug 25, 2022, after all of it.",
    };
    expect(cut("ALL")).toEqual(before);
    expect(cut("ALL", TODAY)).toEqual(before);
  });

  /**
   * ⛔ Both sides of the same question. A prior window whose cut days lie
   * wholly before the ledger while the window itself straddles its first day
   * is refused as the window straddling it, under that window's own name — not
   * "after all of" a Jul 1 – 12 no pill or arrow ever shows.
   */
  test("a prior window the cut would leave wholly before the ledger is refused as the window that straddles it", () => {
    const august = resolvePeriod({ period: "2026-08" }, TODAY);
    expect(comparePeriods({ period: august, today: TODAY, importedThrough: CUT, ledgerOpens: "2026-07-20" })).toEqual({
      kind: "refused",
      reason: "partly-covered",
      sentence:
        "There is no comparison with July 2026: the ledger opens on Jul 20, 2026, so that window is only partly in it and a change measured against it would describe when importing started.",
    });
    // and a ledger opening ON the prior window's first day still cuts both sides
    expect(comparePeriods({ period: august, today: TODAY, importedThrough: CUT, ledgerOpens: "2026-07-01" })).toMatchObject({
      kind: "clipped",
      prior: { from: "2026-07-01", to: "2026-07-12", label: "Jul 1 – 12, 2026" },
    });
  });
});
