import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { addDays, todayIso } from "@/lib/dates";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { upsertHolding, parseQuantityToE8 } from "./holdings";
import { institutionGroups } from "./institution-groups";

const TODAY = todayIso();
const YESTERDAY = addDays(TODAY, -1);

describe("institutionGroups", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-groups-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const institutionId = (name: string): string =>
    bundle.db.select().from(institutions).where(eq(institutions.name, name)).get()!.id;

  test("returns empty for a database with no accounts", () => {
    expect(institutionGroups(bundle.db)).toEqual([]);
  });

  test("groups accounts under their institution with combined total and day change", () => {
    // Arrange: three Robinhood accounts anchored yesterday and today
    const rh = institutionId("Robinhood");
    const brokerage = createAccount(bundle.db, {
      institutionId: rh,
      name: "Robinhood Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    const cash = createAccount(bundle.db, {
      institutionId: rh,
      name: "Robinhood Cash",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: brokerage, anchoredOn: YESTERDAY, enteredCents: 60_000_00 });
    addManualAnchor(bundle.db, { accountId: brokerage, anchoredOn: TODAY, enteredCents: 61_000_00 });
    addManualAnchor(bundle.db, { accountId: cash, anchoredOn: YESTERDAY, enteredCents: 7_000_00 });
    addManualAnchor(bundle.db, { accountId: cash, anchoredOn: TODAY, enteredCents: 6_500_00 });

    // Act
    const groups = institutionGroups(bundle.db);

    // Assert: one group, both accounts, summed total and net day change
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.institutionName).toBe("Robinhood");
    expect(group.accounts.map((a) => a.shortName)).toEqual(["Brokerage", "Cash"]);
    expect(group.totalCents).toBe(67_500_00);
    expect(group.dayChangeCents).toBe(1_000_00 - 500_00); // +$1,000 brokerage, −$500 cash
    expect(group.asOf).toBe(TODAY);
    const spark = group.spark.at(-1)!;
    expect(spark).toEqual({ day: TODAY, cents: 67_500_00 });
  });

  test("per-account day change carries its own sign", () => {
    const rh = institutionId("Robinhood");
    const cash = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Cash", type: "checking" });
    addManualAnchor(bundle.db, { accountId: cash, anchoredOn: YESTERDAY, enteredCents: 7_000_00 });
    addManualAnchor(bundle.db, { accountId: cash, anchoredOn: TODAY, enteredCents: 6_500_00 });

    const [group] = institutionGroups(bundle.db);
    expect(group!.accounts[0]!.dayChangeCents).toBe(-500_00);
  });

  test("combined spark keeps only days where every account is covered", () => {
    // Arrange: one account with two days of history, one that appears only today
    const rh = institutionId("Robinhood");
    const a = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    const b = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Cash", type: "checking" });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: YESTERDAY, enteredCents: 100_00 });
    addManualAnchor(bundle.db, { accountId: b, anchoredOn: TODAY, enteredCents: 50_00 });

    const [group] = institutionGroups(bundle.db);

    // Assert: yesterday (b uncovered) is excluded; a's carried today + b's anchor remain
    expect(group!.spark).toEqual([{ day: TODAY, cents: 150_00 }]);
    expect(group!.dayChangeCents).toBeNull(); // one complete day — change unknowable
  });

  test("liabilities count against the institution total (stored negative)", () => {
    const chase = institutionId("Chase");
    const checking = createAccount(bundle.db, { institutionId: chase, name: "Chase Checking", type: "checking" });
    const card = createAccount(bundle.db, { institutionId: chase, name: "Chase Freedom", type: "credit" });
    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 1_000_00 });
    // credit anchors are entered as positive amount owed, stored negative
    addManualAnchor(bundle.db, { accountId: card, anchoredOn: TODAY, enteredCents: 400_00 });

    const [group] = institutionGroups(bundle.db);
    expect(group!.totalCents).toBe(600_00);
    const cardView = group!.accounts.find((c) => c.shortName === "Freedom")!;
    expect(cardView.isLiability).toBe(true);
    expect(cardView.balanceCents).toBe(-400_00);
  });

  test("holdings summaries: exact quantity for one holding, count + tickers for many", () => {
    const rh = institutionId("Robinhood");
    const crypto = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Crypto", type: "investment", subtype: "crypto" });
    const brokerage = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    upsertHolding(bundle.db, { accountId: crypto, symbol: "ETH", assetType: "crypto", quantityE8: parseQuantityToE8("14.619066") });
    for (const symbol of ["MSFT", "SPY", "AMZN", "AAPL"]) {
      upsertHolding(bundle.db, { accountId: brokerage, symbol, assetType: "stock", quantityE8: parseQuantityToE8("1") });
    }

    const [group] = institutionGroups(bundle.db);
    const bySh = new Map(group!.accounts.map((c) => [c.shortName, c]));
    expect(bySh.get("Crypto")!.holdingsSummary).toBe("14.619066 ETH");
    expect(bySh.get("Brokerage")!.holdingsSummary).toBe("4 positions · AAPL AMZN MSFT…");
    expect(bySh.get("Crypto")!.balanceCents).toBeNull(); // no anchors yet — balance unknown, not invented
  });

  test("account names without the institution prefix stay untouched", () => {
    const sofi = institutionId("SoFi");
    createAccount(bundle.db, { institutionId: sofi, name: "Everyday Checking", type: "checking" });
    const [group] = institutionGroups(bundle.db);
    expect(group!.accounts[0]!.shortName).toBe("Everyday Checking");
  });

  test("archived accounts are excluded from groups", () => {
    const rh = institutionId("Robinhood");
    const cash = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Cash", type: "checking" });
    addManualAnchor(bundle.db, { accountId: cash, anchoredOn: TODAY, enteredCents: 100_00 });
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, cash)).run();
    expect(institutionGroups(bundle.db)).toEqual([]);
  });
});
