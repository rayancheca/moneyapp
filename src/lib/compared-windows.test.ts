import { describe, expect, test } from "vitest";
import { comparePeriods } from "./compared-windows";
import { resolvePeriod } from "./period";

/**
 * Whether /spending may set a period against the one before it.
 *
 * The owner's ledger opens on 2022-08-25 (its first active row); the dates
 * below are that edge, so each case is a window a reader can reach with the ‹
 * arrow or the "All" pill.
 */
const TODAY = "2026-09-14";
const OPENS = "2022-08-25";
const at = (key: string, today = TODAY) => resolvePeriod({ period: key }, today, OPENS);

describe("comparePeriods — the opening edge", () => {
  test("a prior window wholly inside the ledger is compared whole, under both periods' own names", () => {
    expect(comparePeriods({ period: at("2024"), today: TODAY, ledgerOpens: OPENS })).toMatchObject({
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
    expect(comparePeriods({ period: at("ALL"), today: TODAY, ledgerOpens: OPENS })).toEqual({
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
    const c = comparePeriods({ period: at("2023"), today: TODAY, ledgerOpens: OPENS });
    expect(c).toEqual({
      kind: "refused",
      reason: "partly-covered",
      sentence:
        "There is no comparison with 2022: the ledger opens on Aug 25, 2022, so that window is only partly in it and a change measured against it would describe when importing started.",
    });
    // …and a month is the same rule: August 2022 holds 7 of its 31 days
    expect(comparePeriods({ period: at("2022-09"), today: TODAY, ledgerOpens: OPENS })).toMatchObject({
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
    expect(comparePeriods({ period: at("2022-08-26"), today: TODAY, ledgerOpens: OPENS })).toMatchObject({
      kind: "whole",
      prior: { from: "2022-08-25", to: "2022-08-25", label: "Aug 25, 2022" },
    });
    expect(comparePeriods({ period: at("2022-08-25"), today: TODAY, ledgerOpens: OPENS })).toMatchObject({
      kind: "refused",
      reason: "before-records",
    });

    const july = resolvePeriod({ period: "2026-07" }, "2026-09-14");
    expect(comparePeriods({ period: july, today: TODAY, ledgerOpens: "2026-06-01" }).kind).toBe("whole");
    expect(comparePeriods({ period: july, today: TODAY, ledgerOpens: "2026-06-02" })).toMatchObject({
      kind: "refused",
      reason: "partly-covered",
    });
  });

  test("an empty ledger has nothing to compare", () => {
    expect(comparePeriods({ period: at("2024"), today: TODAY, ledgerOpens: null })).toMatchObject({
      kind: "refused",
      reason: "no-ledger",
    });
  });
});
