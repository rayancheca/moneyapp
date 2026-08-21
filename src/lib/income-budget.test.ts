import { describe, expect, test } from "vitest";
import {
  incomeBudgetPlan,
  monthlyFromWeekly,
  type IncomeBudgetInput,
} from "./income-budget";

const plan = (over: Partial<IncomeBudgetInput> = {}) =>
  incomeBudgetPlan({
    incomeBaseCents: 453_700,
    categories: [
      { id: "housing", name: "Housing", committedCents: 228_570, trailingCents: 292_995 },
      { id: "food", name: "Food", committedCents: 0, trailingCents: 185_274 },
      { id: "transport", name: "Transport", committedCents: 0, trailingCents: 62_289 },
    ],
    ...over,
  });

describe("monthlyFromWeekly", () => {
  test("annualises rather than multiplying by four", () => {
    // 52 weeks / 12 months, not 4 — four weekly paydays a month loses four
    // paydays a year, which on this ledger is $4,188.00 of real earnings.
    expect(monthlyFromWeekly(104_700)).toBe(453_700);
  });

  test("rounds to whole cents", () => {
    expect(Number.isInteger(monthlyFromWeekly(100_000))).toBe(true);
  });
});

describe("incomeBudgetPlan — the size comes from income", () => {
  test("commitments are funded exactly and never scaled", () => {
    // A budget below what is contractually owed is not a budget, it is a
    // guaranteed overrun. Rent gets its $2,285.70 whatever is left over.
    const p = plan();
    const housing = p.rows.find((r) => r.id === "housing")!;
    expect(housing.committedCents).toBe(228_570);
    expect(housing.budgetCents).toBeGreaterThanOrEqual(228_570);
  });

  test("the discretionary pool is what income leaves after commitments", () => {
    const p = plan();
    expect(p.committedCents).toBe(228_570);
    expect(p.discretionaryPoolCents).toBe(453_700 - 228_570);
  });

  test("the plan never allocates more than the income base", () => {
    // The whole point. Trailing spend across these three is $5,405.58 against
    // $4,537.00 of income, and the result has to fit.
    const p = plan();
    expect(p.allocatedCents).toBeLessThanOrEqual(453_700);
    expect(p.unallocatedCents).toBeGreaterThanOrEqual(0);
  });

  test("rows sum to the allocated total", () => {
    const p = plan();
    const summed = p.rows.reduce((s, r) => s + r.budgetCents, 0);
    expect(summed).toBe(p.allocatedCents);
  });
});

describe("incomeBudgetPlan — the shape comes from trailing spend", () => {
  test("a category that spends twice as much gets twice the discretionary share", () => {
    const p = plan({
      incomeBaseCents: 300_000,
      categories: [
        { id: "a", name: "A", committedCents: 0, trailingCents: 200_000 },
        { id: "b", name: "B", committedCents: 0, trailingCents: 100_000 },
      ],
    });
    const a = p.rows.find((r) => r.id === "a")!;
    const b = p.rows.find((r) => r.id === "b")!;
    expect(a.budgetCents).toBe(2 * b.budgetCents);
  });

  test("only the UNCOMMITTED part of trailing spend competes for the pool", () => {
    // Housing already gets its rent funded; it must not also claim a share of
    // the pool for that same rent, or it is paid for twice.
    const p = plan({
      incomeBaseCents: 300_000,
      categories: [
        { id: "rent", name: "Rent", committedCents: 100_000, trailingCents: 110_000 },
        { id: "food", name: "Food", committedCents: 0, trailingCents: 10_000 },
      ],
    });
    const rent = p.rows.find((r) => r.id === "rent")!;
    const food = p.rows.find((r) => r.id === "food")!;
    // both have $100.00 of uncommitted need, so they split the pool evenly
    expect(rent.discretionaryCents).toBe(food.discretionaryCents);
  });

  test("a category spending less than its commitment claims nothing extra", () => {
    const p = plan({
      incomeBaseCents: 300_000,
      categories: [
        { id: "rent", name: "Rent", committedCents: 100_000, trailingCents: 90_000 },
        { id: "food", name: "Food", committedCents: 0, trailingCents: 50_000 },
      ],
    });
    expect(p.rows.find((r) => r.id === "rent")!.discretionaryCents).toBe(0);
  });
});

describe("incomeBudgetPlan — the honest edges", () => {
  test("commitments alone exceeding income is FLAGGED, not silently balanced", () => {
    // The one case a budgeting tool must not paper over. Rent cannot be cut to
    // fit, so the plan reports that it does not balance.
    const p = plan({
      incomeBaseCents: 200_000,
      categories: [{ id: "rent", name: "Rent", committedCents: 228_570, trailingCents: 228_570 }],
    });
    expect(p.overCommitted).toBe(true);
    expect(p.discretionaryPoolCents).toBe(0);
    expect(p.rows[0]!.budgetCents).toBe(228_570);
    expect(p.unallocatedCents).toBe(200_000 - 228_570);
  });

  test("nothing to allocate to leaves the pool unspent rather than dividing by zero", () => {
    const p = plan({
      incomeBaseCents: 300_000,
      categories: [{ id: "rent", name: "Rent", committedCents: 100_000, trailingCents: 100_000 }],
    });
    expect(p.rows[0]!.budgetCents).toBe(100_000);
    expect(p.unallocatedCents).toBe(200_000);
  });

  test("no categories at all is an empty plan, not a crash", () => {
    const p = plan({ categories: [] });
    expect(p.rows).toEqual([]);
    expect(p.allocatedCents).toBe(0);
    expect(p.unallocatedCents).toBe(453_700);
  });

  test("rounding goes DOWN so the plan cannot outgrow the income it came from", () => {
    // propose-budgets rounds UP to $5 so a commitment floor is never rounded
    // away. Here the constraint is the opposite direction: rounding each of
    // eleven rows up would quietly hand out more than a month earns.
    const p = plan({
      incomeBaseCents: 100_000,
      roundToCents: 500,
      categories: [
        { id: "a", name: "A", committedCents: 0, trailingCents: 100 },
        { id: "b", name: "B", committedCents: 0, trailingCents: 100 },
        { id: "c", name: "C", committedCents: 0, trailingCents: 100 },
      ],
    });
    for (const r of p.rows) expect(r.budgetCents % 500).toBe(0);
    expect(p.allocatedCents).toBeLessThanOrEqual(100_000);
  });

  test("a commitment is never rounded — a contract is an exact number", () => {
    const p = plan({
      incomeBaseCents: 500_000,
      roundToCents: 500,
      categories: [{ id: "rent", name: "Rent", committedCents: 228_570, trailingCents: 228_570 }],
    });
    // $2,285.70 is not a multiple of $5 and must survive intact
    expect(p.rows[0]!.budgetCents).toBe(228_570);
  });

  test("every row states the cut against what it actually spends", () => {
    // The number the owner will care about most, so it is computed here rather
    // than by whichever surface happens to render the plan.
    const p = plan();
    const food = p.rows.find((r) => r.id === "food")!;
    expect(food.deltaVsTrailingCents).toBe(food.budgetCents - 185_274);
    expect(food.deltaVsTrailingCents).toBeLessThan(0);
  });

  test("row order is stable and independent of input order", () => {
    const forward = plan().rows.map((r) => r.id);
    const backward = incomeBudgetPlan({
      incomeBaseCents: 453_700,
      categories: [
        { id: "transport", name: "Transport", committedCents: 0, trailingCents: 62_289 },
        { id: "food", name: "Food", committedCents: 0, trailingCents: 185_274 },
        { id: "housing", name: "Housing", committedCents: 228_570, trailingCents: 292_995 },
      ],
    }).rows.map((r) => r.id);
    expect(backward).toEqual(forward);
  });
});

describe("incomeBudgetPlan — the seams", () => {
  test("rounding can be switched off to the exact cent", () => {
    // The $5 step is a readability choice, not a correctness one. A caller that
    // wants the arithmetic undisturbed — a test, or a surface showing exact
    // shares — passes 0 and gets every cent of the pool distributed.
    const p = incomeBudgetPlan({
      incomeBaseCents: 100_000,
      roundToCents: 0,
      categories: [
        { id: "a", name: "A", committedCents: 0, trailingCents: 200 },
        { id: "b", name: "B", committedCents: 0, trailingCents: 100 },
      ],
    });
    expect(p.rows.find((r) => r.id === "a")!.budgetCents).toBe(66_666);
    expect(p.rows.find((r) => r.id === "b")!.budgetCents).toBe(33_333);
  });

  test("equal budgets fall back to name, then to id, so the order is total", () => {
    // Two categories allocated the same amount is the common case once rounding
    // collapses small shares onto the same $5 step — four of the eleven real
    // budgets land on $20.00 or below. Without a tie-break the row order comes
    // from the sort's stability, which is not a promise worth relying on.
    const p = incomeBudgetPlan({
      incomeBaseCents: 100_000,
      categories: [
        { id: "z", name: "Same", committedCents: 10_000, trailingCents: 10_000 },
        { id: "a", name: "Same", committedCents: 10_000, trailingCents: 10_000 },
        { id: "m", name: "Alpha", committedCents: 10_000, trailingCents: 10_000 },
      ],
    });
    expect(p.rows.map((r) => `${r.name}/${r.id}`)).toEqual(["Alpha/m", "Same/a", "Same/z"]);
  });
});
