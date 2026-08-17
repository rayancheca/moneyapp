import { describe, expect, it } from "vitest";
import { RECONCILE_STATUSES, isVerdictStale, periodVerdict } from "./reconciliation";

const period = (beginning: number | null, ending: number | null) => ({
  beginningBalanceCents: beginning,
  endingBalanceCents: ending,
});

describe("periodVerdict", () => {
  it("reconciles when the movement closes the printed balances exactly", () => {
    expect(periodVerdict(period(10_000, 12_500), 2_500, { isInvestment: false })).toEqual({
      reconciliation: "reconciled",
      gapCents: null,
      marketChangeCents: null,
    });
  });

  it("reports the shortfall as a gap when the movement does not close", () => {
    expect(periodVerdict(period(10_000, 12_500), 2_000, { isInvestment: false })).toEqual({
      reconciliation: "gap",
      gapCents: 500,
      marketChangeCents: null,
    });
  });

  it("signs the gap by which side is short", () => {
    // replayed MORE than the statement ended with → negative gap
    expect(periodVerdict(period(10_000, 12_500), 3_000, { isInvestment: false }).gapCents).toBe(-500);
  });

  it("treats a one-cent difference as a gap, not a rounding tolerance", () => {
    const v = periodVerdict(period(33_070, 824_511), 791_442, { isInvestment: false });
    expect(v.reconciliation).toBe("gap");
    expect(v.gapCents).toBe(-1);
  });

  it("grades an investment period as a value anchor and never as a gap", () => {
    // market movement is not a transaction, so the residual is the market change
    expect(periodVerdict(period(10_000, 15_000), 1_000, { isInvestment: true })).toEqual({
      reconciliation: "value_anchor",
      gapCents: null,
      marketChangeCents: 4_000,
    });
  });

  it("is not_applicable when either printed balance is missing", () => {
    expect(periodVerdict(period(null, 12_500), 2_500, { isInvestment: false }).reconciliation).toBe(
      "not_applicable",
    );
    expect(periodVerdict(period(10_000, null), 2_500, { isInvestment: false }).reconciliation).toBe(
      "not_applicable",
    );
  });

  it("counts quarantined rows — the statuses reconciliation reads are its own", () => {
    // guards the constant itself: replay reads active+excluded, reconciliation
    // reads those PLUS quarantined, and the two lists are deliberately different
    expect([...RECONCILE_STATUSES].sort()).toEqual(["active", "excluded", "quarantined"]);
  });
});

describe("isVerdictStale", () => {
  const stored = { reconciliation: "gap" as const, gapCents: 23_185 };

  it("is stale when the stored gap no longer matches the recomputed one", () => {
    const fresh = periodVerdict(period(19_229, 168_038), -232_343, { isInvestment: false });
    expect(fresh.gapCents).toBe(381_152);
    expect(isVerdictStale(stored, fresh)).toBe(true);
  });

  it("is not stale when stored and recomputed agree", () => {
    // 125_624 is July's real replay WITH the plug still in it — the movement
    // that produced the stored $231.85 in the first place
    const fresh = periodVerdict(period(19_229, 168_038), 125_624, { isInvestment: false });
    expect(fresh.gapCents).toBe(23_185);
    expect(isVerdictStale(stored, fresh)).toBe(false);
  });

  it("is stale when the grade changed even though both gaps are null", () => {
    expect(
      isVerdictStale(
        { reconciliation: "reconciled", gapCents: null },
        { reconciliation: "not_applicable", gapCents: null, marketChangeCents: null },
      ),
    ).toBe(true);
  });

  it("never calls an accepted period stale — accepted is a human decision", () => {
    // reconcileAccounts skips 'accepted' periods entirely, so recomputing one
    // and comparing would report every accepted period as drift forever
    expect(
      isVerdictStale(
        { reconciliation: "accepted", gapCents: 500 },
        { reconciliation: "gap", gapCents: 900, marketChangeCents: null },
      ),
    ).toBe(false);
  });
});
