import { describe, expect, test } from "vitest";
import { sumCents } from "../../src/lib/money";
import { runSimulation, SIM_ACCOUNTS } from "./simulate";

describe("fixture simulator", () => {
  const sim = runSimulation();

  test("is deterministic", () => {
    const again = runSimulation();
    expect(again.endBalances).toEqual(sim.endBalances);
    expect(again.periods.length).toBe(sim.periods.length);
  });

  test("every cash/credit statement period reconciles exactly by construction", () => {
    for (const p of sim.periods) {
      if (p.accountKey === "robinhood-brokerage") continue;
      const sum = sumCents(p.txns.map((t) => t.amountCents));
      expect(
        p.beginCents + sum,
        `${p.accountKey} ${p.periodStart}..${p.periodEnd}`,
      ).toBe(p.endCents);
    }
  });

  test("brokerage statements carry holdings whose values sum to ending value minus cash", () => {
    const rh = sim.periods.filter((p) => p.accountKey === "robinhood-brokerage");
    expect(rh.length).toBeGreaterThanOrEqual(24);
    for (const p of rh) {
      const holdingsValue = sumCents((p.holdings ?? []).map((h) => h.valueCents));
      expect(holdingsValue + (p.cashCents ?? 0), `${p.periodEnd}`).toBe(p.endCents);
    }
  });

  test("checking never overdrafts and volumes look like a real life (~50 txns/month)", () => {
    expect(sim.minCheckingBalance).toBeGreaterThan(0);
    const total = [...sim.txns.values()].reduce((n, list) => n + list.length, 0);
    const months = 24;
    expect(total / months).toBeGreaterThan(35);
    expect(total / months).toBeLessThan(80);
  });

  test("transfer legs pair exactly across accounts", () => {
    const all = [...sim.txns.values()].flat();
    const outLegs = all.filter((t) => t.rawDescription === "ROBINHOOD ACH TRANSFER");
    const inLegs = all.filter((t) => t.rawDescription === "ACH Deposit");
    expect(outLegs.length).toBe(inLegs.length);
    const payments = all.filter((t) => t.rawDescription === "CHASE CREDIT CRD AUTOPAY");
    const thanks = all.filter((t) => t.rawDescription === "Payment Thank You-Mobile");
    expect(payments.length).toBe(thanks.length);
    expect(payments.length).toBeGreaterThanOrEqual(22);
    for (const p of payments) {
      expect(thanks.some((t) => t.amountCents === -p.amountCents)).toBe(true);
    }
  });

  test("every account produces at least 24 statement periods except cards mid-cycle", () => {
    for (const account of SIM_ACCOUNTS) {
      const count = sim.periods.filter((p) => p.accountKey === account.key).length;
      expect(count, account.key).toBeGreaterThanOrEqual(23);
    }
  });

  test("salary switches from biweekly ACH to weekly cash deposits in May 2026", () => {
    const checking = sim.txns.get("chase-checking")!;
    const ach = checking.filter((t) => t.rawDescription.includes("ACME CORP PAYROLL"));
    const cash = checking.filter((t) => t.rawDescription.includes("ATM CASH DEPOSIT"));
    expect(ach.length).toBeGreaterThan(45);
    expect(cash.length).toBeGreaterThanOrEqual(7);
    expect(ach.every((t) => t.postedOn <= "2026-05-08")).toBe(true);
    expect(cash.every((t) => t.postedOn >= "2026-05-14")).toBe(true);
  });
});
