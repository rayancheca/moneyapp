import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { dashboardData } from "./dashboard";
import { rebuildAccount } from "./derivation";

const TODAY = "2026-07-08";

let dir: string;
let bundle: DbBundle;
let checking: string;

function seedSeries(opts: {
  name: string;
  kind: SeriesKind;
  cadence: Cadence;
  nextExpectedOn: string;
  amountCents: number;
  lastMatchedOn: string;
  intervalDaysAvg: number;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind,
      cadence: opts.cadence,
      intervalDaysAvg: opts.intervalDaysAvg,
      nextExpectedOn: opts.nextExpectedOn,
      nextExpectedAmountCents: opts.amountCents,
      amountCentsAvg: opts.amountCents,
      lastMatchedOn: opts.lastMatchedOn,
      status: "confirmed",
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

function spend(desc: string, postedOn: string, amountCents: number) {
  bundle.db
    .insert(transactions)
    .values({
      accountId: checking,
      postedOn,
      amountCents,
      rawDescription: desc,
      normalizedDescription: desc,
      dedupeHash: `${desc}-${postedOn}`,
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-dashboard-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  checking = createAccount(bundle.db, { institutionId: instId, name: "Chase Checking", type: "checking" });
  addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 500_00 });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dashboardData: static drill targets", () => {
  test("review + investments hrefs are wired even with no data", () => {
    const data = dashboardData(bundle.db, TODAY);
    expect(data.reviewHref).toBe("/transactions?view=review");
    expect(data.pace?.href).toBe("/spending");
  });

  test("investments teaser is null without an investment position", () => {
    expect(dashboardData(bundle.db, TODAY).investments).toBeNull();
  });
});

describe("dashboardData: upcoming bills", () => {
  test("lists occurrences in the next 14 days, date-sorted, with per-series hrefs", () => {
    const rent = seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    const payroll = seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    const netflix = seedSeries({ name: "Netflix", kind: "subscription", cadence: "monthly", nextExpectedOn: "2026-07-20", amountCents: -15_99, lastMatchedOn: "2026-06-20", intervalDaysAvg: 30 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    expect(upcoming.items.map((i) => i.name)).toEqual(["Rent", "Payroll", "Netflix"]);
    expect(upcoming.items.map((i) => i.href)).toEqual([
      `/recurring/${rent}`,
      `/recurring/${payroll}`,
      `/recurring/${netflix}`,
    ]);
    // net = -1500 + 2000 - 15.99
    expect(upcoming.netCents).toBe(-1500_00 + 2000_00 - 15_99);
  });

  test('"before your next paycheck" sums bills due on or before the next income date', () => {
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    seedSeries({ name: "Netflix", kind: "subscription", cadence: "monthly", nextExpectedOn: "2026-07-20", amountCents: -15_99, lastMatchedOn: "2026-06-20", intervalDaysAvg: 30 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    // Rent (07-09) is before the paycheck (07-10); Netflix (07-20) is after → excluded
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-07-10", cents: -1500_00 });
  });

  test("no income series → no before-paycheck line", () => {
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    expect(dashboardData(bundle.db, TODAY).upcoming.beforePaycheck).toBeNull();
  });

  test("recurring TRANSFERS are net-worth-neutral: excluded from items and before-paycheck", () => {
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    // an auto-transfer to savings: a negative leg due BEFORE the paycheck
    seedSeries({ name: "To Savings", kind: "transfer", cadence: "biweekly", nextExpectedOn: "2026-07-09", amountCents: -500_00, lastMatchedOn: "2026-06-25", intervalDaysAvg: 14 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    // the transfer is neither a "bill due" nor counted before the paycheck
    expect(upcoming.items.map((i) => i.name)).not.toContain("To Savings");
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-07-10", cents: 0 });
  });
});

describe("dashboardData: spending pace", () => {
  test("cumulative actual is null after today; the ideal line ends near the projection", () => {
    spend("Groceries", "2026-07-02", -50_00);
    spend("Gas", "2026-07-05", -30_00);
    const { pace } = dashboardData(bundle.db, TODAY);
    expect(pace).not.toBeNull();
    // one point per day of July
    expect(pace!.points).toHaveLength(31);
    // days on/before today carry a cumulative number; later days are null
    const beforeToday = pace!.points.filter((p) => p.actualCents !== null);
    expect(beforeToday.length).toBeGreaterThan(0);
    expect(pace!.points.at(-1)!.actualCents).toBeNull();
    // ideal line is non-decreasing and lands at the projected spend
    const ideals = pace!.points.map((p) => p.idealCents);
    for (let i = 1; i < ideals.length; i++) expect(ideals[i]!).toBeGreaterThanOrEqual(ideals[i - 1]!);
    expect(ideals.at(-1)).toBe(pace!.projectedCents);
    expect(pace!.actualToDateCents).toBe(80_00);
  });

  test("free-to-spend = full-month income minus spend-so-far and upcoming fixed bills", () => {
    spend("Groceries", "2026-07-02", -80_00);
    // one biweekly paycheck stream (07-10, 07-24 within the month) + one fixed bill
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-12", amountCents: -1500_00, lastMatchedOn: "2026-06-12", intervalDaysAvg: 30 });

    const { pace } = dashboardData(bundle.db, TODAY);
    // income: 2 × 2000 remaining; spend so far: 80; upcoming fixed bill: 1500
    // free = 4000 - 80 - 1500 = 2420
    expect(pace!.freeToSpendCents).toBe(2420_00);
  });
});

describe("dashboardData: net worth summary", () => {
  test("reflects the anchored balance as the latest point", () => {
    const { netWorth } = dashboardData(bundle.db, TODAY);
    // the $500 anchor carries forward to the real "today" as the latest point
    expect(netWorth.latestCents).toBe(500_00);
    expect(netWorth.assetsCents).toBe(500_00);
    expect(netWorth.liabilitiesCents).toBe(0);
    expect(netWorth.asOf).not.toBeNull();
    expect(netWorth.series.length).toBeGreaterThan(0);
    expect(netWorth.inTransitCents).toBe(0);
  });

  test("a float covering the latest day is surfaced so the hero can explain the headline", () => {
    // the doc's sparse-coverage case (docs/inflight-dips.md): the receiver's
    // stale curve never restates the arrival, so the bridge reaches today —
    // latestCents includes it while assets/liabilities (stored) do not, and
    // inTransitCents is the number the hero must speak
    const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "SoFi")).get()!.id;
    const receiver = createAccount(bundle.db, { institutionId: instId, name: "SoFi Savings", type: "savings" });
    addManualAnchor(bundle.db, { accountId: receiver, anchoredOn: "2026-06-01", enteredCents: 100_00 });
    const leg = (accountId: string, postedOn: string, amountCents: number) =>
      bundle.db
        .insert(transactions)
        .values({
          accountId,
          postedOn,
          amountCents,
          rawDescription: `LEG-${amountCents}`,
          normalizedDescription: `LEG-${amountCents}`,
          transferGroupId: "float-1",
          dedupeHash: `LEG-${amountCents}-${postedOn}`,
        })
        .run();
    leg(checking, "2026-07-02", -50_00);
    leg(receiver, "2026-07-20", 50_00); // posted past the receiver's coverage
    rebuildAccount(bundle.db, checking, TODAY);
    rebuildAccount(bundle.db, receiver, "2026-06-01"); // stale — never restates

    const { netWorth } = dashboardData(bundle.db, TODAY);
    expect(netWorth.inTransitCents).toBe(50_00);
    const last = netWorth.series.at(-1)!;
    expect(last.inTransitCents).toBe(50_00);
    // bridged headline = stored assets − liabilities + the in-transit money
    expect(netWorth.latestCents).toBe(netWorth.assetsCents - netWorth.liabilitiesCents + 50_00);
  });
});
