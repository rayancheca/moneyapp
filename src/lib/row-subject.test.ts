import { describe, expect, test } from "vitest";
import { transactionSubjects } from "./row-subject";

/**
 * 🔴 A CONTROL ON A REPEATED ROW HAS TO SAY WHICH ROW. Measured 2026-09-14:
 * `/recurring/<Fordham Payroll>` rendered 56 "Actions for DIRECT DEPOSIT FORDHAM
 * UNIVERSI PAYROLL" menus — one of whose items DETACHES the row — and the ledger
 * named 4,804 of its 10,279 checkboxes "Select <description>" with a sibling of
 * the same name on the same page. A recurring series repeats its description by
 * construction, so the description alone is the one field that cannot tell two
 * rows apart. The rule is `/imports`' (import-file-label): qualify ONLY where the
 * name repeats, and fall through to a finer qualifier until it no longer does.
 */
describe("transactionSubjects", () => {
  test("a description unique in the list stays bare", () => {
    const s = transactionSubjects([
      { id: "a", description: "NETFLIX.COM", amountCents: -1549, postedOn: "2026-07-15" },
      { id: "b", description: "SPOTIFY USA", amountCents: -1199, postedOn: "2026-07-15" },
    ]);
    expect(s.get("a")).toBe("NETFLIX.COM");
    expect(s.get("b")).toBe("SPOTIFY USA");
  });

  test("the Fordham pair — one description, one day, two amounts — gets two subjects, spelled", () => {
    const d = "DIRECT DEPOSIT FORDHAM UNIVERSI PAYROLL";
    const s = transactionSubjects([
      { id: "a", description: d, amountCents: 80_037, postedOn: "2025-07-09" },
      { id: "b", description: d, amountCents: 8_717, postedOn: "2025-07-09" },
      { id: "c", description: d, amountCents: 61_513, postedOn: "2026-05-13" },
    ]);
    expect(new Set(s.values()).size).toBe(3); // the description alone gives 1, the day alone gives 2
    expect(s.get("a")).toContain("+$800.37");
    expect(s.get("a")).toContain("Jul 9, 2025");
    expect(s.get("a")).not.toContain("2025-07-09"); // an accessible name is prose
  });

  test("the account separates two rows equal in description, day and amount", () => {
    const s = transactionSubjects([
      { id: "a", description: "ZELLE PAYMENT", amountCents: -5_000, postedOn: "2026-08-01", accountName: "Chase Checking" },
      { id: "b", description: "ZELLE PAYMENT", amountCents: -5_000, postedOn: "2026-08-01", accountName: "Wells Fargo" },
    ]);
    expect(s.get("a")).toContain("Chase Checking");
    expect(s.get("b")).toContain("Wells Fargo");
    expect(s.get("a")).not.toContain(" of ");
  });

  test("rows identical in every visible field are numbered in list order — and only they are", () => {
    const d = "CPI*CANTEEN VENDING MIAMI 800-628-8363";
    const s = transactionSubjects([
      { id: "x", description: d, amountCents: -175, postedOn: "2026-09-12", accountName: "Venture X" },
      { id: "y", description: d, amountCents: -175, postedOn: "2026-09-12", accountName: "Venture X" },
      { id: "z", description: d, amountCents: -300, postedOn: "2026-09-12", accountName: "Venture X" },
    ]);
    expect(s.get("x")).toMatch(/\(1 of 2\)$/);
    expect(s.get("y")).toMatch(/\(2 of 2\)$/);
    expect(s.get("z")).not.toMatch(/ of \d+\)$/);
    expect(new Set(s.values()).size).toBe(3);
  });

  test("a zero amount carries no sign", () => {
    const s = transactionSubjects([
      { id: "a", description: "ADJUSTMENT", amountCents: 0, postedOn: "2026-01-02" },
      { id: "b", description: "ADJUSTMENT", amountCents: 100, postedOn: "2026-01-02" },
    ]);
    expect(s.get("a")).toContain("$0.00");
    expect(s.get("a")).not.toMatch(/[+-]\$0\.00/);
  });

  test("the input is not mutated", () => {
    const rows = Object.freeze([
      Object.freeze({ id: "a", description: "X", amountCents: -1, postedOn: "2026-01-01" }),
      Object.freeze({ id: "b", description: "X", amountCents: -1, postedOn: "2026-01-01" }),
    ]);
    expect(() => transactionSubjects(rows)).not.toThrow();
  });
});
