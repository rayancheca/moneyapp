import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors, dailyBalances, type AnchorSource, type BalanceBasis } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { MAX_FINANCIAL_DATE, MIN_FINANCIAL_DATE } from "@/lib/date-window";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import {
  addManualAnchor,
  anchorRemovalEffects,
  deleteAnchor,
  listAnchors,
  manualAnchorInputSchema,
} from "./anchors";
import { basisIsChecked } from "./coverage";
import { rebuildAccount } from "./derivation";

/**
 * Schema-level tests only: parse runs before any database work, so a rejected
 * date can never reach rebuildAccount's insert loop. The DB behaviour of
 * addManualAnchor is covered by derivation.test.ts's integration suite.
 */
describe("manualAnchorInputSchema — anchoredOn bounds", () => {
  const base = { accountId: "acct_1", enteredCents: 10_000 };

  test("accepts a real date and both window bounds", () => {
    for (const anchoredOn of ["2026-07-08", MIN_FINANCIAL_DATE, MAX_FINANCIAL_DATE]) {
      expect(manualAnchorInputSchema.safeParse({ ...base, anchoredOn }).success).toBe(true);
    }
  });

  test("rejects a fat-fingered year, naming the field", () => {
    for (const anchoredOn of ["1026-07-08", "9999-12-31", "1969-12-31", "2100-01-01"]) {
      const result = manualAnchorInputSchema.safeParse({ ...base, anchoredOn });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message).join(" ")).toMatch(
        /anchoredOn must be between/,
      );
    }
  });

  test("a malformed date still reports the shape problem", () => {
    const result = manualAnchorInputSchema.safeParse({ ...base, anchoredOn: "20260-01-01" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain("Invalid date");
  });

  test("rejects rather than clamping — no valid date is invented", () => {
    const result = manualAnchorInputSchema.safeParse({ ...base, anchoredOn: "9999-12-31" });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});

describe("pre-mutation snapshots", () => {
  let dir: string;
  let bundle: DbBundle;
  let accountId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-anchors-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Chase"))
      .get()!;
    accountId = createAccount(bundle.db, {
      institutionId: chase.id,
      name: "Checking",
      type: "checking",
    });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The archive lives beside the database it protects. */
  const snapshots = (): string[] => {
    const backups = path.join(dir, "backups");
    if (!fs.existsSync(backups)) return [];
    // .db only — reading a snapshot back leaves -wal/-shm siblings behind
    return fs.readdirSync(backups).filter((f) => f.startsWith("pre-") && f.endsWith(".db"));
  };

  test("a first anchor for the day loses nothing, so it takes no snapshot", () => {
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    expect(snapshots()).toEqual([]);
  });

  test("overwriting a day's anchor snapshots the figure it replaces", () => {
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 25_000 });

    const name = snapshots()[0]!;
    expect(name).toMatch(/-overwrite-anchor\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    expect(listAnchors(before.db, accountId).map((a) => a.balanceCents)).toEqual([10_000]);
    before.sqlite.close();
    expect(listAnchors(bundle.db, accountId).map((a) => a.balanceCents)).toEqual([25_000]);
  });

  test("re-saving the identical figure loses nothing, so it takes no snapshot", () => {
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    expect(snapshots()).toEqual([]);
  });

  test("deleting a hand-entered balance snapshots it first", () => {
    const anchorId = addManualAnchor(bundle.db, {
      accountId,
      anchoredOn: "2026-07-01",
      enteredCents: 10_000,
    });
    deleteAnchor(bundle.db, anchorId);

    const name = snapshots()[0]!;
    expect(name).toMatch(/-delete-anchor\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    expect(listAnchors(before.db, accountId)).toHaveLength(1);
    before.sqlite.close();
    expect(listAnchors(bundle.db, accountId)).toHaveLength(0);
  });

  test("a statement-derived anchor is refused before any snapshot is taken", () => {
    const anchorId = addManualAnchor(bundle.db, {
      accountId,
      anchoredOn: "2026-07-01",
      enteredCents: 10_000,
    });
    bundle.sqlite.prepare("UPDATE balance_anchors SET source = 'statement' WHERE id = ?").run(anchorId);

    expect(() => deleteAnchor(bundle.db, anchorId)).toThrow(/un-importing/);
    expect(snapshots()).toEqual([]);
  });
});

/**
 * THE PREDICTION IS THE EFFECT. The remove-balance dialog quotes
 * `anchorRemovalEffects` before the owner confirms, and `deleteAnchor` is what
 * then happens — so these run both against one database and hold the dialog's
 * numbers to what `daily_balances` actually lost.
 */
describe("anchorRemovalEffects — the dialog's prediction equals what deleteAnchor does", () => {
  const TODAY = "2026-08-02";
  let dir: string;
  let bundle: DbBundle;
  let chaseId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-anchor-removal-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    chaseId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const account = (name: string, type: "checking" | "investment") =>
    createAccount(bundle.db, { institutionId: chaseId, name, type });

  /** Written straight to the table — importers and live sync do not come through addManualAnchor. */
  const anchor = (accountId: string, anchoredOn: string, balanceCents: number, source: AnchorSource) =>
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId, anchoredOn, balanceCents, source })
      .returning({ id: balanceAnchors.id })
      .get().id;

  const txn = (accountId: string, postedOn: string, amountCents: number) => {
    const rawDescription = `T-${postedOn}-${amountCents}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription,
        normalizedDescription: rawDescription,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
      })
      .run();
  };

  const stored = (accountId: string) =>
    bundle.db
      .select({ day: dailyBalances.day, balanceCents: dailyBalances.balanceCents, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, accountId))
      .orderBy(asc(dailyBalances.day))
      .all();

  type StoredRow = { day: string; balanceCents: number; basis: BalanceBasis };

  /** What the removal really did to the stored curve, counted the way the dialog words it. */
  function measured(before: readonly StoredRow[], after: readonly StoredRow[]) {
    const afterByDay = new Map(after.map((r) => [r.day, r]));
    const beforeDays = new Set(before.map((r) => r.day));
    const checkedAfter = (day: string) => {
      const row = afterByDay.get(day);
      return row !== undefined && basisIsChecked(row.basis);
    };
    const lostDays = before.filter((b) => basisIsChecked(b.basis) && !checkedAfter(b.day)).length;
    const changedDays =
      before.filter((b) => {
        const a = afterByDay.get(b.day);
        return !a || a.balanceCents !== b.balanceCents || basisIsChecked(a.basis) !== basisIsChecked(b.basis);
      }).length + after.filter((a) => !beforeDays.has(a.day)).length;
    return { lostDays, changedDays, daysLeft: after.length };
  }

  /**
   * Predict at `today` over whatever the cache holds — last rebuilt on
   * `rebuiltOn` — then really delete, rebuild at the same `today`, and read both
   * curves. ⛔ `rebuiltOn` defaults to `today`, and that default is the one
   * condition under which a prediction that ignores the cache looks right.
   */
  function predictThenRemove(accountId: string, anchorId: string, today: string, rebuiltOn = today) {
    rebuildAccount(bundle.db, accountId, rebuiltOn);
    const before = stored(accountId);
    const prediction = anchorRemovalEffects(bundle.db, accountId, today).get(anchorId);
    deleteAnchor(bundle.db, anchorId); // rebuilds at the wall-clock today…
    rebuildAccount(bundle.db, accountId, today); // …so line the dates back up
    return { prediction, before, after: stored(accountId) };
  }

  /** A $7,235.65 live reading between two statements the transactions close — Robinhood Cash's shape. */
  function robinhoodCash() {
    const cash = account("Robinhood Cash", "checking");
    anchor(cash, "2026-06-30", 19_229, "statement");
    anchor(cash, "2026-07-31", 168_038, "statement");
    txn(cash, "2026-07-05", 700_000);
    txn(cash, "2026-07-20", -551_191);
    return { cash, live: anchor(cash, "2026-07-10", 723_565, "live") };
  }

  test("a past-dated live reading between two closing statements: nothing lost, and not one row moves", () => {
    const { cash, live } = robinhoodCash();

    const { prediction, before, after } = predictThenRemove(cash, live, TODAY);

    expect(prediction).toEqual({
      pricedFromHoldings: false,
      isInvestment: false,
      catchUpDays: 0,
      lostDays: 0,
      lostRuns: [],
      lostTo: { unverified: 0, gap: 0, gone: 0 },
      lostCountedDays: 0,
      rebasedDays: 0,
      daysLeft: before.length,
      changedDays: 0,
      curveUnchanged: true,
    });
    expect(measured(before, after)).toEqual({ lostDays: 0, changedDays: 0, daysLeft: before.length });
    expect(after).toEqual(before);
  });

  /**
   * 🔴 The dialog promised "Removing it leaves the curve exactly as it is" over
   * Robinhood Cash on 2026-09-14, whose stored curve ended 2026-08-28: confirming
   * added 17 days. The balance changes nothing; the rebuild it triggers does.
   */
  test("a STALE cache: the balance changes nothing, and confirming changes exactly the catch-up it names", () => {
    const { cash, live } = robinhoodCash();

    const { prediction, before, after } = predictThenRemove(cash, live, "2026-08-20", TODAY);

    expect(before.at(-1)?.day).toBe(TODAY); // the condition: the cache stops 18 days short
    expect(prediction).toMatchObject({ pricedFromHoldings: false, lostDays: 0, curveUnchanged: true, catchUpDays: 18 });
    // Aug 3 – 20, and nothing else, is what the owner sees change
    expect(measured(before, after)).toEqual({ lostDays: 0, changedDays: 18, daysLeft: after.length });
    expect(after.slice(0, before.length)).toEqual(before);
  });

  /**
   * 🔴 Cash on Hand holds ONE balance, and its dialog read "Removing it leaves
   * those days to be derived from transactions alone" over a removal that leaves
   * no row at all. Every cash wallet starts with exactly one.
   */
  test("the account's ONLY balance: every stored row goes, and the prediction says none is left", () => {
    const wallet = account("Cash on Hand", "checking");
    const opening = anchor(wallet, "2026-08-03", 500_000, "manual");
    txn(wallet, "2026-08-11", -500_000);

    const { prediction, before, after } = predictThenRemove(wallet, opening, "2026-08-14");

    expect(before).toHaveLength(12);
    expect(after).toEqual([]);
    expect(prediction).toEqual({
      pricedFromHoldings: false,
      isInvestment: false,
      catchUpDays: 0,
      ...measured(before, after),
      lostRuns: [{ from: "2026-08-03", to: "2026-08-10" }],
      // the eight days lose their balance outright; nothing is left to derive them from
      lostTo: { unverified: 0, gap: 0, gone: 8 },
      // …and every one stood on his count alone, never on a check
      lostCountedDays: 8,
      rebasedDays: 0,
      curveUnchanged: false,
    });
  });

  test("a manual balance whose removal re-grades the days BEFORE it: the dialog's count is the rebuild's", () => {
    const acct = account("Checking", "checking");
    anchor(acct, "2026-07-01", 10_000, "statement");
    txn(acct, "2026-07-05", -2_000);
    const manual = anchor(acct, "2026-07-10", 8_000, "manual");

    const { prediction, before, after } = predictThenRemove(acct, manual, "2026-07-12");
    const effect = measured(before, after);

    expect(effect.lostDays).toBe(8);
    expect(prediction).toEqual({
      pricedFromHoldings: false,
      isInvestment: false,
      catchUpDays: 0,
      ...effect,
      lostRuns: [{ from: "2026-07-05", to: "2026-07-12" }],
      // a walk forward from Jul 1 still reaches every one of them, unchecked
      lostTo: { unverified: 8, gap: 0, gone: 0 },
      // the statement's replay lands on his balance, so these were verified
      lostCountedDays: 0,
      rebasedDays: 0,
      curveUnchanged: false,
    });
    expect(after.filter((r) => r.basis === "derived_unverified")).toHaveLength(8);
  });

  test("the page's one call answers for every removable balance and for no other", () => {
    const acct = account("Checking", "checking");
    const statement = anchor(acct, "2026-07-01", 10_000, "statement");
    const ofx = anchor(acct, "2026-07-03", 10_000, "ofx_ledger");
    const manual = anchor(acct, "2026-07-10", 10_000, "manual");
    const live = anchor(acct, "2026-07-11", 10_000, "live");

    const effects = anchorRemovalEffects(bundle.db, acct, "2026-07-12");

    expect([...effects.keys()].sort()).toEqual([manual, live].sort());
    expect(effects.has(statement)).toBe(false);
    expect(effects.has(ofx)).toBe(false);
    expect(effects.has("no-such-anchor")).toBe(false);
  });

  test("an investment account WITH holding events is priced from holdings, whatever its balances say", () => {
    const brokerage = account("Brokerage", "investment");
    bundle.db
      .insert(holdingEvents)
      .values({
        accountId: brokerage,
        symbol: "AAPL",
        assetType: "stock",
        occurredOn: "2026-07-01",
        quantityDeltaE8: 100_000_000,
      })
      .run();
    const manual = anchor(brokerage, "2026-07-10", 500_000, "manual");

    expect(anchorRemovalEffects(bundle.db, brokerage, TODAY)).toEqual(
      new Map([[manual, { pricedFromHoldings: true }]]),
    );
  });

  /**
   * ⛔ Provenance calls EVERY investment account `market_value`, and the page
   * used to read the dialog's branch from that verdict. The rebuild skips
   * balances only when holding events exist, so a bare value-anchored holding
   * is re-derived from its balances and removing one really moves it.
   */
  test("an investment account WITHOUT holding events rebuilds from its balances, so it is not", () => {
    const bare = account("Bare holding", "investment");
    anchor(bare, "2026-07-01", 100_000, "statement");
    const manual = anchor(bare, "2026-07-05", 120_000, "manual");
    rebuildAccount(bundle.db, bare, "2026-07-08");

    expect(anchorRemovalEffects(bundle.db, bare, "2026-07-08").get(manual)).toEqual({
      pricedFromHoldings: false,
      // the dialog's words: a step-held value is never called verified
      isInvestment: true,
      catchUpDays: 0,
      lostDays: 0,
      lostRuns: [],
      lostTo: { unverified: 0, gap: 0, gone: 0 },
      lostCountedDays: 0,
      // Jul 5 – 8 stay carried, at $1,000.00 instead of $1,200.00
      rebasedDays: 4,
      daysLeft: 8,
      changedDays: 4,
      curveUnchanged: false,
    });
  });
});
