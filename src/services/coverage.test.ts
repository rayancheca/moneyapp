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
import { BALANCE_BASES } from "@/db/schema/balances";
import { accountCoverage, basisIsChecked } from "./coverage";

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
    // …and the day the chain actually FAILED is a different day, which is the
    // whole reason `brokenSince` exists
    expect(c.brokenSince).toBe("2026-08-03");
  });

  /*
   * The coverage panel prints one sentence pairing a DATE with a COUNT — "the
   * balance chain stops closing at {date} — {n} days cannot be trusted" — and
   * those were drawn from two different populations. `unverifiedSince` is the
   * first `derived_unverified` OR `gap` day; `days.gap` counts only `gap`.
   *
   * On the real ledger the two were 23 months apart: Robinhood Cash replays 26
   * days before its first anchor, so it reported the break at 2023-12-05 while
   * every one of its gap days was 2025-11 or later. The sentence named a year
   * and a half of reconciled history as the moment the money stopped adding up.
   */
  test("the day the chain broke is not the day the replay started", () => {
    const id = addAccount("a-prehistory", "Replayed First", "checking");
    addDays(id, [
      // prehistory: replayed backwards before the account's first anchor
      { day: "2026-08-01", basis: "derived_unverified" },
      { day: "2026-08-02", basis: "derived_unverified" },
      // …then a long stretch that genuinely closes…
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
      { day: "2026-08-05", basis: "anchored" },
      // …and only THEN a real break
      { day: "2026-08-06", basis: "gap" },
      { day: "2026-08-07", basis: "gap" },
    ]);
    addTxn(id, "2026-08-04");

    const c = only(id);

    expect(c.grade).toBe("broken");
    expect(c.days.gap).toBe(2);
    // the honest pairing: 2 gap days that begin on the 6th
    expect(c.brokenSince).toBe("2026-08-06");
    // the field that was being printed beside that count points 5 days earlier,
    // at prehistory that is not a break at all
    expect(c.unverifiedSince).toBe("2026-08-01");
    expect(c.brokenSince).not.toBe(c.unverifiedSince);
  });

  test("an account with no gap day has no brokenSince to report", () => {
    const id = addAccount("a-clean", "Clean", "checking");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
    ]);
    addTxn(id, "2026-08-02");

    const c = only(id);

    expect(c.grade).toBe("verified");
    expect(c.brokenSince).toBeNull();
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

    /*
     * ⛔ The same single-row blindness on the other query. "You last counted it
     * on <date>" is spoken in three places — /imports, the provenance popover
     * and the cards-owed card — and Cash on Hand is a hand-counted account with
     * a running history, so on the real ledger this is the date he last opened
     * the safe. Reversing the sort changed no test while only one anchor
     * existed.
     */
    bundle.db
      .insert(balanceAnchors)
      .values({
        id: "anchor-manual-older",
        accountId: id,
        anchoredOn: "2026-07-01",
        balanceCents: 150000,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(only(id).lastManualUpdate).toBe("2026-08-03");
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

    /*
     * ⛔ "NEWEST" NEEDS TWO ROWS TO MEAN ANYTHING. With one period on file the
     * sort direction is unobservable, and reversing it changed no test — while
     * on the real ledger every card has dozens of periods, so the /imports
     * panel would have printed the FIRST statement ever filed as the coverage
     * frontier: "statements → 2024-07-18" against a card imported through
     * 2026-08-14.
     */
    bundle.db
      .insert(importFiles)
      .values({
        id: "f0",
        fileName: "older.pdf",
        fileSha256: "sha0",
        format: "pdf",
        institutionId,
        parserVersion: 1,
        status: "parsed",
        storagePath: "/tmp/older.pdf",
        importedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    bundle.db
      .insert(statementPeriods)
      .values({
        id: "p0",
        importFileId: "f0",
        accountId: withPeriod,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        reconciliation: "reconciled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(only(withPeriod).statementsThrough).toBe("2026-07-31");
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

let runSeq = 0;
function runCoverage(rows: { day: string; basis: string }[]) {
  runSeq += 1;
  const id = addAccount(`a-run-${runSeq}`, `Run ${runSeq}`, "checking");
  addDays(id, rows);
  addTxn(id, rows[0]!.day);
  return only(id);
}

describe("uncheckedSince — the run a 'since' date is actually about", () => {
  /*
   * 🔴 `unverifiedSince` is the FIRST unchecked day the account ever had, and
   * the coverage row paired it with a count of every unchecked day:
   *
   *     Robinhood Cash — nothing checks it since Dec 5, 2023 · 52 days unchecked
   *
   * read on 2026-09-04 of an account with 32 statement anchors, the newest
   * closing 2026-07-31. Its 52 unchecked days fall in two runs with 946 checked
   * days between them — prehistory before its very first anchor, and a fresh
   * tail. `AccountCoverage.brokenSince` was added for this exact trap and only
   * covered the gap case.
   */
  test("names the day the CURRENT run of unchecked days opened, not the first ever", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "derived_unverified" },
      { day: "2026-01-03", basis: "anchored" },
      { day: "2026-01-04", basis: "derived" },
      { day: "2026-01-05", basis: "derived_unverified" },
    ]);
    expect(c.unverifiedSince).toBe("2026-01-01");
    expect(c.uncheckedSince).toBe("2026-01-05");
    expect(c.uncheckedRunDays).toBe(1);
    // the account's total is unchanged — the footnote sums this, not the run
    expect(c.days.derived_unverified).toBe(3);
  });

  test("an account whose newest day is checked has no open run", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "anchored" },
    ]);
    expect(c.uncheckedSince).toBeNull();
    expect(c.uncheckedRunDays).toBe(0);
  });

  test("an account unchecked from its first day to its last says so", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "derived_unverified" },
    ]);
    expect(c.uncheckedSince).toBe("2026-01-01");
    expect(c.uncheckedRunDays).toBe(2);
  });
});

describe("verifiedThrough — a break, and what only looks like one", () => {
  /*
   * 🔴 Robinhood Cash opens on 2023-12-05 with 26 days of prehistory before its
   * very first anchor, so the "first untrusted day" was its opening day, every
   * trusted day failed the `< firstUntrusted` test, and `verifiedThrough` came
   * back null — of an account with 32 statement anchors and 32 reconciled
   * periods, the newest closing 2026-07-31. `/imports` then printed, on one row:
   *
   *     Robinhood Cash · Unverified · statements → 2026-07-31
   *     nothing closes to the cent from its first day; …
   */
  test("untrusted days BEFORE the first anchor are prehistory, not a break", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "derived_unverified" },
      { day: "2026-01-03", basis: "anchored" },
      { day: "2026-01-04", basis: "derived" },
      { day: "2026-01-05", basis: "derived_unverified" },
    ]);
    expect(c.verifiedThrough).toBe("2026-01-04");
  });

  /*
   * ⛔ AND THE GUARD IT MUST NOT COST. A later anchor is a fresh starting point,
   * not proof of the span before it — so a break in the MIDDLE still stops the
   * walk where it always did.
   */
  test("a break after the chain has started still stops it there", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "anchored" },
      { day: "2026-01-02", basis: "derived" },
      { day: "2026-01-03", basis: "derived_unverified" },
      { day: "2026-01-04", basis: "anchored" },
      { day: "2026-01-05", basis: "derived" },
    ]);
    expect(c.verifiedThrough).toBe("2026-01-02");
  });

  test("an account that never closes at all still says so", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "derived_unverified" },
    ]);
    expect(c.verifiedThrough).toBeNull();
  });
});

describe("basisIsChecked — the rule three surfaces were answering separately", () => {
  /**
   * 🔴 `/accounts/[id]`'s remove-balance confirmation kept a local
   * `{anchored, derived}` set and so called a `carried` day unchecked. On the
   * owner's ledger that turned the blast radius of removing Cash on Hand's
   * 2026-08-03 anchor — 1 anchored day + 7 carried — into "1 day".
   */
  test("a carried day is checked: it rests on the anchor it was carried from", () => {
    expect(basisIsChecked("carried")).toBe(true);
  });

  test("anchored and derived are checked", () => {
    expect(basisIsChecked("anchored")).toBe(true);
    expect(basisIsChecked("derived")).toBe(true);
  });

  test("only derived_unverified and gap are not", () => {
    expect(basisIsChecked("derived_unverified")).toBe(false);
    expect(basisIsChecked("gap")).toBe(false);
  });

  test("every basis the schema allows has an answer", () => {
    // a new basis must be classified here deliberately rather than defaulting
    expect(BALANCE_BASES.filter(basisIsChecked)).toEqual(["anchored", "derived", "carried"]);
  });
});
