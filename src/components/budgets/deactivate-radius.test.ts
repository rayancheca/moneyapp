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
    // his ledger 2026-10-08: rent and its utilities, both Oct 1, on days no import has reached
    overdueUnreadCents: 229_121,
    expectedTailCents: 0,
  };

  /**
   * 🔴 The defect, measured on the owner's ledger 2026-09-08: Housing's
   * confirmation named the plan and "$0.00 spent" and stopped, over a month in
   * which the whole $2,291.21 had come due on Sep 1 and never posted.
   */
  test("names the arrears the row behind it reports", () => {
    const lines = budgetDeactivateLines(HOUSING, formatCents);
    expect(lines.map((l) => l.label)).toEqual([
      "Budget stopped",
      "Spent so far this period",
      "Due this period by today, no import has covered it yet",
    ]);
    expect(lines[2]!.value).toBe("$2,291.21");
  });

  /**
   * 🔴 "Already due" is a claim about the PAST, and the figure is not only past.
   * `overdueCents` is `budgetOverdue(start, today)` — INCLUSIVE of today — and a
   * bill dated today is due, not late, until it posts. Asked 2026-09-15, the
   * owner's Car budget carries Car insurance (due Sep 11) and the Car lease (due
   * Sep 15, that very day). The type holds cents only and cannot say which part
   * is dated today, which is exactly why the label has to be true of both.
   */
  test("a bill due TODAY is not called already due", () => {
    const lines = budgetDeactivateLines(
      {
        budgetPhrase: "$1,056.53 / month",
        spentCents: 0,
        overdueCents: 36_149 + 69_504,
        overdueUnreadCents: 36_149 + 69_504,
        expectedTailCents: 0,
      },
      formatCents,
    );
    expect(lines[2]).toEqual({ label: "Due this period by today, no import has covered it yet", value: "$1,056.53" });
    expect(lines.every((l) => !/already|came due|by now/i.test(l.label))).toBe(true);
    // …and it still names the window its figure starts at, like its siblings
    expect(lines.slice(1).every((l) => /this period/.test(l.label))).toBe(true);
  });

  /** ⛔ Disjoint by construction — both are printed, neither absorbs the other. */
  test("prints arrears and the forward tail as two separate lines", () => {
    const lines = budgetDeactivateLines(
      { budgetPhrase: "$15.00 / month", spentCents: 0, overdueCents: 499, overdueUnreadCents: 499, expectedTailCents: 600 },
      formatCents,
    );
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ["Budget stopped", "$15.00 / month"],
      ["Spent so far this period", "$0.00"],
      ["Due this period by today, no import has covered it yet", "$4.99"],
      ["Recurring still expected this period", "$6.00"],
    ]);
  });

  test("says nothing about either when there is nothing to say", () => {
    const lines = budgetDeactivateLines(
      { budgetPhrase: "$130.00 / month", spentCents: 4_200, overdueCents: 0, overdueUnreadCents: 0, expectedTailCents: 0 },
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
    expect(spoken).toContain("Due this period by today, no import has covered it yet: $2,291.21.");
  });

  /*
   * 🔴 "not imported" OF A DAY THAT WAS IMPORTED. The label said it whatever the ledger had read, so where an import
   * had reached the due day the dialog contradicted the row behind it — the same falsehood "End this series" said
   * on the bill's own page (review of a132c57, 2026-10-08). ⛔ The row's split (`arrearsClause`): "not posted" only of
   * read days, "no import has covered it yet" of the rest, both by amount for a mix.
   */
  test("says \"not posted\" only of what the ledger has read", () => {
    const label = (overdueUnreadCents: number) =>
      budgetDeactivateLines({ ...HOUSING, overdueUnreadCents }, formatCents)[2]!.label;
    expect(label(0)).toBe("Due this period by today, not posted");
    expect(label(18_221)).toBe(
      "Due this period by today, $2,109.00 not posted, and no import has covered the other $182.21 yet",
    );
    for (const unread of [0, 18_221, 229_121]) expect(label(unread)).not.toContain("not imported");
  });
});
