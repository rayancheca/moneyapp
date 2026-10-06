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
import { ACCOUNT_TYPES } from "@/db/schema/accounts";
import { beforeFirstBalance } from "@/lib/coverage-detail";
import { addManualAnchor } from "./anchors";
import { accountCoverage, balanceDayIsExact, basisIsChecked } from "./coverage";
import { rebuildAccount } from "./derivation";

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

/** Robinhood Agentic's shape on his ledger: three statements that agree, and the Jun 5 row that funded it. */
function addAgentic(): string {
  const id = addAccount("a-agentic", "Robinhood Agentic", "checking");
  addAnchorRow(id, "2026-06-30", "statement");
  addAnchorRow(id, "2026-07-31", "statement");
  addAnchorRow(id, "2026-08-31", "statement");
  addTxn(id, "2026-06-05");
  rebuildAccount(bundle.db, id, "2026-09-15");
  return id;
}

/*
 * ⚖️ His answer, 2026-10-05 (§6A 35): days BEFORE an account's first balance — replayed backwards
 * from it, with nothing earlier to check them against — do not on their own make it an account
 * "nothing is checking". Robinhood Agentic (26 such days, Jun 4–29; first balance the Jun 30
 * statement; closes through Aug 31; no run open) graded `unverified` on them alone, so /imports'
 * header read "3 accounts nothing is checking" and net worth "3 have nothing checking them" of a
 * balance three reconciled statements stand on. The grade reads the days the balance RESTS on.
 *
 * ⛔ What must not move with it: a run open past the first balance, a first balance of his that
 * nothing closes, and an account with no first balance at all are still unchecked, and
 * `unverifiedSince` is still the first unchecked day it ever had.
 */
describe("⚖️ the days before its first balance do not grade it (§6A 35)", () => {
  test("a run open past its first balance still leaves it unverified", () => {
    const id = addAgentic();
    addTxn(id, "2026-09-05");
    rebuildAccount(bundle.db, id, "2026-09-15");

    const c = accountCoverage(bundle.db, "2026-10-01").find((a) => a.accountId === id)!;
    expect(c).toMatchObject({
      grade: "unverified",
      verifiedThrough: "2026-08-31",
      firstBalanceOn: "2026-06-30",
      unverifiedSince: "2026-06-04",
      uncheckedSince: "2026-09-05",
      uncheckedRunDays: 11,
    });
    expect(c.days.derived_unverified).toBe(37);
  });

  test("his count first, with nothing closing after it, is still his word and nothing else", () => {
    const id = addAccount("a-count-only", "Wallet", "checking");
    addTxn(id, "2026-06-05");
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-06-20", enteredCents: 500_000 });
    rebuildAccount(bundle.db, id, "2026-07-15");

    const c = accountCoverage(bundle.db, "2026-07-15").find((a) => a.accountId === id)!;
    expect(c).toMatchObject({
      grade: "unverified",
      verifiedThrough: null,
      firstBalanceOn: "2026-06-20",
      firstBalanceIsCount: true,
      countedOn: "2026-06-20",
      unverifiedSince: "2026-06-04",
      uncheckedSince: null,
    });
  });

  // ⚠️ an opening kept from a statement he un-imported records no first balance; nothing closes
  // either, so `closed.size === 0` grades it too (a mutation of one rule alone does not fail this)
  test("with no first balance, every unchecked day is one the balance rests on", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "derived_unverified" },
    ]);
    expect(c.firstBalanceOn).toBeNull();
    expect(c.grade).toBe("unverified");
  });

  test("a gap still breaks it, whatever came before its first balance", () => {
    const c = runCoverage([
      { day: "2026-01-01", basis: "derived_unverified" },
      { day: "2026-01-02", basis: "anchored" },
      { day: "2026-01-03", basis: "gap" },
      { day: "2026-01-04", basis: "anchored" },
    ]);
    expect(c.grade).toBe("broken");
  });
});

describe("a statement first — where the days before its first balance end", () => {
  /*
   * 🔴 /imports read "closes to the cent through Aug 31, 2026 (31 days ago); the first day it
   * does not is Jun 4, 2026" of Robinhood Agentic (a copy of his ledger, 2026-10-01): Jun 4 is
   * the first of the days replayed backwards from its first balance, not a day it stopped
   * closing. Built here through the app's own path, so the row's fixture in
   * lib/coverage-detail.test.ts is a shape the rebuild produces.
   */
  test("Robinhood Agentic's shape: unchecked only before its first balance, nothing open", () => {
    const id = addAgentic();

    const c = accountCoverage(bundle.db, "2026-10-01").find((a) => a.accountId === id)!;
    expect(c).toMatchObject({
      // ⚖️ §6A 35: its balance rests on three statements that close; the days before them do not grade it
      grade: "verified",
      verifiedThrough: "2026-08-31",
      chainOpensOn: "2026-06-30",
      firstBalanceOn: "2026-06-30",
      firstBalanceIsCount: false,
      unverifiedSince: "2026-06-04",
      uncheckedSince: null,
      uncheckedRunDays: 0,
      countedOn: null,
      balancesThrough: "2026-09-15",
      daysSinceVerified: 31,
    });
    expect(c.days).toMatchObject({ anchored: 3, derived_unverified: 26, carried: 75, gap: 0 });
    // the reading /imports' row and net worth's line share, off the fields as published
    expect(beforeFirstBalance(c)).toEqual({
      checkedThrough: "2026-08-31",
      firstBalanceOn: "2026-06-30",
      firstBalanceIsCount: false,
    });
  });
});

describe("firstBalanceOn — the balance the days before it are replayed from", () => {
  /*
   * 🔴 (review, 2026-10-01) /imports named `chainOpensOn` as "its first balance", and that is the
   * first day that CLOSES. His count as the first balance closes nothing: the day before it is
   * replayed backwards from it, unchecked, so `chainFooting` puts it in `counted`. The chain then
   * opens on the next statement — or, when a replay from his count lands on one, on the day after
   * his count, which records no balance at all — and the row said the days before his count were
   * replayed backwards from that day.
   */
  const countedFirst = (txnBetween: boolean): string => {
    const id = addAccount("a-counted-first", "New Checking", "checking");
    addTxn(id, "2026-06-05");
    // $5,012.34 and the -$12.34 row on Jun 25 land on the Jun 30 statement; $5,000.00 carries to it
    if (txnBetween) addTxn(id, "2026-06-25");
    const enteredCents = txnBetween ? 501_234 : 500_000;
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-06-20", enteredCents });
    for (const day of ["2026-06-30", "2026-07-31", "2026-08-31"]) addAnchorRow(id, day, "statement");
    rebuildAccount(bundle.db, id, "2026-09-15");
    return id;
  };

  test("his count first, statements after: the days before it are replayed from his count", () => {
    const id = countedFirst(false);
    const c = accountCoverage(bundle.db, "2026-10-01").find((a) => a.accountId === id)!;
    expect(c).toMatchObject({
      // ⚖️ §6A 35: statements close from Jun 30; the days before his count do not grade it
      grade: "verified",
      verifiedThrough: "2026-08-31",
      chainOpensOn: "2026-06-30",
      firstBalanceOn: "2026-06-20",
      firstBalanceIsCount: true,
      unverifiedSince: "2026-06-04",
      uncheckedSince: null,
      countedOn: null,
    });
    expect(c.days).toMatchObject({ anchored: 4, derived_unverified: 16, gap: 0 });
    expect(beforeFirstBalance(c)).toEqual({
      checkedThrough: "2026-08-31",
      firstBalanceOn: "2026-06-20",
      firstBalanceIsCount: true,
    });
  });

  test("a replay from his count that lands on a statement opens the chain on a day with no balance", () => {
    const id = countedFirst(true);
    const c = accountCoverage(bundle.db, "2026-10-01").find((a) => a.accountId === id)!;
    expect(c).toMatchObject({
      chainOpensOn: "2026-06-21",
      firstBalanceOn: "2026-06-20",
      firstBalanceIsCount: true,
    });
    expect(beforeFirstBalance(c)?.firstBalanceOn).toBe("2026-06-20");
  });

  test("an account with no balance has none, and a statement first is not his count", () => {
    addAccount("a-empty", "Empty", "checking");
    expect(only("a-empty")).toMatchObject({ firstBalanceOn: null, firstBalanceIsCount: false });

    const id = addAccount("a-statement-first", "Statement First", "checking");
    addAnchorRow(id, "2026-06-30", "statement");
    addTxn(id, "2026-06-05");
    rebuildAccount(bundle.db, id, "2026-07-15");
    expect(accountCoverage(bundle.db, "2026-07-15").find((a) => a.accountId === id)).toMatchObject({
      firstBalanceOn: "2026-06-30",
      firstBalanceIsCount: false,
    });
  });
});

describe("balancesThrough — where the stored days end", () => {
  /*
   * 🔴 /imports read "…rests on the balance you counted on Aug 1, 2026; the first day past
   * that count is Jul 27, 2026" of this card — a day before the count — and dropped the 9
   * days carried on it (§6A 28 review). With no unchecked run open past his count, the days
   * it carries run to the newest stored day, and nothing published that day.
   */
  test("is the newest day with a balance, through the app's own path, and null with none", () => {
    const id = addAccount("a-new-card", "New Card", "credit");
    addTxn(id, "2026-07-28");
    addTxn(id, "2026-07-30");
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-08-01", enteredCents: 9_000 });
    rebuildAccount(bundle.db, id, "2026-08-10");

    const c = accountCoverage(bundle.db, "2026-08-10").find((a) => a.accountId === id)!;
    // the shape the row misread: his count, prehistory before it, nothing unchecked past it
    expect(c).toMatchObject({ countedOn: "2026-08-01", unverifiedSince: "2026-07-27", uncheckedSince: null });
    expect(c.balancesThrough).toBe("2026-08-10");

    addAccount("a-empty", "Empty", "checking");
    expect(only("a-empty").balancesThrough).toBeNull();
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

function addAnchorRow(accountId: string, day: string, source: "manual" | "statement" | "ofx_ledger"): void {
  const now = new Date().toISOString();
  bundle.db
    .insert(balanceAnchors)
    .values({ accountId, anchoredOn: day, balanceCents: 500000, source, createdAt: now, updatedAt: now })
    .run();
}

describe("a balance he typed checks nothing on its own", () => {
  /*
   * 🔴 CASH ON HAND "CLOSES TO THE CENT THROUGH AUG 3, 2026". Measured
   * 2026-09-16 on a copy of the real ledger: one balance typed by hand on Aug 3
   * ($5,000.00, `source = manual`, no statement period, no import file), carried
   * Aug 4–10, and the hand-entered car down payment on Aug 11. Every `anchored`
   * day counted as a closed chain, so `verifiedThrough` read 2026-08-03 and
   * /imports printed "closes to the cent through Aug 3, 2026 (44 days ago)", the
   * account's balance popover "Checked through 2026-08-03", and the proof beside
   * "1 transaction landed in Cash on Hand" the same date. Nothing was replayed
   * onto that balance; it is his count, and a count is not a check.
   *
   * ⛔ A typed balance the replay LANDS on is checked — by the arithmetic, not by
   * him — and a statement recorded on the same day wins it (`pickWinners`).
   */
  test("an account whose only balance is one he typed closes through no day", () => {
    const id = addAccount("a-coh", "Cash on Hand", "checking");
    addAnchorRow(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "carried" },
      { day: "2026-08-10", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-11");

    const c = only(id);
    expect(c.grade).toBe("unverified");
    expect(c.verifiedThrough).toBeNull();
    expect(c.chainOpensOn).toBeNull();
    expect(c.daysSinceVerified).toBeNull();
    expect(c.countedOn).toBe("2026-08-03");
    expect(c.uncheckedSince).toBe("2026-08-11");
  });

  test("a typed balance the replay lands on exactly is checked by that arithmetic", () => {
    const id = addAccount("a-landed", "Chase Checking", "checking");
    addAnchorRow(id, "2026-07-31", "statement");
    addAnchorRow(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-07-31", basis: "anchored" },
      { day: "2026-08-01", basis: "derived" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "carried" },
    ]);
    addTxn(id, "2026-08-01");

    const c = only(id);
    expect(c.grade).toBe("verified");
    expect(c.verifiedThrough).toBe("2026-08-03");
    expect(c.chainOpensOn).toBe("2026-07-31");
    expect(c.countedOn).toBeNull();
  });

  test("a statement and a typed balance on one day close as the statement", () => {
    const id = addAccount("a-tie", "Chase Checking", "checking");
    addAnchorRow(id, "2026-08-03", "manual");
    addAnchorRow(id, "2026-08-03", "statement");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-04");

    const c = only(id);
    expect(c.verifiedThrough).toBe("2026-08-03");
    expect(c.chainOpensOn).toBe("2026-08-03");
    expect(c.countedOn).toBeNull();
  });

  test("a carry confirms a second count only when what it carries was checked", () => {
    // his count, nothing posted, his same count again: the second rests on the first
    const counted = addAccount("a-two-counts", "Safe", "checking");
    addAnchorRow(counted, "2026-08-01", "manual");
    addAnchorRow(counted, "2026-08-03", "manual");
    addDays(counted, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "carried" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "derived_unverified" },
    ]);
    addTxn(counted, "2026-08-04");
    expect(only(counted).verifiedThrough).toBeNull();
    expect(only(counted).countedOn).toBe("2026-08-03");

    // a statement, nothing posted, his count agreeing with it: the statement checks it
    const stated = addAccount("a-stated", "Drawer", "checking");
    addAnchorRow(stated, "2026-08-01", "statement");
    addAnchorRow(stated, "2026-08-03", "manual");
    addDays(stated, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "carried" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "derived_unverified" },
    ]);
    addTxn(stated, "2026-08-04");
    expect(only(stated).verifiedThrough).toBe("2026-08-03");
    expect(only(stated).countedOn).toBeNull();
  });

  test("rows only on the day he counted do not make the account add up", () => {
    const id = addAccount("a-same-day", "Wallet", "checking");
    addAnchorRow(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "carried" },
    ]);
    addTxn(id, "2026-08-03");

    const c = only(id);
    expect(c.grade).toBe("unverified");
    expect(c.verifiedThrough).toBeNull();
    expect(c.countedOn).toBe("2026-08-03");
  });

  test("an anchored day with no typed balance behind it is unchanged", () => {
    const id = addAccount("a-plain", "Plain", "checking");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "carried" },
    ]);
    addTxn(id, "2026-08-03");
    expect(only(id).grade).toBe("verified");
    expect(only(id).verifiedThrough).toBe("2026-08-03");
    expect(only(id).countedOn).toBeNull();
  });
});

describe("two counts of his do not check each other, through the rebuild", () => {
  /*
   * 🔴 A SECOND COUNT BROUGHT "CLOSES TO THE CENT" BACK. Measured 2026-09-16 on
   * a copy of the real ledger: recording Cash on Hand at $0.00 for Aug 12, 2026
   * — the wallet after the $5,000.00 car down payment he entered by hand on Aug
   * 11 — through `addManualAnchor` made Aug 4–11 `derived` and the account
   * `verified` through Aug 12. /imports read "closes to the cent through Aug 12,
   * 2026", the net-worth count "8 of 13 accounts add up against a document" and
   * every balance proof "Checked through 2026-08-12", of an account with no
   * document at all. His own row reconciling two of his own counts is his word
   * three times, not a check.
   *
   * ⛔ A replay between two of his counts closes only when the count it starts
   * from is itself closed — the rule a carry between them already followed.
   */
  const REBUILT_ON = "2026-09-16";

  function anchorAt(accountId: string, day: string, source: "manual" | "statement", cents: number): void {
    const now = new Date().toISOString();
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId, anchoredOn: day, balanceCents: cents, source, createdAt: now, updatedAt: now })
      .run();
  }

  function rowAt(accountId: string, day: string, cents: number): void {
    const now = new Date().toISOString();
    txnSeq += 1;
    bundle.db
      .insert(transactions)
      .values({
        id: `txn-${txnSeq}`,
        accountId,
        postedOn: day,
        amountCents: cents,
        rawDescription: "CAR DOWN PAYMENT",
        normalizedDescription: "car down payment",
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: `hash-${txnSeq}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const storedBasis = (accountId: string, day: string) =>
    bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, accountId))
      .all()
      .find((r) => r.day === day)?.basis;

  const at = (accountId: string, today: string) =>
    accountCoverage(bundle.db, today).find((c) => c.accountId === accountId)!;

  test("a count, a row he entered, and a second count agreeing with them check nothing", () => {
    const id = addAccount("a-recount", "Cash on Hand", "checking");
    anchorAt(id, "2026-08-03", "manual", 500_000);
    rowAt(id, "2026-08-11", -500_000);
    anchorAt(id, "2026-08-12", "manual", 0);
    rebuildAccount(bundle.db, id, REBUILT_ON);

    // the replay did land: the fixture is the shape the real ledger took
    expect(storedBasis(id, "2026-08-05")).toBe("derived");
    expect(storedBasis(id, "2026-08-12")).toBe("anchored");

    const c = at(id, REBUILT_ON);
    expect(c.grade).toBe("unverified");
    expect(c.verifiedThrough).toBeNull();
    expect(c.chainOpensOn).toBeNull();
    expect(c.daysSinceVerified).toBeNull();
    expect(c.countedOn).toBe("2026-08-12");
    expect(c.uncheckedSince).toBeNull();
  });

  test("a chain a statement opens still checks every count it reaches", () => {
    const id = addAccount("a-stated-recount", "Chase Checking", "checking");
    anchorAt(id, "2026-07-31", "statement", 500_000);
    rowAt(id, "2026-08-01", -100_000);
    anchorAt(id, "2026-08-03", "manual", 400_000);
    rowAt(id, "2026-08-11", -400_000);
    anchorAt(id, "2026-08-12", "manual", 0);
    rebuildAccount(bundle.db, id, REBUILT_ON);

    const c = at(id, REBUILT_ON);
    expect(c.grade).toBe("verified");
    expect(c.verifiedThrough).toBe("2026-08-12");
    expect(c.chainOpensOn).toBe("2026-07-31");
    expect(c.countedOn).toBeNull();
  });

  test("two counts then a statement: only the replay that lands on the statement closes", () => {
    const TODAY_AUG_10 = "2026-08-10";
    const id = addAccount("a-counts-then-statement", "Drawer", "checking");
    anchorAt(id, "2026-08-01", "manual", 100_000);
    rowAt(id, "2026-08-03", -10_000);
    anchorAt(id, "2026-08-05", "manual", 90_000);
    rowAt(id, "2026-08-07", -5_000);
    anchorAt(id, "2026-08-10", "statement", 85_000);
    rebuildAccount(bundle.db, id, TODAY_AUG_10);

    const c = at(id, TODAY_AUG_10);
    expect(c.grade).toBe("verified");
    expect(c.verifiedThrough).toBe("2026-08-10");
    // Aug 2–5 rest on his counts; the statement's replay opens on Aug 6
    expect(c.chainOpensOn).toBe("2026-08-06");
    // a count with a closed chain after it is not what the newest days stand on
    expect(c.countedOn).toBeNull();
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

describe("balanceDayIsExact — what a chart may draw solid", () => {
  /**
   * 🔴 The dashboard's terrain and rollup lines kept a third local
   * `{anchored, derived}` set, so every stored `carried` day on a cash or credit
   * account drew broken. Measured 2026-09-15 on the owner's ledger: Chase
   * Sapphire's rail read "+$82.72 since Feb 2025 · 1 unverified" and its Sep 15
   * slug "this day is estimated" over 13 carried days that sit on the Sep 2
   * statement with nothing posted — while the trust card on the same page calls
   * such days "as proven as that balance, and not a gap".
   */
  test("a cash or credit account's day is exact exactly when it is checked", () => {
    for (const type of ACCOUNT_TYPES.filter((t) => t !== "investment")) {
      for (const basis of BALANCE_BASES) {
        expect(balanceDayIsExact(type, basis), `${type} ${basis}`).toBe(basisIsChecked(basis));
      }
    }
    expect(balanceDayIsExact("credit", "carried")).toBe(true);
  });

  /**
   * ⛔ The type branch `accountCoverage` takes first. On an investment account
   * `carried` is a CARRIED PRICE — `rebuildInvestmentHistory` writes it when a
   * held symbol had no close that day, and value-anchor step-hold writes it for
   * a recorded value held flat across a market that moved. Neither is an exact
   * figure, so it stays dashed.
   */
  test("an investment account's carried day is a carried price, never exact", () => {
    expect(balanceDayIsExact("investment", "carried")).toBe(false);
    expect(BALANCE_BASES.filter((b) => balanceDayIsExact("investment", b))).toEqual(["anchored", "derived"]);
  });
});
