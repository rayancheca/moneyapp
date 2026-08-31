import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "./accounts";
import { rebuildInvestmentHistory } from "./crypto-history";
import { adjustedHoldingEvents } from "./holding-timeline";

process.env.MONEYAPP_FAKE_PRICES = "1";

/**
 * The wiring, on a database — `lib/split-adjust.ts` proves the arithmetic and
 * this proves it reaches the NAV.
 *
 * ⚠️ Written to the real shape rather than a toy one: a 10-for-1 on a fractional
 * position, with an adjusted price series that is CONTINUOUS across the split
 * day. That continuity is the whole premise, and it is a fact about the ledger
 * — COKE closes $114.36 on 2025-05-23 and $112.93 on 2025-05-27. A fixture that
 * halved the price across the split would be testing a provider this app does
 * not have.
 */
const TODAY = "2025-06-02";
const SPLIT_DAY = "2025-05-27";

let dir: string;
let bundle: DbBundle;
let accountId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-split-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db
    .select()
    .from(institutions)
    .where(eq(institutions.name, "Robinhood"))
    .get()!;
  accountId = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  // one adjusted close per calendar day across the window — flat on purpose, so
  // any movement in the NAV is the quantity and nothing else
  for (const day of ["2025-05-23", "2025-05-24", "2025-05-25", "2025-05-26", SPLIT_DAY, "2025-05-28"]) {
    bundle.db
      .insert(priceCache)
      .values({
        symbol: "COKE",
        assetType: "stock",
        quotedOn: day,
        close: 100,
        source: "yahoo",
        fetchedAt: `${day}T20:00:00.000Z`,
      })
      .run();
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function event(
  occurredOn: string,
  quantityDeltaE8: number,
  opts: { eventKind?: "trade" | "split"; note?: string } = {},
): void {
  bundle.db
    .insert(holdingEvents)
    .values({
      accountId,
      symbol: "COKE",
      assetType: "stock",
      occurredOn,
      quantityDeltaE8,
      eventKind: opts.eventKind ?? "trade",
      note: opts.note ?? null,
    })
    .run();
}

const navOn = (day: string): number | null =>
  bundle.db
    .select({ balanceCents: dailyBalances.balanceCents })
    .from(dailyBalances)
    .where(eq(dailyBalances.day, day))
    .get()?.balanceCents ?? null;

describe("adjustedHoldingEvents", () => {
  test("an unmarked timeline is returned exactly as stored", () => {
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 9e8, { note: "split, but not marked as one" });

    const out = adjustedHoldingEvents(bundle.db, accountId);
    expect(out.map((e) => e.quantityDeltaE8)).toEqual([1e8, 9e8]);
    expect(out.map((e) => e.splitFactor)).toEqual([1, 1]);
  });

  test("a marked split scales what came before it and contributes nothing itself", () => {
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 9e8, { eventKind: "split" });
    event("2025-05-28", 5e7);

    const out = adjustedHoldingEvents(bundle.db, accountId);
    expect(out.map((e) => e.quantityDeltaE8)).toEqual([10e8, 0, 5e7]);
    expect(out.map((e) => e.rawQuantityDeltaE8)).toEqual([1e8, 9e8, 5e7]);
    expect(out[0]!.splitFactor).toBe(10);
  });

  /**
   * ⛔ A split belongs to ONE security in ONE account. Grouping by symbol alone
   * would let a second account's COKE inherit this one's factor — and grouping
   * by symbol across asset types would let a ticker and a same-named coin share
   * one, the collision `rebuildInvestmentHistory` already guards when it
   * resolves closes.
   */
  test("a split in one account never scales another account's position", () => {
    const other = createAccount(bundle.db, {
      institutionId: bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!.id,
      name: "Second brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 9e8, { eventKind: "split" });
    bundle.db
      .insert(holdingEvents)
      .values({
        accountId: other,
        symbol: "COKE",
        assetType: "stock",
        occurredOn: "2025-05-23",
        quantityDeltaE8: 2e8,
      })
      .run();

    /*
     * UNSCOPED, deliberately. A scoped call never loads the other account's
     * rows, so the grouping key cannot be wrong in it — measured by mutation:
     * keying on the bare symbol passes every scoped assertion.
     */
    const all = adjustedHoldingEvents(bundle.db);
    const theirs = all.filter((e) => e.accountId === other);
    const mine = all.filter((e) => e.accountId === accountId);
    expect(mine[0]!.quantityDeltaE8).toBe(10e8);
    expect(mine[0]!.splitFactor).toBe(10);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.quantityDeltaE8).toBe(2e8);
    expect(theirs[0]!.splitFactor).toBe(1);
  });

  /**
   * ⛔ The walk follows `occurred_on`, not insertion. A split's ratio is
   * `(Q + delta) / Q` for the Q standing when it happened, so an event inserted
   * out of date order — a backfill, a corrected import — must still take its
   * place in time. Ordered by id instead, the split here arrives first, divides
   * an empty position, and every earlier share silently goes unscaled.
   */
  test("a backfilled trade takes its place in time, not in insertion order", () => {
    event(SPLIT_DAY, 9e8, { eventKind: "split" }); // written first…
    event("2025-05-23", 1e8); // …but occurred earlier

    const out = adjustedHoldingEvents(bundle.db, accountId);
    expect(out.map((e) => e.occurredOn)).toEqual(["2025-05-23", SPLIT_DAY]);
    expect(out.map((e) => e.quantityDeltaE8)).toEqual([10e8, 0]);
  });

  test("scoping to one account still sees the whole ledger when unscoped", () => {
    event("2025-05-23", 1e8);
    expect(adjustedHoldingEvents(bundle.db)).toHaveLength(1);
    expect(adjustedHoldingEvents(bundle.db, accountId)).toHaveLength(1);
  });
});

describe("rebuildInvestmentHistory with a split", () => {
  /**
   * The defect, in one assertion. The price is flat at $100 across the split, so
   * an honest NAV cannot move on a day no shares were bought — and unmarked, it
   * jumps tenfold.
   */
  test("unmarked, the NAV jumps tenfold on a day nothing was bought", () => {
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 9e8);
    rebuildInvestmentHistory(bundle.db, accountId, TODAY);

    expect(navOn("2025-05-23")).toBe(100_00);
    expect(navOn(SPLIT_DAY)).toBe(1_000_00);
  });

  test("marked, the level is continuous and the position is unchanged", () => {
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 9e8, { eventKind: "split" });
    rebuildInvestmentHistory(bundle.db, accountId, TODAY);

    // 10 shares × $100 on BOTH sides — the split moved no money
    expect(navOn("2025-05-23")).toBe(1_000_00);
    expect(navOn(SPLIT_DAY)).toBe(1_000_00);
    expect(navOn("2025-05-28")).toBe(1_000_00);
  });

  test("a trade earlier on the split's own day is scaled too", () => {
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 1e7); // bought pre-split, same day
    event(SPLIT_DAY, 9.9e8, { eventKind: "split" }); // 1.1 → 11
    rebuildInvestmentHistory(bundle.db, accountId, TODAY);

    expect(navOn("2025-05-23")).toBe(1_000_00); // 1.0 × 10 shares
    expect(navOn(SPLIT_DAY)).toBe(1_100_00); // 1.1 × 10 shares
  });

  /**
   * ⚠️ The days BETWEEN carry forward the adjusted quantity, not the raw one —
   * a weekend at the old level would leave a visible cliff on the Monday.
   */
  test("the carried days before a split are adjusted as well", () => {
    event("2025-05-23", 1e8);
    event(SPLIT_DAY, 9e8, { eventKind: "split" });
    rebuildInvestmentHistory(bundle.db, accountId, TODAY);

    const rows = bundle.db
      .select({ day: dailyBalances.day, cents: dailyBalances.balanceCents })
      .from(dailyBalances)
      .orderBy(asc(dailyBalances.day))
      .all();
    expect(rows.map((r) => r.cents)).toEqual(rows.map(() => 1_000_00));
  });
});
