import { describe, expect, test } from "vitest";
import { budgetDeactivateLines } from "./deactivate-radius";
import { blastRadiusSentence } from "@/components/ui/blast-radius";
import { formatCents } from "@/lib/money";

/**
 * ⛔ Not reachable from the e2e suite. The dialog lives inside a closed
 * `<dialog>`, so no baseline paints it — the whole point of §1 of the
 * 2026-09-08 handoff — and the seeded fixture would have to carry a budget
 * whose series came due before its fake today and never posted. The rule is
 * pinned here instead, and `BudgetRow` has no second copy of it.
 */
describe("budgetDeactivateLines", () => {
  const HOUSING = {
    budgetPhrase: "$2,291.21 / month",
    spentCents: 0,
    overdueCents: 229_121,
    expectedTailCents: 0,
  };

  /**
   * 🔴 The defect, measured on the owner's ledger 2026-09-08: Housing's
   * confirmation named the plan and "$0.00 spent" and stopped, over a month in
   * which the whole $2,291.21 had come due on Sep 1 and never posted.
   */
  test("names the arrears the row behind it is warning about", () => {
    const lines = budgetDeactivateLines(HOUSING, formatCents);
    expect(lines.map((l) => l.label)).toEqual([
      "Budget stopped",
      "Spent so far this period",
      "Already due this period, not imported",
    ]);
    expect(lines[2]!.value).toBe("$2,291.21");
  });

  /** ⛔ Disjoint by construction — both are printed, neither absorbs the other. */
  test("prints arrears and the forward tail as two separate lines", () => {
    const lines = budgetDeactivateLines(
      { budgetPhrase: "$15.00 / month", spentCents: 0, overdueCents: 499, expectedTailCents: 600 },
      formatCents,
    );
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ["Budget stopped", "$15.00 / month"],
      ["Spent so far this period", "$0.00"],
      ["Already due this period, not imported", "$4.99"],
      ["Recurring still expected this period", "$6.00"],
    ]);
  });

  test("says nothing about either when there is nothing to say", () => {
    const lines = budgetDeactivateLines(
      { budgetPhrase: "$130.00 / month", spentCents: 4_200, overdueCents: 0, expectedTailCents: 0 },
      formatCents,
    );
    expect(lines.map((l) => l.label)).toEqual(["Budget stopped", "Spent so far this period"]);
  });

  /** only the plan is the irreversible half — the figures are just measurements */
  test("marks the plan as the thing that cannot be undone", () => {
    const lines = budgetDeactivateLines(HOUSING, formatCents);
    expect(lines.filter((l) => l.irreversible).map((l) => l.label)).toEqual(["Budget stopped"]);
  });

  /** what a screen reader hears before the button can be pressed */
  test("the spoken sentence carries the arrears too", () => {
    const spoken = blastRadiusSentence({
      headline: "Housing stops being budgeted.",
      lines: budgetDeactivateLines(HOUSING, formatCents),
    });
    expect(spoken).toContain("Already due this period, not imported: $2,291.21.");
  });
});
