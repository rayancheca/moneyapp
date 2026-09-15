import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { priceCache } from "@/db/schema/holdings";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { addDays, todayIso } from "@/lib/dates";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { rebuildInvestmentHistory } from "./crypto-history";
import { latestBalances, rebuildAccount } from "./derivation";
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
      /*
       * 🔴 S24: this read a change of $0.00 "today" off a balance carried forward
       * from one recorded five days earlier — a change on a day nothing observed.
       * The balance is dated by the day it was recorded (owner decision S24 a,
       * 2026-09-14), so the card holds ONE covered day and names no interval.
       */
      expect(group!.accounts[0]!.asOf).toBe(addDays(TODAY, -5));
      expect(group!.accounts[0]!.dayChangeCents).toBeNull();
      expect(group!.accounts[0]!.dayChangeAsOf).toBeNull();
      expect(group!.accounts[0]!.dayChangeVsDay).toBeNull();
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

  /*
   * 🔴 "Cash on Hand" under the institution "Cash" rendered as a sub-card headed
   * "on Hand" — a sentence fragment where a name should be, live on the
   * dashboard. The prefix strip is right for "Wells Fargo Everyday Checking";
   * it is wrong whenever the institution's name is the first WORD of a phrase
   * rather than a prefix, and the remainder tells you which: a name starts with
   * a capital (or a digit, as in Capital One's "360 Checking"), a phrase
   * continues in lower case.
   */
  test("an institution name that is the first word of a phrase is not stripped", () => {
    const cash = bundle.db
      .insert(institutions)
      .values({ name: "Cash" })
      .returning({ id: institutions.id })
      .get().id;
    const wallet = createAccount(bundle.db, {
      institutionId: cash,
      name: "Cash on Hand",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: wallet, anchoredOn: TODAY, enteredCents: 180_000 });
    const group = institutionGroups(bundle.db).find((g) => g.institutionName === "Cash");
    expect(group!.accounts[0]!.shortName).toBe("Cash on Hand");
  });

  test("a remainder that opens with a digit is still a name", () => {
    const capitalOne = institutionId("Capital One");
    const checking = createAccount(bundle.db, {
      institutionId: capitalOne,
      name: "Capital One 360 Checking",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 100 });
    const group = institutionGroups(bundle.db).find((g) => g.institutionName === "Capital One");
    expect(group!.accounts[0]!.shortName).toBe("360 Checking");
  });

  test("archived accounts are excluded from groups", () => {
    const rh = institutionId("Robinhood");
    const cash = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Cash", type: "checking" });
    addManualAnchor(bundle.db, { accountId: cash, anchoredOn: TODAY, enteredCents: 100_00 });
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, cash)).run();
    expect(institutionGroups(bundle.db)).toEqual([]);
  });
});

/**
 * 🔴 S24: A CARD WAS DATED BY THE DAY THE CACHE WAS REBUILT, NOT THE DAY ITS
 * BALANCE WAS SEEN.
 *
 * `daily_balances` walks forward to whatever `today` stood at the last rebuild,
 * so `series.at(-1)` names the IMPORT day. Measured 2026-09-14 on /?cards=grid:
 * "Discover · 1 account · as of Sep 14, 2026" beside "Discover adds up through
 * Sep 8, 2026" — Discover's newest charge is Sep 1 and its statement closes Sep
 * 8; nothing was seen on Sep 9–14. Every one of the 9 non-investment accounts
 * with a balance read a cached day later than the last day anything observed
 * it, and on all 9 the balance on that observed day equals the newest one.
 *
 * ⛔ One rule dates it (owner decision S24, 2026-09-14): the latest of the newest
 * transaction, the newest statement end and the newest recorded balance —
 * `observedThrough`. Balances do not move.
 */
describe("the as-of day is the day the balance was observed", () => {
  let dir: string;
  let bundle: DbBundle;
  let seq = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-groups-observed-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    seq = 0;
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const institutionId = (name: string): string =>
    bundle.db.select().from(institutions).where(eq(institutions.name, name)).get()!.id;

  function addTxn(accountId: string, postedOn: string, amountCents: number): void {
    seq += 1;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: `ROW ${seq}`,
        normalizedDescription: `ROW ${seq}`,
        dedupeHash: `observed-${seq}`,
      })
      .run();
  }

  /** A reconciled statement whose closing balance is recorded as a statement anchor on its last day. */
  function addStatement(accountId: string, start: string, end: string, endingCents: number): void {
    seq += 1;
    const now = new Date().toISOString();
    const fileId = `stmt-${seq}`;
    bundle.db
      .insert(importFiles)
      .values({
        id: fileId,
        fileName: `${fileId}.pdf`,
        fileSha256: `sha-${fileId}`,
        format: "pdf",
        institutionId: institutionId("Chase"),
        parserVersion: 1,
        status: "parsed",
        storagePath: `/tmp/${fileId}.pdf`,
        importedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    bundle.db
      .insert(statementPeriods)
      .values({
        importFileId: fileId,
        accountId,
        periodStart: start,
        periodEnd: end,
        endingBalanceCents: endingCents,
        reconciliation: "reconciled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId, anchoredOn: end, balanceCents: endingCents, source: "statement", importFileId: fileId, createdAt: now, updatedAt: now })
      .run();
  }

  const card = (id: string) =>
    institutionGroups(bundle.db, TODAY)
      .flatMap((g) => g.accounts)
      .find((c) => c.id === id)!;

  test("a statement that closed days ago dates the card, not the rebuild — and the balance does not move", () => {
    // Discover's shape: newest charge inside the statement, statement closed six
    // days before the cache was last rebuilt
    const discover = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "Chase Freedom", type: "credit" });
    const CLOSED = addDays(TODAY, -6);
    addTxn(discover, addDays(TODAY, -8), -20_00);
    addStatement(discover, addDays(TODAY, -35), CLOSED, -500_00);
    rebuildAccount(bundle.db, discover, TODAY);
    const newest = latestBalances(bundle.db).get(discover)!;
    expect(newest.asOf).toBe(TODAY); // the condition: a carried tail to the rebuild day

    const c = card(discover);
    expect(c.asOf).toBe(CLOSED);
    expect(c.balanceCents).toBe(newest.balanceCents);
    expect(c.spark.at(-1)!.day).toBe(CLOSED);
    expect(c.dayChangeAsOf).toBe(CLOSED);
    expect(c.dayChangeTerm).not.toBe("today");
  });

  test("a row after the last statement dates the card by that row", () => {
    // Robinhood Cash's shape: one row after the statement, derived_unverified to
    // the rebuild day
    const cash = createAccount(bundle.db, { institutionId: institutionId("Robinhood"), name: "Robinhood Cash", type: "checking" });
    const ROW = addDays(TODAY, -10);
    addStatement(cash, addDays(TODAY, -50), addDays(TODAY, -20), 1_000_00);
    addTxn(cash, ROW, -40_00);
    rebuildAccount(bundle.db, cash, TODAY);

    const c = card(cash);
    expect(c.asOf).toBe(ROW);
    expect(c.balanceCents).toBe(latestBalances(bundle.db).get(cash)!.balanceCents);
  });

  test("a group's combined series and its span read the observed days of every child", () => {
    const chase = institutionId("Chase");
    const checking = createAccount(bundle.db, { institutionId: chase, name: "Chase Checking", type: "checking" });
    const sapphire = createAccount(bundle.db, { institutionId: chase, name: "Chase Sapphire", type: "credit" });
    // early enough that the two children's observed series overlap
    addTxn(checking, addDays(TODAY, -30), -20_00);
    addStatement(checking, addDays(TODAY, -35), addDays(TODAY, -6), 3_000_00);
    addStatement(sapphire, addDays(TODAY, -50), addDays(TODAY, -20), -100_00);
    addTxn(sapphire, addDays(TODAY, -10), -15_00);
    rebuildAccount(bundle.db, checking, TODAY);
    rebuildAccount(bundle.db, sapphire, TODAY);

    const group = institutionGroups(bundle.db, TODAY).find((g) => g.institutionName === "Chase")!;
    expect(group.asOf).toBe(addDays(TODAY, -6));
    expect(group.oldestAsOf).toBe(addDays(TODAY, -10));
    // the combined series ends where EVERY child was observed — not at the rebuild
    expect(group.spark.at(-1)!.day).toBe(addDays(TODAY, -10));
    expect(group.dayChangeAsOf).toBe(addDays(TODAY, -10));
  });

  test("a balance you recorded after the newest row keeps its own day", () => {
    const chase = institutionId("Chase");
    const checking = createAccount(bundle.db, { institutionId: chase, name: "Chase Checking", type: "checking" });
    addTxn(checking, addDays(TODAY, -10), -20_00);
    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: addDays(TODAY, -3), enteredCents: 1_000_00 });
    rebuildAccount(bundle.db, checking, TODAY);

    expect(card(checking).asOf).toBe(addDays(TODAY, -3));
  });

  test("a balance recorded with nothing else to observe dates the card by the day it was recorded", () => {
    const chase = institutionId("Chase");
    const savings = createAccount(bundle.db, { institutionId: chase, name: "Chase Savings", type: "savings" });
    const RECORDED = addDays(TODAY, -5);
    addManualAnchor(bundle.db, { accountId: savings, anchoredOn: RECORDED, enteredCents: 900_00 });
    // the condition: the rebuild carried that balance on to today
    expect(latestBalances(bundle.db).get(savings)!.asOf).toBe(TODAY);

    const c = card(savings);
    expect(c.asOf).toBe(RECORDED);
    expect(c.balanceCents).toBe(900_00);
    expect(c.spark.at(-1)!.day).toBe(RECORDED);
    expect(c.dayChangeTerm).not.toBe("today");
  });

  test("⛔ an investment account keeps its priced tail — observation is not a fact about a marked-to-market balance", () => {
    const rh = institutionId("Robinhood");
    const brokerage = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    addTxn(brokerage, addDays(TODAY, -10), -40_00);
    addManualAnchor(bundle.db, { accountId: brokerage, anchoredOn: YESTERDAY, enteredCents: 60_000_00 });
    addManualAnchor(bundle.db, { accountId: brokerage, anchoredOn: TODAY, enteredCents: 61_000_00 });

    expect(card(brokerage).asOf).toBe(TODAY);
  });
});

/**
 * 🔴 A group total is the sum of each child's OWN last covered day, and `asOf`
 * is the newest of them. On the owner's ledger 2026-09-08 the dashboard's Chase
 * card read "2 accounts · as of 2026-09-03 · $3,090.32" over $3,007.60 last
 * covered Aug 14 and $82.72 last covered Sep 3 — three weeks of evidence dated
 * to one day, which is the claim `AccountsTable.oldestAsOf` exists to refuse.
 */
describe("oldestAsOf — a total built from two days does not get one date", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-groups-asof-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const institutionId = (name: string): string =>
    bundle.db.select().from(institutions).where(eq(institutions.name, name)).get()!.id;

  test("names both ends when the children stop on different days", () => {
    const chase = institutionId("Chase");
    const checking = createAccount(bundle.db, { institutionId: chase, name: "Chase Checking", type: "checking" });
    const card = createAccount(bundle.db, { institutionId: chase, name: "Chase Sapphire", type: "credit" });
    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: YESTERDAY, enteredCents: 3_000_00 });
    // a card anchor is entered as the positive amount owed
    addManualAnchor(bundle.db, { accountId: card, anchoredOn: TODAY, enteredCents: 100_00 });
    /*
     * ⚠️ `daily_balances` is a cache that stops wherever `today` stood at the
     * last rebuild, which is the ONLY way two accounts end on different days —
     * `deriveForward` always walks to the `today` it is given. Rebuilding one
     * child a day short is what the real ledger looks like between imports.
     */
    rebuildAccount(bundle.db, checking, YESTERDAY);

    const group = institutionGroups(bundle.db).find((g) => g.institutionName === "Chase")!;
    expect(group.asOf).toBe(TODAY);
    expect(group.oldestAsOf).toBe(YESTERDAY);
  });

  test("stays null when every child shares one day — a single date is honest there", () => {
    const sofi = institutionId("SoFi");
    const a = createAccount(bundle.db, { institutionId: sofi, name: "SoFi Checking", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: sofi, name: "SoFi Savings", type: "savings" });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: TODAY, enteredCents: 1_00 });
    addManualAnchor(bundle.db, { accountId: b, anchoredOn: TODAY, enteredCents: 10_00 });

    const group = institutionGroups(bundle.db).find((g) => g.institutionName === "SoFi")!;
    expect(group.asOf).toBe(TODAY);
    expect(group.oldestAsOf).toBeNull();
  });

  /**
   * ⚠️ Capital One on the real ledger: 360 Checking has never had a balance and
   * Venture X is as of Aug 17. One account has a date, so the group has one
   * moment — a second, empty account must not manufacture a range.
   */
  test("a child with no balance contributes no date", () => {
    const capOne = institutionId("Capital One");
    const empty = createAccount(bundle.db, { institutionId: capOne, name: "Capital One 360 Checking", type: "checking" });
    const card = createAccount(bundle.db, { institutionId: capOne, name: "Venture X", type: "credit" });
    addManualAnchor(bundle.db, { accountId: card, anchoredOn: TODAY, enteredCents: 50_00 });

    const group = institutionGroups(bundle.db).find((g) => g.institutionName === "Capital One")!;
    expect(group.accounts.find((c) => c.id === empty)!.asOf).toBeNull();
    expect(group.asOf).toBe(TODAY);
    expect(group.oldestAsOf).toBeNull();
  });
});

/**
 * 🔴 AN INVESTMENT CARD READ ITS DAY CHANGE OFF A SERIES CARRIED PAST ITS CLOSES.
 *
 * `rebuildInvestmentHistory` carries an investment account's series to today
 * whatever the newest close, so the card's last two covered days are valued at
 * the same closes. Measured on the real ledger, Tue 2026-09-15 (/accounts and
 * the dashboard, `institutionGroups(db, today)`): "Robinhood Brokerage · $0.00
 * today" and "Robinhood Crypto · $0.00 today" — over holdings that had moved
 * +$1,110.27 and +$794.72 into Monday's closes, printed a click away under a
 * Day column dated "Sep 14 vs Sep 11" and "Sep 14 vs Sep 13".
 *
 * ⚠️ Unreachable in e2e: the fixture quotes every symbol through its fake today,
 * so the move into the newest close IS the series' last pair and says "today".
 */
describe("an investment card is measured into the closes its holdings moved into", () => {
  let dir: string;
  let bundle: DbBundle;
  const [THU, FRI, SAT, SUN, MON, TUE] = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-groups-closes-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function cache(symbol: string, assetType: "stock" | "crypto", day: string, close: number): void {
    bundle.db
      .insert(priceCache)
      .values({ symbol, assetType, quotedOn: day, close, source: assetType === "crypto" ? "coinbase" : "yahoo", fetchedAt: `${day}T20:00:00.000Z` })
      .run();
  }

  test("read the day after Monday's closes, each card says Monday's move — not $0.00 today", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!.id;
    const brokerage = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    const crypto = createAccount(bundle.db, { institutionId: rh, name: "Robinhood Crypto", type: "investment", subtype: "crypto" });
    cache("AAPL", "stock", THU, 100);
    cache("AAPL", "stock", FRI, 110);
    cache("AAPL", "stock", MON, 121);
    for (const [day, close] of [[THU, 2000], [FRI, 2010], [SAT, 2020], [SUN, 2030], [MON, 2100]] as const) {
      cache("ETH", "crypto", day, close);
    }
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 200_000_000, avgCostCents: 10_000, occurredOn: THU });
    upsertHolding(bundle.db, { accountId: crypto, symbol: "ETH", assetType: "crypto", quantityE8: 100_000_000, avgCostCents: 200_000, occurredOn: THU });
    rebuildInvestmentHistory(bundle.db, brokerage, TUE);
    rebuildInvestmentHistory(bundle.db, crypto, TUE);

    const [group] = institutionGroups(bundle.db, TUE);
    const card = (shortName: string) => group!.accounts.find((a) => a.shortName === shortName)!;

    // the shape: the card's own series is carried flat into Tuesday
    expect(card("Brokerage").spark.slice(-2).map((p) => p.cents)).toEqual([24_200, 24_200]);
    expect(card("Brokerage").asOf).toBe(TUE);

    expect(card("Brokerage")).toMatchObject({ dayChangeCents: 2_200, dayChangeAsOf: MON, dayChangeVsDay: SUN, dayChangeTerm: "Sep 14 vs Sep 11" });
    expect(card("Crypto")).toMatchObject({ dayChangeCents: 7_000, dayChangeAsOf: MON, dayChangeVsDay: SUN, dayChangeTerm: "Sep 14 vs Sep 13" });

    /*
     * …and a group made only of such accounts has the same carried tail. Its
     * move is both accounts' into Monday; no one pair of closes is true of the
     * stock and the coin, so it claims none (`closesDayChange`).
     */
    expect(group!.spark.slice(-2).map((p) => p.cents)).toEqual([234_200, 234_200]);
    expect(group).toMatchObject({ dayChangeCents: 9_200, dayChangeAsOf: MON, dayChangeVsDay: SUN, dayChangeTerm: "day change" });
  });
});
