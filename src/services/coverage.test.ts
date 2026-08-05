import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { accountCoverage } from "./coverage";

/**
 * Coverage grading exists because the two questions "is this account's money
 * checked?" and "does this account have statements?" have DIFFERENT answers,
 * and the app only ever showed the second one.
 *
 * The trap these tests pin: `daily_balances.basis` means two unrelated things
 * depending on the account type. For cash accounts `derived` is written by
 * derivation.ts:209 and means the transaction walk landed EXACTLY on the next
 * anchor — a real arithmetic check. For investment accounts it is written by
 * crypto-history.ts:124 and means only that every held symbol had a fresh
 * market close that day. Grading investment accounts off the same enum paints
 * the two accounts with NO arithmetic gate (reconcileAccounts stamps
 * `value_anchor` unconditionally for type='investment') the same green as a
 * card that reconciles to the cent.
 */

let dir: string;
let bundle: DbBundle;
let institutionId: string;

const TODAY = "2026-08-05";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-coverage-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addAccount(id: string, name: string, type: string): string {
  const now = new Date().toISOString();
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: type as never,
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function addDays(accountId: string, rows: { day: string; basis: string }[]): void {
  for (const r of rows) {
    bundle.db
      .insert(dailyBalances)
      .values({ accountId, day: r.day, balanceCents: 1000, basis: r.basis as never })
      .run();
  }
}

/**
 * A `derived` day means the transaction walk moved the balance onto an anchor,
 * so a fixture with derived days and no transactions is a shape the deriver
 * cannot produce. Every cash-account case seeds one so the grading runs against
 * data that could actually exist.
 */
let txnSeq = 0;
function addTxn(accountId: string, day: string): void {
  const now = new Date().toISOString();
  txnSeq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `txn-${txnSeq}`,
      accountId,
      postedOn: day,
      amountCents: -1234,
      rawDescription: "COFFEE",
      normalizedDescription: "coffee",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${txnSeq}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function only(accountId: string) {
  return accountCoverage(bundle.db, TODAY).find((c) => c.accountId === accountId)!;
}

describe("accountCoverage", () => {
  test("a cash account whose chain closes is verified through its last derived day", () => {
    const id = addAccount("a-cash", "Chase Checking", "checking");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "derived" },
    ]);
    addTxn(id, "2026-08-02");

    const c = only(id);

    expect(c.grade).toBe("verified");
    expect(c.verifiedThrough).toBe("2026-08-03");
    expect(c.unverifiedSince).toBeNull();
  });

  test("derived_unverified days downgrade the account and report when the thread was lost", () => {
    const id = addAccount("a-disc", "Discover", "credit");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "derived_unverified" },
      { day: "2026-08-04", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-02");

    const c = only(id);

    expect(c.grade).toBe("unverified");
    // the last day the app can still stand behind, not the last day it has
    expect(c.verifiedThrough).toBe("2026-08-02");
    expect(c.unverifiedSince).toBe("2026-08-03");
    expect(c.days.derived_unverified).toBe(2);
  });

  test("a gap day outranks unverified — a chain that does not close is the worst grade", () => {
    const id = addAccount("a-broken", "Broken", "checking");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived_unverified" },
      { day: "2026-08-03", basis: "gap" },
    ]);
    addTxn(id, "2026-08-02");

    const c = only(id);

    expect(c.grade).toBe("broken");
    expect(c.unverifiedSince).toBe("2026-08-02");
  });

  test("an investment account is NEVER graded verified, even when every day says derived", () => {
    // crypto-history.ts:124 writes `derived` when prices were fresh — it is not
    // an arithmetic check, and reconcileAccounts (service.ts:1190) stamps
    // `value_anchor` for type='investment' unconditionally, so no gate exists.
    const id = addAccount("a-inv", "Robinhood Brokerage", "investment");
    addDays(id, [
      { day: "2026-08-01", basis: "derived" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "derived" },
    ]);

    const c = only(id);

    expect(c.grade).toBe("market_value");
    expect(c.verifiedThrough).toBeNull();
  });

  test("an account with no transactions and a manual anchor is graded manual, not verified", () => {
    const id = addAccount("a-cash-hand", "Cash on Hand", "checking");
    const now = new Date().toISOString();
    bundle.db
      .insert(balanceAnchors)
      .values({
        id: "anchor-manual",
        accountId: id,
        anchoredOn: "2026-08-03",
        balanceCents: 180000,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "carried" },
    ]);

    const c = only(id);

    expect(c.grade).toBe("manual");
    expect(c.lastManualUpdate).toBe("2026-08-03");
  });

  test("statementsThrough reports the newest period end and is null when none exist", () => {
    const withPeriod = addAccount("a-p", "Has Statements", "credit");
    const without = addAccount("a-np", "No Statements", "checking");
    const now = new Date().toISOString();
    bundle.db
      .insert(importFiles)
      .values({
        id: "f1",
        fileName: "s.pdf",
        fileSha256: "sha",
        format: "pdf",
        institutionId,
        parserVersion: 1,
        status: "parsed",
        storagePath: "/tmp/s.pdf",
        importedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    bundle.db
      .insert(statementPeriods)
      .values({
        id: "p1",
        importFileId: "f1",
        accountId: withPeriod,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        reconciliation: "reconciled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    addDays(withPeriod, [{ day: "2026-08-01", basis: "derived" }]);
    addDays(without, [{ day: "2026-08-01", basis: "derived" }]);
    addTxn(withPeriod, "2026-08-01");
    addTxn(without, "2026-08-01");

    expect(only(withPeriod).statementsThrough).toBe("2026-07-31");
    expect(only(without).statementsThrough).toBeNull();
  });

  test("an account with no derived cache at all is graded unknown rather than verified", () => {
    const id = addAccount("a-empty", "Fresh Account", "checking");

    const c = only(id);

    expect(c.grade).toBe("unknown");
    expect(c.verifiedThrough).toBeNull();
  });

  test("inactive accounts are excluded", () => {
    const id = addAccount("a-closed", "Closed Card", "credit");
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, id)).run();
    addDays(id, [{ day: "2026-08-01", basis: "derived" }]);
    addTxn(id, "2026-08-01");

    expect(accountCoverage(bundle.db, TODAY).find((c) => c.accountId === id)).toBeUndefined();
  });

  test("staleness is measured from the last day the app can stand behind", () => {
    const id = addAccount("a-stale", "SoFi Checking", "savings");
    addDays(id, [
      { day: "2026-06-28", basis: "anchored" },
      { day: "2026-06-29", basis: "derived" },
      { day: "2026-06-30", basis: "derived" },
    ]);
    addTxn(id, "2026-06-29");

    // 2026-06-30 → 2026-08-05
    expect(only(id).daysSinceVerified).toBe(36);
  });
});
