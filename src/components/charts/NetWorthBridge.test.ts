import { describe, expect, test } from "vitest";
import { bridgeSummary } from "./NetWorthBridge";

const base = {
  deltaCents: 4_706_906,
  openingCents: 6_658_702,
  closingCents: 11_365_608,
  closes: false,
  unexplainedCents: 500_000,
  unattributedCents: 0,
};

/**
 * 🔴 The title asked `closes` while the residual note three lines below asked
 * `unattributedCents === 0`. Measured on the owner's dashboard 2026-09-10 the
 * card read "+$5,000.00 no transaction explains — and all of it has a name."
 * under a title reading "$5,000.00 of it unexplained."
 */
describe("bridgeSummary — the title and the note answer one question", () => {
  test("a window that closes says so", () => {
    expect(bridgeSummary({ ...base, closes: true, unexplainedCents: 0 }, "· 1 year")).toBe(
      "Net worth · 1 year: $66,587.02 to $113,656.08, +$47,069.06, every cent of it accounted for.",
    );
  });

  test("a restated balance is named, never called unexplained", () => {
    expect(bridgeSummary(base, "· 1 year")).toContain(
      "$5,000.00 of it named by a restatement rather than a transaction",
    );
    expect(bridgeSummary(base, "· 1 year")).not.toContain("unexplained");
  });

  test("a genuine hole is the figure with no name, not the whole residual", () => {
    // $5,000.00 unexplained of which $1,500.00 has no name at all: the note
    // renders the $1,500.00, and so does this
    const hole = { ...base, attributedCents: 350_000, unattributedCents: 150_000 };
    expect(bridgeSummary(hole, "· 1 year")).toContain("$1,500.00 of it with no explanation at all");
    expect(bridgeSummary(hole, "· 1 year")).not.toContain("$5,000.00");
  });

  test("the window label and the two endpoints are the caller's, verbatim", () => {
    expect(bridgeSummary({ ...base, closes: true, unexplainedCents: 0 }, "· 3 months")).toContain(
      "Net worth · 3 months: $66,587.02 to $113,656.08",
    );
  });
});
