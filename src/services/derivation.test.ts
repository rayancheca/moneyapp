import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import {
  deriveDailyRows,
  latestBalances,
  netWorthSeries,
  pickWinners,
  rebuildAccount,
} from "./derivation";
import { addManualAnchor } from "./anchors";
import { createAccount } from "./accounts";

const TODAY = "2026-07-08";

describe("pickWinners", () => {
  test("statement beats manual beats live on the same date", () => {
    const winners = pickWinners([
      { anchoredOn: "2026-06-30", balanceCents: 100, source: "live" },
      { anchoredOn: "2026-06-30", balanceCents: 200, source: "manual" },
      { anchoredOn: "2026-06-30", balanceCents: 300, source: "statement" },
    ]);
    expect(winners).toEqual([{ anchoredOn: "2026-06-30", balanceCents: 300, source: "statement" }]);
  });

  test("sorts winners by date", () => {
    const winners = pickWinners([
      { anchoredOn: "2026-07-01", balanceCents: 2, source: "manual" },
      { anchoredOn: "2026-06-01", balanceCents: 1, source: "manual" },
    ]);
    expect(winners.map((w) => w.anchoredOn)).toEqual(["2026-06-01", "2026-07-01"]);
  });
});

describe("deriveDailyRows — cash accounts", () => {
  const opts = { isInvestment: false, today: TODAY };

  test("no anchors -> no rows (levels are never invented)", () => {
    expect(deriveDailyRows([], new Map([["2026-07-01", -100]]), opts)).toEqual([]);
  });

  test("single manual anchor carries forward to today", () => {
    const rows = deriveDailyRows(
      [{ anchoredOn: "2026-07-05", balanceCents: 50_000, source: "manual" }],
      new Map(),
      opts,
    );
    expect(rows).toEqual([
      { day: "2026-07-05", balanceCents: 50_000, basis: "anchored" },
      { day: "2026-07-06", balanceCents: 50_000, basis: "carried" },
      { day: "2026-07-07", balanceCents: 50_000, basis: "carried" },
      { day: "2026-07-08", balanceCents: 50_000, basis: "carried" },
    ]);
  });

  test("equal anchors with no transactions step-hold as carried", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" },
        { anchoredOn: "2026-07-04", balanceCents: 10_000, source: "manual" },
      ],
      new Map(),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows.map((r) => [r.day, r.basis])).toEqual([
      ["2026-07-01", "anchored"],
      ["2026-07-02", "carried"],
      ["2026-07-03", "carried"],
      ["2026-07-04", "anchored"],
    ]);
  });

  test("unequal anchors with no transactions render an honest gap", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" },
        { anchoredOn: "2026-07-04", balanceCents: 12_000, source: "manual" },
      ],
      new Map(),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows.find((r) => r.day === "2026-07-02")?.basis).toBe("gap");
    expect(rows.find((r) => r.day === "2026-07-04")?.basis).toBe("anchored");
  });

  test("chain closure: replay between anchors verifies to the cent", () => {
    // 100.00 + (-25.50) + 10.00 = 84.50
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "statement" },
        { anchoredOn: "2026-07-04", balanceCents: 8_450, source: "statement" },
      ],
      new Map([
        ["2026-07-02", -2_550],
        ["2026-07-04", 1_000],
      ]),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows).toEqual([
      { day: "2026-07-01", balanceCents: 10_000, basis: "anchored" },
      { day: "2026-07-02", balanceCents: 7_450, basis: "derived" },
      { day: "2026-07-03", balanceCents: 7_450, basis: "derived" },
      { day: "2026-07-04", balanceCents: 8_450, basis: "anchored" },
    ]);
  });

  test("broken chain marks the span gap but keeps replayed values for inspection", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "statement" },
        { anchoredOn: "2026-07-04", balanceCents: 9_999, source: "statement" }, // off by 1c
      ],
      new Map([["2026-07-02", -2_550]]),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows.find((r) => r.day === "2026-07-02")).toEqual({
      day: "2026-07-02",
      balanceCents: 7_450,
      basis: "gap",
    });
  });

  test("backward derivation before the earliest anchor is derived_unverified", () => {
    const rows = deriveDailyRows(
      [{ anchoredOn: "2026-07-05", balanceCents: 10_000, source: "statement" }],
      new Map([
        ["2026-07-03", -500],
        ["2026-07-05", 2_000],
      ]),
      { isInvestment: false, today: "2026-07-05" },
    );
    // balance[07-04] = 10000 - txns[07-05] = 8000; balance[07-03] = 8000; balance[07-02] = 8000+500=8500
    expect(rows).toEqual([
      { day: "2026-07-02", balanceCents: 8_500, basis: "derived_unverified" },
      { day: "2026-07-03", balanceCents: 8_000, basis: "derived_unverified" },
      { day: "2026-07-04", balanceCents: 8_000, basis: "derived_unverified" },
      { day: "2026-07-05", balanceCents: 10_000, basis: "anchored" },
    ]);
  });

  test("forward derivation after the last anchor: carried until a txn appears, then derived_unverified", () => {
    const rows = deriveDailyRows(
      [{ anchoredOn: "2026-07-05", balanceCents: 10_000, source: "statement" }],
      new Map([["2026-07-07", -1_000]]),
      opts,
    );
    expect(rows).toEqual([
      { day: "2026-07-05", balanceCents: 10_000, basis: "anchored" },
      { day: "2026-07-06", balanceCents: 10_000, basis: "carried" },
      { day: "2026-07-07", balanceCents: 9_000, basis: "derived_unverified" },
      { day: "2026-07-08", balanceCents: 9_000, basis: "derived_unverified" },
    ]);
  });

  test("moment anchors are never chain endpoints when chain-grade anchors exist", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "statement" },
        { anchoredOn: "2026-07-02", balanceCents: 55, source: "ofx_ledger" }, // mid-morning moment
        { anchoredOn: "2026-07-03", balanceCents: 10_000, source: "statement" },
      ],
      new Map(),
      { isInvestment: false, today: "2026-07-03" },
    );
    // the ofx_ledger observation must not fracture the carried span
    expect(rows.find((r) => r.day === "2026-07-02")).toEqual({
      day: "2026-07-02",
      balanceCents: 10_000,
      basis: "carried",
    });
  });

  test("a live anchor for today overrides the derived value for display", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-06", balanceCents: 10_000, source: "statement" },
        { anchoredOn: TODAY, balanceCents: 10_500, source: "live" },
      ],
      new Map(),
      opts,
    );
    expect(rows.at(-1)).toEqual({ day: TODAY, balanceCents: 10_500, basis: "anchored" });
  });
});

describe("deriveDailyRows — investment accounts", () => {
  test("step-holds between statement anchors; buys/sells never replay", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-06-30", balanceCents: 8_900_000, source: "statement" },
        { anchoredOn: "2026-07-03", balanceCents: 9_100_000, source: "statement" },
      ],
      new Map([["2026-07-01", 50_000]]), // contribution — must NOT be replayed
      { isInvestment: true, today: "2026-07-05" },
    );
    expect(rows.map((r) => [r.day, r.balanceCents, r.basis])).toEqual([
      ["2026-06-30", 8_900_000, "anchored"],
      ["2026-07-01", 8_900_000, "carried"],
      ["2026-07-02", 8_900_000, "carried"],
      ["2026-07-03", 9_100_000, "anchored"],
      ["2026-07-04", 9_100_000, "carried"],
      ["2026-07-05", 9_100_000, "carried"],
    ]);
  });
});

describe("integration: rebuild + net worth against a real database", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-deriv-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function institutionId(name: string): string {
    const row = bundle.db.select().from(institutions).where(eq(institutions.name, name)).get();
    if (!row) throw new Error(`missing institution ${name}`);
    return row.id;
  }

  test("net worth = assets − liabilities with credit stored negative", () => {
    const checking = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "Chase Checking",
      type: "checking",
    });
    const card = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "Chase Card",
      type: "credit",
    });

    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 500_000 });
    // credit entered as positive amount owed → stored negative
    addManualAnchor(bundle.db, { accountId: card, anchoredOn: TODAY, enteredCents: 120_000 });

    const series = netWorthSeries(bundle.db);
    const today = series.find((p) => p.day === TODAY);
    expect(today?.totalCents).toBe(380_000);
    expect(today?.complete).toBe(true);

    const balances = latestBalances(bundle.db);
    expect(balances.get(card)?.balanceCents).toBe(-120_000);
  });

  test("partial days are annotated when one account lacks coverage", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    const b = createAccount(bundle.db, {
      institutionId: institutionId("SoFi"),
      name: "B",
      type: "savings",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 100_000 });
    addManualAnchor(bundle.db, { accountId: b, anchoredOn: "2026-07-05", enteredCents: 50_000 });

    const series = netWorthSeries(bundle.db);
    const early = series.find((p) => p.day === "2026-07-02");
    const late = series.find((p) => p.day === "2026-07-06");
    expect(early?.complete).toBe(false);
    expect(early?.coveredAccounts).toBe(1);
    expect(early?.totalCents).toBe(100_000);
    expect(late?.complete).toBe(true);
    expect(late?.totalCents).toBe(150_000);
  });

  test("rebuild replays active transactions and ignores quarantined ones", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: a, anchoredOn: "2026-07-01", balanceCents: 100_000, source: "statement" })
      .run();
    const mkTxn = (postedOn: string, amountCents: number, status: "active" | "quarantined") => ({
      accountId: a,
      postedOn,
      amountCents,
      rawDescription: `T-${postedOn}-${status}`,
      normalizedDescription: `T-${postedOn}-${status}`,
      status,
      dedupeHash: dedupeHash({
        accountId: a,
        postedOn,
        amountCents,
        rawDescription: `T-${postedOn}-${status}`,
        occurrenceIndex: 0,
      }),
    });
    bundle.db.insert(transactions).values(mkTxn("2026-07-03", -10_000, "active")).run();
    bundle.db.insert(transactions).values(mkTxn("2026-07-03", -99_999, "quarantined")).run();

    rebuildAccount(bundle.db, a, TODAY);
    const rows = bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, a))
      .all();
    const jul3 = rows.find((r) => r.day === "2026-07-03");
    expect(jul3?.balanceCents).toBe(90_000); // only the active txn replayed
  });

  test("anchor precedence end-to-end: statement supersedes manual on the same date", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 99_000 });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: a, anchoredOn: "2026-07-01", balanceCents: 100_000, source: "statement" })
      .run();
    rebuildAccount(bundle.db, a, TODAY);

    const row = bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, a))
      .all()
      .find((r) => r.day === "2026-07-01");
    expect(row?.balanceCents).toBe(100_000);
  });

  test("accounts.isActive=false leaves the net-worth series", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: TODAY, enteredCents: 100_000 });
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, a)).run();
    expect(netWorthSeries(bundle.db)).toEqual([]);
  });
});
