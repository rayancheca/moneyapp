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
import { rebuildAccount } from "./derivation";
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
    // …and with no change measured there is no pair of days to name: reporting
    // the single day would invite a caller to date a figure that does not exist
    expect(group!.dayChangeAsOf).toBeNull();
    expect(group!.dayChangeVsDay).toBeNull();
  });

  /*
   * ⛔ The figure and the WORD for it must come from the same pair of days.
   *
   * 🔴 `InstitutionCard` printed a hard-coded "today" beside every day change.
   * Measured on the real ledger at today = 2026-09-01: the Chase group read
   * "-$50.00 today" from a move between 2026-08-04 and 2026-08-05 while both of
   * its children read "$0.00 today", and the Robinhood group read "+$585.31
   * today" from 2026-08-27 → 2026-08-28 while the investments teaser three
   * cards above it read "-$447.83 today" for the same portfolio.
   *
   * ⚠️ The group's day cannot be read off `asOf`. `asOf` is the NEWEST of the
   * children's covered days; the change is measured on the COMBINED series,
   * which ends at the newest day every child covers — the oldest of them. Two
   * different dates, and only one of them is the change's own.
   *
   * ⚠️ Unreachable in e2e by construction: every account in the e2e fixture is
   * covered through `E2E_FAKE_TODAY`, so `asOf === today` everywhere and the
   * only branch that was ever wrong cannot render. `day-change-label.ts` says
   * the same thing about the portfolio surface it was extracted for.
   */
  describe("the day change names its own two days", () => {
    test("an account covered through today says 'today'", () => {
      const rh = institutionId("Robinhood");
      const cash = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Cash", type: "checking" });
      addManualAnchor(bundle.db, { accountId: cash, anchoredOn: YESTERDAY, enteredCents: 7_000_00 });
      addManualAnchor(bundle.db, { accountId: cash, anchoredOn: TODAY, enteredCents: 6_500_00 });

      const [group] = institutionGroups(bundle.db, TODAY);
      expect(group!.accounts[0]!.dayChangeAsOf).toBe(TODAY);
      expect(group!.accounts[0]!.dayChangeVsDay).toBe(YESTERDAY);
      expect(group!.accounts[0]!.dayChangeTerm).toBe("today");
      expect(group!.dayChangeTerm).toBe("today");
    });

    test("a group whose combined series stops short names the two days it measured", () => {
      // Arrange: two Chase accounts, one anchored only up to three days ago, so
      // the combined series ends there even though the other reaches today.
      const chase = institutionId("Chase");
      const checking = createAccount(bundle.db, { institutionId: chase, name: "Chase Checking", type: "checking" });
      const card = createAccount(bundle.db, { institutionId: chase, name: "Chase Freedom", type: "credit" });
      const STALE = addDays(TODAY, -3);
      const BEFORE_STALE = addDays(TODAY, -4);
      addManualAnchor(bundle.db, { accountId: checking, anchoredOn: BEFORE_STALE, enteredCents: 1_000_00 });
      addManualAnchor(bundle.db, { accountId: checking, anchoredOn: STALE, enteredCents: 1_050_00 });
      addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 1_100_00 });
      addManualAnchor(bundle.db, { accountId: card, anchoredOn: BEFORE_STALE, enteredCents: 400_00 });
      addManualAnchor(bundle.db, { accountId: card, anchoredOn: STALE, enteredCents: 450_00 });
      /*
       * ⛔ This is what makes the condition EXPRESSIBLE at all, and it is the
       * fixture gap that hid the bug. `daily_balances` is a cached derivation
       * that walks forward to whatever `today` was at the last rebuild, and
       * every helper in this file rebuilds through the real one — so a fixture
       * account's series always ended at today and no group could ever be
       * stale. On the owner's ledger the caches are months apart: Chase
       * Sapphire ends 2026-08-05 and Chase Checking 2026-08-14, because that is
       * when each was last rebuilt.
       */
      rebuildAccount(bundle.db, card, STALE);

      const [group] = institutionGroups(bundle.db, TODAY);

      // the group is as-of today (its newest child) but its CHANGE is not
      expect(group!.asOf).toBe(TODAY);
      expect(group!.dayChangeAsOf).toBe(STALE);
      expect(group!.dayChangeVsDay).toBe(BEFORE_STALE);
      expect(group!.dayChangeTerm).not.toBe("today");
      expect(group!.dayChangeTerm).toContain("vs");

      // …the stale CHILD names its own two days rather than borrowing today…
      const freedomCard = group!.accounts.find((a) => a.shortName === "Freedom")!;
      expect(freedomCard.dayChangeAsOf).toBe(STALE);
      expect(freedomCard.dayChangeVsDay).toBe(BEFORE_STALE);
      expect(freedomCard.dayChangeTerm).not.toBe("today");
      expect(freedomCard.dayChangeTerm).toContain("vs");

      // …while the child that DOES reach today still says today. Both children
      // sit in one group, so a single rule cannot be right for both by accident.
      const checkingCard = group!.accounts.find((a) => a.shortName === "Checking")!;
      expect(checkingCard.dayChangeAsOf).toBe(TODAY);
      expect(checkingCard.dayChangeTerm).toBe("today");
    });

    test("one covered day names no interval at all rather than a wrong one", () => {
      const rh = institutionId("Robinhood");
      const only = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Cash", type: "checking" });
      addManualAnchor(bundle.db, { accountId: only, anchoredOn: addDays(TODAY, -5), enteredCents: 100_00 });

      const [group] = institutionGroups(bundle.db, TODAY);
      // the balance carries forward to today, so there IS a change to report
      expect(group!.accounts[0]!.dayChangeCents).toBe(0);
      expect(group!.accounts[0]!.dayChangeAsOf).toBe(TODAY);
      expect(group!.accounts[0]!.dayChangeVsDay).toBe(addDays(TODAY, -1));
    });
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
