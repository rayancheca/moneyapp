import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { KEPT_OPENING_SOURCE, balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { budgets } from "@/db/schema/budgets";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache } from "@/db/schema/holdings";
import { recurringSeries } from "@/db/schema/recurring";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { provenanceTriggerName, type PresentedVerdict } from "@/lib/provenance-verdict";
import { balanceLessNotes, type BalanceLessCounts } from "@/lib/statement-evidence-notes";
import { budgetCoverageSentence } from "@/lib/budget-coverage";
import { addManualAnchor } from "./anchors";
import { budgetPaceStatuses } from "./budgets";
import { createCashWallet } from "./cash-wallets";
import { addManualTransaction } from "./manual-transactions";
import { spendingReadThrough } from "./movers-card";
import { provenanceFor, weakestVerdict, type ProvenanceVerdict } from "./provenance";

/**
 * The service exists to answer "prove it" for a rendered figure, and its most
 * valuable answer is *"nothing checks this"*. These tests pin the honest
 * answers as hard as the confident ones — a figure that quietly reads
 * "verified" when nothing checks it is the failure mode worth preventing.
 */

let dir: string;
let bundle: DbBundle;
let institutionId: string;

const TODAY = "2026-08-05";

/** /imports' footer counts with nothing in them — each test names the one it reads (`balanceLessNotes`) */
const NO_COUNTS: BalanceLessCounts = {
  reportDocuments: 0,
  downloadDocuments: 0,
  recordedBalanceDocuments: 0,
  openingStatements: 0,
  firstStatements: 0,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-provenance-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

function addAccount(id: string, name: string, type: string): string {
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
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

function addDays(accountId: string, rows: { day: string; basis: string; cents?: number }[]): void {
  for (const r of rows) {
    bundle.db
      .insert(dailyBalances)
      .values({ accountId, day: r.day, balanceCents: r.cents ?? 1000, basis: r.basis as never })
      .run();
  }
}

let txnSeq = 0;
function addTxn(accountId: string, day: string, opts: { importFileId?: string; cents?: number } = {}): string {
  txnSeq += 1;
  const id = `txn-${txnSeq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      importFileId: opts.importFileId ?? null,
      postedOn: day,
      amountCents: opts.cents ?? -1234,
      rawDescription: "COFFEE",
      normalizedDescription: "COFFEE",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${txnSeq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

function addFile(id: string, fileName: string, profile: string): string {
  bundle.db
    .insert(importFiles)
    .values({
      id,
      fileName,
      fileSha256: `sha-${id}`,
      format: "pdf",
      institutionId,
      parserProfile: profile,
      parserVersion: 1,
      status: "parsed",
      storagePath: `/tmp/${fileName}`,
      importedAt: "2026-08-04T00:00:00.000Z",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

/**
 * ⛔ `balances` is a parameter because the fixture could not express the case
 * the Rocket Money test was written for. It always wrote `endingBalanceCents:
 * 1000`, so a period "carrying no balances" carried one — and the headline
 * branch that turns on it could not be told apart from the one that does.
 * Measured on the owner's ledger 2026-09-10: all 4 `not_applicable` periods
 * hold NULL balances, and all 202 `reconciled` and all 40 `value_anchor`
 * periods hold them.
 */
function addPeriod(
  id: string,
  accountId: string,
  importFileId: string,
  start: string,
  end: string,
  reconciliation: string,
  balances: { beginning: number | null; ending: number | null } = { beginning: 0, ending: 1000 },
): string {
  bundle.db
    .insert(statementPeriods)
    .values({
      id,
      importFileId,
      accountId,
      periodStart: start,
      periodEnd: end,
      beginningBalanceCents: balances.beginning,
      endingBalanceCents: balances.ending,
      reconciliation: reconciliation as never,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

function addAnchor(accountId: string, day: string, source: string, importFileId?: string): void {
  bundle.db
    .insert(balanceAnchors)
    .values({
      accountId,
      anchoredOn: day,
      balanceCents: 1000,
      source: source as never,
      importFileId: importFileId ?? null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/**
 * ⚖️ His decision 72 (2026-10-13): a total over days its accounts have not been imported through reads "partly read".
 * A test asking what a total's ROWS say reads its window in full: a statement closing on `day` carries the account's
 * import that far (`observationFrontier`). No balances — it checks nothing, so it moves no row's grade; the rows' own
 * documents are the only ones a total names. Rows on investment accounts, which no import dates, are read through the
 * LEDGER's day (`categoryReachFor`), so a checking account of the test's own carries it.
 */
function readThrough(accountId: string, day: string): void {
  const file = addFile(`read-${accountId}-${day}`, `read-${accountId}.pdf`, "chase-checking-statement-pdf");
  addPeriod(`read-${accountId}-${day}`, accountId, file, `${day.slice(0, 8)}01`, day, "not_applicable", {
    beginning: null,
    ending: null,
  });
}

/* ── the verdict lattice ──────────────────────────────────────────────── */

describe("weakestVerdict", () => {
  test("a total is only as proven as its weakest part", () => {
    expect(weakestVerdict(["sourced", "derived", "unverified"])).toBe("unverified");
    expect(weakestVerdict(["sourced", "broken"])).toBe("broken");
    expect(weakestVerdict(["derived", "derived"])).toBe("derived");
  });

  test("nothing at all is unknown, not proven", () => {
    expect(weakestVerdict([])).toBe("unknown");
  });

  test("broken outranks every other weakness", () => {
    const all: ProvenanceVerdict[] = ["sourced", "derived", "market_value", "manual", "counted", "unverified", "unknown", "broken"];
    expect(weakestVerdict(all)).toBe("broken");
  });
});

/* ── account balances ─────────────────────────────────────────────────── */

describe("provenanceFor — an account balance", () => {
  /**
   * ⛔ THE bug this service shipped with and had to be corrected for.
   * `deriveForward` writes `sawTxn ? "derived_unverified" : "carried"`, so
   * `carried` means NO transaction has happened since the last recorded
   * balance — the number is exactly as proven as the anchor it came from.
   * Today is almost always after the newest statement with nothing posted
   * since, so grading `carried` as weak made the first draft announce
   * "0 of 12 accounts add up" on a ledger with zero gap days.
   */
  test("carried is NOT weak — nothing happened, so the proven balance still stands", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "carried" },
    ]);
    addTxn(id, "2026-08-02");

    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-03" })!;
    expect(p.verdict).toBe("derived");
    expect(p.headline).toMatch(/no activity/i);
  });

  test("derived_unverified says plainly that nothing checks it", () => {
    const id = addAccount("a", "Robinhood Cash", "checking");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-02");

    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-02" })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toMatch(/nothing checks/i);
    // the rows are real even when the total is not confirmed — say both
    expect(p.headline).toMatch(/rows are real/i);
  });

  test("a gap day says money is provably missing, not that it is unverified", () => {
    const id = addAccount("a", "SoFi Checking", "checking");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
    ]);
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-02" })!;
    expect(p.verdict).toBe("broken");
    expect(p.headline).toMatch(/provably missing or double-counted/i);
  });

  /**
   * For an investment account `derived` is written by the price walk, not by a
   * transaction replay, and reconciliation stamps `value_anchor`
   * unconditionally — it cannot fail. Borrowing the cash vocabulary would paint
   * an account with NO arithmetic gate the same green as one that reconciles.
   */
  test("an investment balance is market value, never 'derived'", () => {
    const id = addAccount("a", "Robinhood Brokerage", "investment");
    addHoldingEvent(id, "AAPL", "stock", "2026-08-01", 100_000_000);
    addDays(id, [{ day: "2026-08-02", basis: "derived" }]);
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-02" })!;
    expect(p.verdict).toBe("market_value");
    expect(p.headline).toBe(
      "Robinhood Brokerage is priced from its holdings on Aug 2, 2026. A brokerage statement sets a value; it never proves the transactions add up.",
    );
    expect(p.badgeWord).toBeUndefined();
  });

  /**
   * 🔴 `derivesFromHoldings` is the rule, not the account type. An investment
   * account with no holding events takes value-anchor step-hold: its curve is
   * the balance recorded by hand or statement, held flat, and no holding prices
   * it. The headline said "priced from its holdings" of exactly that account,
   * while the remove-balance dialog on the same page — which reads the rule —
   * said "This balance is what verifies Brokerage on Sep 1 – 9, 2026". The
   * owner's ledger cannot show it (both investment accounts have events), but
   * AccountForm creates one: type investment, "Current balance (optional)".
   */
  test("an investment account with no holdings is held at its recorded balance, not priced from holdings", () => {
    const id = addAccount("a", "Brokerage", "investment");
    addAnchor(id, "2026-09-01", "manual");
    addDays(id, [
      { day: "2026-09-01", basis: "anchored" },
      { day: "2026-09-10", basis: "carried" },
    ]);

    const held = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-09-10" })!;
    expect(held.verdict).toBe("market_value");
    // ⚖️ a value he typed is one he counted — ONE verb for a balance he typed (his answer, 2026-10-05)
    expect(held.headline).toBe(
      "Brokerage's value on Sep 10, 2026 is the balance you counted on Sep 1, 2026, held forward. No holdings price it, and no transaction arithmetic checks it.",
    );
    // the badge keeps its word, and its accessible name stops asserting holdings
    expect(held.badgeWord).toBe("market value");

    const onTheDay = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-09-01" })!;
    expect(onTheDay.headline).toBe(
      "Brokerage's value on Sep 1, 2026 is the balance you counted that day. No holdings price it, and no transaction arithmetic checks it.",
    );
  });

  /**
   * 🔴 …and the date it named was the newest recorded balance of ANY source. A
   * bank export or a live reading is a moment: `deriveDailyRows` never holds one
   * forward while a statement or a balance he typed exists, and a live reading
   * stands only on the day the curve was rebuilt. Measured on a scratch database
   * (manual $700.00 on Sep 1, bank export $900.00 on Sep 5, rebuilt Sep 10): the
   * Sep 8 row is $700.00 `carried`, and the headline read "is the balance
   * recorded on Sep 5, 2026, held forward" — a figure the day does not carry.
   */
  test("the balance it names is the one the rebuild holds, never a later export or live reading", () => {
    const id = addAccount("a", "Retyped", "investment");
    addAnchor(id, "2026-09-01", "manual");
    addAnchor(id, "2026-09-05", "ofx_ledger");
    addAnchor(id, "2026-09-07", "live");
    addAnchor(id, "2026-09-10", "live");
    addDays(id, [
      { day: "2026-09-01", basis: "anchored" },
      { day: "2026-09-08", basis: "carried" },
      // rebuilt on Sep 10: that day's live reading stands for that day only
      { day: "2026-09-10", basis: "anchored" },
    ]);
    const headline = (day: string) =>
      provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day })!.headline;

    expect(headline("2026-09-08")).toBe(
      "Retyped's value on Sep 8, 2026 is the balance you counted on Sep 1, 2026, held forward. No holdings price it, and no transaction arithmetic checks it.",
    );
    expect(headline("2026-09-10")).toBe(
      "Retyped's value on Sep 10, 2026 is the balance recorded that day. No holdings price it, and no transaction arithmetic checks it.",
    );
  });

  test("an anchor names the document it came from", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "20260801-statements-3522-.pdf", "chase-checking-statement-pdf");
    addDays(id, [{ day: "2026-08-01", basis: "anchored" }]);
    addAnchor(id, "2026-08-01", "statement", file);

    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-01" })!;
    expect(p.verdict).toBe("sourced");
    expect(p.sources.map((s) => s.label)).toContain("20260801-statements-3522-.pdf");
  });

  /*
   * 🔴 A BALANCE TYPED BY HAND READ "ON A STATEMENT". `headlineForBalance` said
   * "A statement records <acct>'s balance on <day> directly. This is the number
   * the bank printed." of EVERY anchored day, and `BASIS_VERDICT` badged it
   * `sourced`, whichever document — or none — recorded it. Harmless while the
   * account page dated a hand-recorded balance by the rebuild day ("carried");
   * once an account observed only by recorded balances is dated by the day it
   * was recorded (S24), a checking account with one balance typed in on Sep 11
   * read "on a statement — A statement records Safe's balance on Sep 11, 2026
   * directly" (scratch measurement, 2026-09-16). This test only asked about
   * the source label, so the badge and the sentence could both be false.
   *
   * ⛔ Both halves together: fixing the sentence alone would put "You recorded
   * it" under a badge still reading "on a statement".
   *
   * ⚖️ …and the badge's verb is the sentence's (his answer 2026-10-07, §6A 50): a balance he typed is `counted` —
   * "you counted it" — never `manual`, whose "you entered it" is a row's.
   */
  test("a hand-entered anchor says the owner is the source — in the badge and the sentence", () => {
    const id = addAccount("a", "Cash on Hand", "cash");
    addDays(id, [{ day: "2026-08-01", basis: "anchored" }]);
    addAnchor(id, "2026-08-01", "manual");
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-01" })!;
    expect(p.sources).toContainEqual(
      expect.objectContaining({ label: "a balance you counted", detail: "balance counted on Aug 1, 2026" }),
    );
    expect(p.verdict).toBe("counted");
    expect(p.headline).not.toMatch(/A statement records|bank printed/);
    expect(p.headline).toContain("You counted Cash on Hand's balance on Aug 1, 2026");
  });

  test("a balance a bank export recorded is not said to be a statement's", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    addDays(id, [{ day: "2026-07-08", basis: "anchored" }]);
    addAnchor(id, "2026-07-08", "ofx_ledger", csv);
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-07-08" })!;
    expect(p.verdict).toBe("sourced");
    expect(p.headline).not.toMatch(/A statement records/);
    expect(p.headline).toContain("A bank export records Chase Checking's balance on Jul 8, 2026 directly");
    // ⚖️ "counted" is for a balance HE typed (his answer, 2026-10-05): a document's balance keeps its words
    expect(p.sources).toContainEqual(
      expect.objectContaining({ label: "Chase3522_Activity_20260710.CSV", detail: "balance recorded on Jul 8, 2026" }),
    );
  });

  test("a statement and a hand-typed balance on one day read as the statement the replay uses", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260801-statements-3522-.pdf", "chase-checking-statement-pdf");
    addDays(id, [{ day: "2026-08-01", basis: "anchored" }]);
    addAnchor(id, "2026-08-01", "statement", pdf);
    addAnchor(id, "2026-08-01", "manual");
    // the replay uses the statement over a hand-typed balance on the same day
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-01" })!;
    expect(p.verdict).toBe("sourced");
    expect(p.headline).toContain("A statement records Chase Checking's balance on Aug 1, 2026 directly");
  });

  test("an account with no derived balance says so rather than guessing", () => {
    const id = addAccount("a", "Wells Fargo Everyday Checking", "checking");
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id })!;
    expect(p.verdict).toBe("unknown");
    expect(p.sources).toEqual([]);
  });

  test("an account that does not exist is null — that is an absence, not a verdict", () => {
    expect(provenanceFor(bundle.db, { kind: "accountBalance", accountId: "nope" })).toBeNull();
  });
});

/* ── statement periods ────────────────────────────────────────────────── */

describe("provenanceFor — a statement period", () => {
  test("a reconciled period states the rule it passed and counts the rows behind it", () => {
    const id = addAccount("a", "Venture X", "credit");
    const file = addFile("f1", "venturex-2026-02.pdf", "capitalone-statement-pdf");
    const period = addPeriod("p1", id, file, "2026-01-12", "2026-02-11", "reconciled");
    addTxn(id, "2026-01-20", { importFileId: file });
    addTxn(id, "2026-02-01", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!;
    expect(p.verdict).toBe("sourced");
    expect(p.headline).toMatch(/2 rows were checked/);
    expect(p.checkedThrough).toBe("2026-02-11");
  });

  /**
   * `reconcileAccounts` stamps `value_anchor` unconditionally for investment
   * accounts and absorbs any discrepancy into `market_change_cents`. There is
   * no pass/fail. Saying "reconciled" here would be a lie of vocabulary.
   */
  test("a value_anchor period admits that no arithmetic here could fail", () => {
    const id = addAccount("a", "Robinhood Crypto", "investment");
    const file = addFile("f1", "rh-crypto-2025-11.pdf", "robinhood-crypto-statement-pdf");
    const period = addPeriod("p1", id, file, "2025-11-01", "2025-11-30", "value_anchor");

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!;
    expect(p.verdict).toBe("market_value");
    expect(p.headline).toMatch(/no arithmetic here that could fail/i);
    expect(p.checkedThrough).toBeNull();
  });

  test("a period with no balances says nothing can be checked against a total", () => {
    const id = addAccount("a", "Wells Fargo Everyday Checking", "checking");
    const file = addFile("f1", "rocket-money-export.csv", "rocket-money-csv");
    const period = addPeriod("p1", id, file, "2026-07-27", "2026-08-24", "not_applicable");

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toMatch(/carries no balances/i);
    expect(p.checkedThrough).toBeNull();
  });
});

/* ── an account's opening statement ───────────────────────────────────── */

/**
 * An account's OPENING statement is a statement (`countsAsStatement`): Robinhood printed `N/A` for its opening, so it
 * parses into a balance-less period exactly as a report does — but the file recorded its closing, and /imports'
 * footer names it "an account's first and printed no opening balance".
 *
 * 🔴 Measured on a copy of his ledger 2026-10-12: Robinhood Agentic's +$26.64 on Jun 5, 2026 — the one row on the
 * ledger from `747059b1-3904-3242-af2e-de66f2c94f5e.pdf` — opened a sheet whose headline read "…which recorded
 * Robinhood Agentic's balance on Jun 30, 2026 — but …" over a period line reading "2026-06-01 → 2026-06-30 |
 * coverage declared, but this file carries no balances to check against". The same PDF holds a reconciled Robinhood
 * Cash period. The period line read the state alone; the footer reads the schedule's rule.
 */
describe("provenanceFor — an account's opening statement", () => {
  const OPENING_LINE =
    "the account's first statement — it printed no opening balance, so nothing in it could have failed";
  const REPORT_LINE = "coverage declared, but this file carries no balances to check against";

  /** His ledger's shape: one Robinhood PDF, Robinhood Cash's June reconciled, Agentic's first printed `N/A`. */
  function agenticJune(): { agentic: string; file: string; period: string; txn: string } {
    const agentic = addAccount("ag", "Robinhood Agentic", "checking");
    const cash = addAccount("rc", "Robinhood Cash", "checking");
    const file = addFile("f1", "747059b1-3904-3242-af2e-de66f2c94f5e.pdf", "robinhood-brokerage-statement-pdf");
    addPeriod("p-cash", cash, file, "2026-06-01", "2026-06-30", "reconciled");
    const period = addPeriod("p-ag", agentic, file, "2026-06-01", "2026-06-30", "not_applicable", {
      beginning: null,
      ending: null,
    });
    addAnchor(agentic, "2026-06-30", "ofx_ledger", file);
    addDays(agentic, [
      { day: "2026-06-04", basis: "derived_unverified", cents: 0 },
      { day: "2026-06-05", basis: "derived_unverified", cents: 2664 },
      { day: "2026-06-30", basis: "anchored", cents: 2664 },
    ]);
    const txn = addTxn(agentic, "2026-06-05", { importFileId: file, cents: 2664 });
    return { agentic, file, period, txn };
  }

  const periodLine = (p: { sources: { kind: string; detail?: string }[] }) =>
    p.sources.filter((s) => s.kind === "period").map((s) => s.detail);

  test("🔴 a row's sheet names its period the account's first statement — not a file that carries no balances", () => {
    const { txn } = agenticJune();

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toContain("which recorded Robinhood Agentic's balance on Jun 30, 2026");
    expect(periodLine(p)).toEqual([OPENING_LINE]);
  });

  test("…and so does the account's balance on a day the statement covers", () => {
    const { agentic } = agenticJune();

    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: agentic, day: "2026-06-05" })!;
    expect(periodLine(p)).toEqual([OPENING_LINE]);
  });

  test("…and the period's own sheet (latent: /imports opens one only for a period that printed balances)", () => {
    const { period } = agenticJune();

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toBe(
      "This is Robinhood Agentic's first statement — it printed no opening balance, so nothing in it could have " +
        "failed.",
    );
    expect(p.headline).not.toMatch(/carries no balances/);
  });

  test("the footer on /imports and the sheet make the same claims of it", () => {
    const [footer] = balanceLessNotes({ ...NO_COUNTS, openingStatements: 1, firstStatements: 1 });
    for (const claim of ["first", "printed no opening balance", "nothing in it could have failed"]) {
      expect(footer).toContain(claim);
      expect(OPENING_LINE).toContain(claim);
    }
  });

  /*
   * 🔴 "The account's first statement" was said of every period the Robinhood parser left without an opening, and
   * nothing checked it — the parser knows only that the section printed `N/A`. Both of his are their accounts' first
   * (measured on a copy of his ledger 2026-10-13), so nothing he sees moves; a later statement that printed `N/A` is
   * a statement still, and its line and sheet say only that — as the footer does (`firstOnAccount`).
   */
  test("🔴 a statement that printed no opening after the account's first is never called its first", () => {
    const agentic = addAccount("ag", "Robinhood Agentic", "checking");
    const july = addFile("f-jul", "rh-2026-07.pdf", "robinhood-brokerage-statement-pdf");
    addPeriod("p-jul", agentic, july, "2026-07-01", "2026-07-31", "reconciled");
    const august = addFile("f-aug", "rh-2026-08.pdf", "robinhood-brokerage-statement-pdf");
    const period = addPeriod("p-aug", agentic, august, "2026-08-01", "2026-08-31", "not_applicable", {
      beginning: null,
      ending: null,
    });
    addDays(agentic, [{ day: "2026-08-05", basis: "derived_unverified", cents: 2664 }]);
    const txn = addTxn(agentic, "2026-08-05", { importFileId: august, cents: 2664 });

    const line = "a statement — it printed no opening balance, so nothing in it could have failed";
    expect(periodLine(provenanceFor(bundle.db, { kind: "transaction", id: txn })!)).toEqual([line]);
    expect(
      periodLine(provenanceFor(bundle.db, { kind: "accountBalance", accountId: agentic, day: "2026-08-05" })!),
    ).toEqual([line]);
    expect(provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!.headline).toBe(
      "This is a statement of Robinhood Agentic's — it printed no opening balance, so nothing in it could have " +
        "failed.",
    );
    const [footer] = balanceLessNotes({ ...NO_COUNTS, openingStatements: 1, firstStatements: 0 });
    for (const words of [line, footer]) expect(words).not.toMatch(/first|report|carries no balances/);
  });

  test("a spending report's period still carries no balances — the line reads the file's kind, not the state", () => {
    const id = addAccount("s", "Chase Sapphire", "credit");
    const file = addFile("f2", "Spending Report PDF (1).pdf", "chase-spending-report-pdf");
    const period = addPeriod("p-sr", id, file, "2026-01-01", "2026-07-10", "not_applicable", {
      beginning: null,
      ending: null,
    });
    addDays(id, [{ day: "2026-03-02", basis: "derived_unverified" }]);
    const txn = addTxn(id, "2026-03-02", { importFileId: file });

    const day = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-03-02" })!;
    expect(periodLine(provenanceFor(bundle.db, { kind: "transaction", id: txn })!)).toEqual([REPORT_LINE]);
    expect(periodLine(day)).toEqual([REPORT_LINE]);
    expect(provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!.headline).toMatch(/carries no balances/);
  });
});

/** The period line of a download the ledger keeps no balance of on the account (`download_no_balance`). */
const DOWNLOAD_LINE =
  "coverage declared — this download left the ledger no balance of its own on the account and printed no opening " +
  "one, so the period itself reconciles nothing";

/** The e2e fixture's shape: Chase Savings' Q3 2024 QFX, its Sep 30 LEDGERBAL re-recorded by the quarter's CSV. */
function savingsQ3(): { savings: string; period: string; txn: string } {
  const savings = addAccount("sav", "Chase Savings", "savings");
  const qfx = addFile("qfx", "Chase8721_Activity_2024-07-01_2024-09-30.QFX", "ofx-generic");
  const csv = addFile("csv", "Chase8721_Activity_2024-07-01_2024-09-30.CSV", "chase-deposit-csv");
  const period = addPeriod("p-qfx", savings, qfx, "2024-07-01", "2024-09-30", "not_applicable", {
    beginning: null,
    ending: null,
  });
  addAnchor(savings, "2024-09-30", "ofx_ledger", csv);
  addDays(savings, [{ day: "2024-09-30", basis: "anchored" }]);
  const txn = addTxn(savings, "2024-09-30", { importFileId: qfx });
  return { savings, period, txn };
}

/* ── a download that recorded a balance but no opening one ────────────── */

/**
 * An OFX/QFX download declares the days it covers (DTSTART/DTEND) and records the account's balance (LEDGERBAL) as an
 * `ofx_ledger` anchor of the same file — but prints no opening one, so its period is `not_applicable`, the state a
 * Spending Report parses into.
 *
 * 🔴 The review of 601f155, on a copy of data/e2e.db (2026-10-12; 18 of its 27 balance-less periods): Chase Freedom
 * Unlimited's balance on Sep 30, 2024 listed "Chase1111_Activity_2024-07-01_2024-09-30.QFX — balance recorded on Sep
 * 30, 2024" over "2024-07-01 → 2024-09-30 — coverage declared, but this file carries no balances to check against",
 * and a row's sheet from that file read "…which recorded Chase Freedom Unlimited's balance on Sep 30, 2024, and …" over
 * the same line. 601f155 fixed this contradiction for Robinhood Agentic's opening statement by the parser; this is the
 * same one, and the line now reads what the file recorded (`balanceLessKind`). Not reachable on his ledger today — its
 * three report documents own no balance — until he imports a Chase QFX download.
 */
describe("provenanceFor — a download that recorded a balance but no opening one", () => {
  const RECORDED_LINE =
    "coverage declared, and this file recorded the account's balance on Sep 30, 2024 — but no opening one, so the " +
    "period itself reconciles nothing";
  const REPORT_LINE = "coverage declared, but this file carries no balances to check against";

  /** The fixture's shape: one quarter's QFX for Chase Freedom Unlimited, its Sep 30 balance an anchor of the file. */
  function freedomQ3(): { freedom: string; file: string; period: string; txn: string } {
    const freedom = addAccount("cfu", "Chase Freedom Unlimited", "credit");
    const file = addFile("q3", "Chase1111_Activity_2024-07-01_2024-09-30.QFX", "ofx-generic");
    const period = addPeriod("p-q3", freedom, file, "2024-07-01", "2024-09-30", "not_applicable", {
      beginning: null,
      ending: null,
    });
    addAnchor(freedom, "2024-09-30", "ofx_ledger", file);
    addDays(freedom, [
      { day: "2024-09-29", basis: "derived" },
      { day: "2024-09-30", basis: "anchored" },
    ]);
    const txn = addTxn(freedom, "2024-09-29", { importFileId: file });
    return { freedom, file, period, txn };
  }

  const periodLine = (p: { sources: { kind: string; detail?: string }[] }) =>
    p.sources.filter((s) => s.kind === "period").map((s) => s.detail);

  test("🔴 a row's sheet: the period line says what the headline says — the file recorded the balance", () => {
    const { txn } = freedomQ3();

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toContain("which recorded Chase Freedom Unlimited's balance on Sep 30, 2024");
    expect(periodLine(p)).toEqual([RECORDED_LINE]);
  });

  test("…and the account's balance on a day the download covers, under that file's recorded balance", () => {
    const { freedom } = freedomQ3();

    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: freedom, day: "2024-09-30" })!;
    expect(p.sources[0]).toMatchObject({
      kind: "anchor",
      label: "Chase1111_Activity_2024-07-01_2024-09-30.QFX",
      detail: "balance recorded on Sep 30, 2024",
    });
    expect(periodLine(p)).toEqual([RECORDED_LINE]);
  });

  test("…and the period's own sheet (latent: /imports opens one only for a period that printed balances)", () => {
    const { period } = freedomQ3();

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toBe(
      "This file declares which days it covers and recorded Chase Freedom Unlimited's balance on Sep 30, 2024 — but " +
        "no opening one, so the period itself reconciles nothing.",
    );
  });

  test("the footer on /imports and the sheet make the same claims of it", () => {
    const [footer] = balanceLessNotes({ ...NO_COUNTS, recordedBalanceDocuments: 1 });
    for (const claim of ["recorded", "balance", "no opening one", "reconcile"]) {
      expect(footer).toContain(claim);
      expect(RECORDED_LINE).toContain(claim);
    }
  });

  test("⛔ an opening it keeps for a statement he un-imported is no balance it recorded (`kept-openings`)", () => {
    const freedom = addAccount("cfu", "Chase Freedom Unlimited", "credit");
    const file = addFile("q3", "Chase1111_Activity_2024-07-01_2024-09-30.QFX", "ofx-generic");
    const period = addPeriod("p-q3", freedom, file, "2024-07-01", "2024-09-30", "not_applicable", {
      beginning: null,
      ending: null,
    });
    addAnchor(freedom, "2024-06-30", KEPT_OPENING_SOURCE, file);
    addDays(freedom, [{ day: "2024-07-02", basis: "derived_unverified" }]);
    const txn = addTxn(freedom, "2024-07-02", { importFileId: file });

    // a download still, and one the ledger keeps no balance of on the account (`download_no_balance`)
    expect(periodLine(provenanceFor(bundle.db, { kind: "transaction", id: txn })!)).toEqual([DOWNLOAD_LINE]);
    const sheet = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!.headline;
    expect(sheet).toContain("left the ledger no balance of its own on Chase Freedom Unlimited");
    expect(sheet).not.toMatch(/recorded|carries no balances/);
  });

  /**
   * ⛔ ONE rule with the row's own headline (`rowHeadline`, S31), which has always read a file's balance from the
   * anchors it owns: whatever the sheet says the file recorded, its period line says too — for a balance another file
   * took over that day, the next block.
   */
  test("the period line and the row's headline read one rule, for a balance another file took over that day", () => {
    const { txn } = savingsQ3();

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).not.toContain("which recorded Chase Savings's balance");
    expect(periodLine(p)).toEqual([DOWNLOAD_LINE]);
  });
});

/* ── a download the ledger keeps no balance of ────────────────────────── */

/**
 * The ledger keeps ONE `ofx_ledger` balance per account and day, owned by the file that wrote it last (⚖️ anchor
 * ownership as shipped, handoff 2026-10-13 §6A): a QFX download whose LEDGERBAL its quarter's CSV re-recorded owns no
 * balance on the account, though it printed one.
 *
 * 🔴 74f25fb stopped /imports' footer calling these "a spending report, an export without a closing figure" — "9
 * imported downloads left the ledger no balance of their own and printed no opening one, …" — by reading the parser
 * beside `balanceLessKind`, and left every sheet on the kind, which still named them as files that carry none.
 * Measured on a copy of data/e2e.db 2026-10-14: Chase8721_Activity_2026-04-01_2026-06-30.QFX's period sheet read "This
 * file declares which days it covers but carries no balances, so nothing in it can be checked against a total."; the
 * period line on its Apr 2 row's sheet and on Chase Savings' Apr 2 balance sheet, "coverage declared, but this file
 * carries no balances to check against"; the row's own headline, "That file carries no balances of its own, but Chase
 * Savings's chain closes across this day." The file holds a <LEDGERBAL>. Not reachable on his ledger (it holds no OFX
 * or QFX file, measured on a copy 2026-10-14); it is the day he imports a Chase QFX beside the same quarter's CSV.
 */
describe("provenanceFor — a download the ledger keeps no balance of", () => {
  const REPORT_LINE = "coverage declared, but this file carries no balances to check against";
  const periodLine = (p: { sources: { kind: string; detail?: string }[] }) =>
    p.sources.filter((s) => s.kind === "period").map((s) => s.detail);

  test("🔴 a row's sheet on a day the quarter's CSV anchors: the headline and the period line name a download", () => {
    const { txn } = savingsQ3();

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toBe(
      "This row came from Chase8721_Activity_2024-07-01_2024-09-30.QFX, which left the ledger no balance of its own on " +
        "Chase Savings — but Chase Savings's balance on this day was recorded by " +
        "Chase8721_Activity_2024-07-01_2024-09-30.CSV, so the total it sits in is checked.",
    );
    expect(periodLine(p)).toEqual([DOWNLOAD_LINE]);
  });

  /**
   * The measured row's shape (e2e copy, 2026-10-14): Chase Savings' Q2 2026 QFX, its Jun 30 LEDGERBAL re-recorded by
   * the quarter's CSV, so the download owns no balance on the account; `days` are the account's chain around the row.
   */
  function savingsQ2(days: { day: string; basis: string }[]): { savings: string; qfx: string } {
    const savings = addAccount("sav", "Chase Savings", "savings");
    const qfx = addFile("qfx", "Chase8721_Activity_2026-04-01_2026-06-30.QFX", "ofx-generic");
    const csv = addFile("csv", "Chase8721_Activity_2026-04-01_2026-06-30.CSV", "chase-deposit-csv");
    addPeriod("p-qfx", savings, qfx, "2026-04-01", "2026-06-30", "not_applicable", { beginning: null, ending: null });
    addAnchor(savings, "2026-06-30", "ofx_ledger", csv);
    addDays(savings, days);
    return { savings, qfx };
  }

  /*
   * 🔴 The review of 3135bb0: the tests above pinned the anchored-day branch and the fallthrough, and the sentence this
   * block quotes as the defect — the derived-day branch, which 18 of the e2e copy's 27 reworded row headlines take —
   * had none: "carries no balances of its own" put back there, or at the broken or counted-by-you branch, left every
   * test green. Measured on a copy of data/e2e.db 2026-10-14, txn 01a13653-a740-7002-ae1a-63b4a862c536 on Apr 2,
   * 2026 (a `derived` day): the sentence below. Each of the three below fails with the old words at its branch.
   */
  test("🔴 …on a day the chain closes across: the sentence measured as the defect", () => {
    const { savings, qfx } = savingsQ2([
      { day: "2026-03-31", basis: "anchored" },
      { day: "2026-04-01", basis: "derived" },
      { day: "2026-04-02", basis: "derived" },
    ]);
    const txn = addTxn(savings, "2026-04-02", { importFileId: qfx });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("derived");
    expect(p.headline).toBe(
      "This row came from Chase8721_Activity_2026-04-01_2026-06-30.QFX. That file left the ledger no balance of its " +
        "own on Chase Savings, but Chase Savings's chain closes across this day.",
    );
    expect(periodLine(p)).toEqual([DOWNLOAD_LINE]);
  });

  test("…on a day after the chain broke", () => {
    const { savings, qfx } = savingsQ2([
      { day: "2026-04-01", basis: "anchored" },
      { day: "2026-04-02", basis: "gap" },
      { day: "2026-04-03", basis: "anchored" },
      { day: "2026-04-04", basis: "derived" },
    ]);
    const txn = addTxn(savings, "2026-04-04", { importFileId: qfx });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("broken");
    expect(p.headline).toBe(
      "This row came from Chase8721_Activity_2026-04-01_2026-06-30.QFX, which left the ledger no balance of its own " +
        "on Chase Savings — but Chase Savings's balance stopped adding up on Apr 2, 2026, so nothing checks the total " +
        "it sits in.",
    );
  });

  test("…on a day only his count anchors", () => {
    const { savings, qfx } = savingsQ2([{ day: "2026-04-02", basis: "anchored" }]);
    addAnchor(savings, "2026-04-02", "manual");
    const txn = addTxn(savings, "2026-04-02", { importFileId: qfx });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toBe(
      "This row came from Chase8721_Activity_2026-04-01_2026-06-30.QFX, which left the ledger no balance of its own " +
        "on Chase Savings — Chase Savings's balance on this day was counted by you, and nothing else confirms it, so " +
        "nothing checks the total it sits in.",
    );
  });

  test("…on a day nothing checks, too", () => {
    const savings = addAccount("sav", "Chase Savings", "savings");
    const qfx = addFile("qfx", "Chase8721_Activity_2024-07-01_2024-09-30.QFX", "ofx-generic");
    addPeriod("p-qfx", savings, qfx, "2024-07-01", "2024-09-30", "not_applicable", { beginning: null, ending: null });
    const txn = addTxn(savings, "2024-08-15", { importFileId: qfx });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toBe(
      "This row came from Chase8721_Activity_2024-07-01_2024-09-30.QFX — which left the ledger no balance of its own " +
        "on Chase Savings, so nothing checks the total it sits in.",
    );
    expect(periodLine(p)).toEqual([DOWNLOAD_LINE]);
  });

  test("…and the account's balance on a day the download covers", () => {
    const { savings } = savingsQ3();

    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: savings, day: "2024-09-30" })!;
    expect(periodLine(p)).toEqual([DOWNLOAD_LINE]);
  });

  test("…and the period's own sheet (latent: /imports opens one only for a period that printed balances)", () => {
    const { period } = savingsQ3();

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toBe(
      "This download declares which days it covers but left the ledger no balance of its own on Chase Savings and " +
        "printed no opening one, so the period itself reconciles nothing.",
    );
  });

  test("the footer on /imports and the sheets make the same claims of it", () => {
    const { period, txn } = savingsQ3();
    const [footer] = balanceLessNotes({ ...NO_COUNTS, downloadDocuments: 1 });
    const periodSheet = provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!.headline;
    const rowSheet = provenanceFor(bundle.db, { kind: "transaction", id: txn })!.headline;
    for (const claim of ["download", "left the ledger no balance of", "printed no opening one", "reconcile"]) {
      for (const words of [footer, periodSheet, DOWNLOAD_LINE]) expect(words).toContain(claim);
    }
    for (const words of [footer, periodSheet, rowSheet, DOWNLOAD_LINE]) {
      expect(words).not.toMatch(/carries no balances|carried no balance|report|export/);
    }
  });

  test("a report beside it keeps its words — the kind reads the parser, not the state", () => {
    const sapphire = addAccount("s", "Chase Sapphire", "credit");
    const file = addFile("f2", "Spending Report PDF (1).pdf", "chase-spending-report-pdf");
    const period = addPeriod("p-r", sapphire, file, "2026-01-01", "2026-07-10", "not_applicable", {
      beginning: null,
      ending: null,
    });
    const txn = addTxn(sapphire, "2026-03-01", { importFileId: file });

    const row = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(row.headline).toContain("carries no balances");
    expect(periodLine(row)).toEqual([REPORT_LINE]);
    expect(provenanceFor(bundle.db, { kind: "statementPeriod", id: period })!.headline).toMatch(/carries no balances/);
  });
});

/* ── transactions ─────────────────────────────────────────────────────── */

describe("provenanceFor — a transaction", () => {
  test("a row names the file it came from and the parser that read it", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "20260801-statements-3522-.pdf", "chase-checking-statement-pdf");
    addPeriod("p1", id, file, "2026-07-01", "2026-08-01", "reconciled");
    const txn = addTxn(id, "2026-07-15", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("sourced");
    expect(p.headline).toMatch(/reconcile to the cent/i);
    expect(p.sources[0]!.detail).toMatch(/chase-checking-statement-pdf/);
    expect(p.checkedThrough).toBe("2026-08-01");
  });

  test("an investment statement records a value — it does not carry no balances", () => {
    /*
     * 🔴 The headline read "which carries no balances, so nothing checks the
     * total it sits in" off `reconciled` alone. An INVESTMENT statement sets a
     * value and is never reconciled by arithmetic, so its rows took that
     * branch — while the same call's own source line says the opposite: "value
     * recorded — an investment statement sets a value, it never proves the
     * rows add up". Measured 2026-09-10 on a Robinhood row whose period holds
     * beginning_balance 150500 and ending_balance 348049.
     */
    const id = addAccount("a", "Robinhood Brokerage", "brokerage");
    const file = addFile("f1", "robinhood-2026-07.pdf", "robinhood-statement-pdf");
    addPeriod("p1", id, file, "2026-07-01", "2026-07-31", "value_anchor", {
      beginning: 150_500,
      ending: 348_049,
    });
    const txn = addTxn(id, "2026-07-15", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toContain("records a value for Robinhood Brokerage");
    expect(p.headline).not.toContain("carries no balances");
  });

  test("a file with no balances at all still says so", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "rocket-money-export.csv", "rocket-money-csv");
    addPeriod("p1", id, file, "2026-07-01", "2026-07-31", "not_applicable", {
      beginning: null,
      ending: null,
    });
    const txn = addTxn(id, "2026-07-15", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toContain("carries no balances");
  });

  test("a hand-entered row says the owner is the only source", () => {
    const id = addAccount("a", "Cash on Hand", "cash");
    const txn = addTxn(id, "2026-07-15");
    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("manual");
    expect(p.headline).toMatch(/entered this row by hand/i);
    expect(p.checkedThrough).toBeNull();
  });

  /**
   * ⛔ A row is NOT proven merely because a file carried it. This shipped as
   * `sourced` and put a green "on a statement" badge on a row from the Rocket
   * Money export — a third-party re-export carrying no balances, the least
   * trustworthy source in the app. Caught by opening the sheet and reading it,
   * not by any assertion that existed at the time.
   */
  test("a row from a file that carries no balances does not read as proven", () => {
    const id = addAccount("a", "Wells Fargo Everyday Checking", "checking");
    const file = addFile("f1", "rocket-money-export.csv", "rocket-money-csv");
    // the real export carries none — all 4 `not_applicable` periods on the
    // owner's ledger hold NULL balances
    addPeriod("p1", id, file, "2026-07-27", "2026-08-24", "not_applicable", {
      beginning: null,
      ending: null,
    });
    const txn = addTxn(id, "2026-08-03", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).not.toBe("sourced");
    expect(p.headline).toMatch(/nothing checks the total it sits in/i);
    expect(p.checkedThrough).toBeNull();
  });

  /**
   * The other arbiter. A CSV import supplies its running balance as an ANCHOR
   * and creates NO statement period, so judging by periods alone would call
   * every CSV-imported row unchecked — while the anchor chain closes on it
   * exactly. `accountCoverage` has always counted both; so must this.
   */
  test("a row with no period is still proven when the anchor chain closes on its day", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "Chase3522_Activity.CSV", "chase-deposit-csv");
    addDays(id, [
      { day: "2026-07-14", basis: "anchored" },
      { day: "2026-07-15", basis: "derived" },
    ]);
    const txn = addTxn(id, "2026-07-15", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("derived");
    expect(p.headline).toMatch(/chain closes across this day/i);
  });

  /*
   * 🔴 S31: "carries no balances" was read off the file's statement PERIOD
   * alone, and a CSV creates no period — it records its running balance as an
   * `ofx_ledger` ANCHOR instead. Measured 2026-09-14:
   * `Chase3522_Activity_20260710.CSV` owns a balance_anchors row (2026-07-08,
   * $1,120.90) that `/accounts/<Chase Checking>` lists under Balances as
   * "bank export", while 1,078 of its rows said "That file carries no balances
   * of its own".
   *
   * ⚠️ The test above keeps a CSV with NO anchor, and must keep its sentence.
   */
  test("a file that recorded the account's balance is not said to carry none", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    addAnchor(id, "2026-07-08", "ofx_ledger", csv);
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-15", basis: "derived" },
    ]);
    const txn = addTxn(id, "2026-07-15", { importFileId: csv });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).not.toMatch(/carries no balances/i);
    expect(p.headline).toContain("recorded Chase Checking's balance on Jul 8, 2026");
    expect(p.headline).toMatch(/chain closes across this day/i);
    expect(p.verdict).toBe("derived");
  });

  /*
   * 🔴 S19: an ANCHORED day with no reconciled period for the row's own file
   * fell through to "which carries no balances, so nothing checks the total it
   * sits in" — under a green "on a statement" badge, because the day's basis
   * graded it `sourced`. Measured 2026-09-14 on 177 rows, every one of them
   * anchored by a DIFFERENT document than the one that carried the row: the FPL
   * row from `Chase3522_Activity_20260710.CSV` read exactly that.
   *
   * ⛔ The badge is the owner's decision (2026-09-14, option a): "adds up", the
   * grade `summedRowsProvenance` already gives this row inside every category,
   * merchant and spending total — the row did not come from a statement, and
   * the sheet and a total over the same row disagreed. The DAY still reads
   * anchored.
   *
   * ⚠️ The anchor must come from a different file than the row. Every earlier
   * test put the anchored-day case on the row's own reconciled statement, which
   * is why this branch was never reached.
   */
  test("a row on a day another statement anchors names that statement and grades as it would inside a total", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    const pdf = addFile("f2", "20260710-statements-3522-.pdf", "chase-checking-statement-pdf");
    addPeriod("p2", id, pdf, "2026-06-11", "2026-07-10", "reconciled");
    addAnchor(id, "2026-07-10", "statement", pdf);
    addDays(id, [{ day: "2026-07-10", basis: "anchored" }]);
    const txn = addTxn(id, "2026-07-10", { importFileId: csv });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).not.toMatch(/nothing checks the total/i);
    expect(p.headline).toContain("20260710-statements-3522-.pdf");
    expect(p.sources.some((s) => s.kind === "anchor" && s.label === "20260710-statements-3522-.pdf")).toBe(true);
    expect(p.checkedThrough).toBe("2026-07-10");
    expect(p.verdict).toBe("derived");
    expect(p.inputs[0]!.verdict).toBe("sourced");
  });

  /*
   * 🔴 THIS TEST PINNED THE DEFECT. It read "a day only a balance you entered
   * anchors is checked by that balance" and asserted "adds up" and "so the total
   * it sits in is checked" — of a row whose only neighbour is a balance he typed,
   * with nothing replayed onto it. A count is not a check (2026-09-16: Cash on
   * Hand's typed Aug 3 balance read "closes to the cent" and "Checked through").
   * The row now grades as a total over it does — nothing checks it — and the
   * day's own line wears the owner's word, not the statement's.
   */
  test("a day only a balance you entered anchors is named as yours, and checks nothing", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity.CSV", "chase-deposit-csv");
    addAnchor(id, "2026-07-10", "manual");
    addDays(id, [{ day: "2026-07-10", basis: "anchored" }]);
    const txn = addTxn(id, "2026-07-10", { importFileId: csv });

    const { sheet, total } = sheetAndTotal(txn, "2026-07-10");
    expect(sheet.verdict).toBe(total.verdict);
    expect(sheet.verdict).toBe("unverified");
    expect(sheet.headline).toBe(
      "This row came from Chase3522_Activity.CSV, which carries no balances of its own — Chase Checking's balance on this day was counted by you, and nothing else confirms it, so nothing checks the total it sits in.",
    );
    expect(sheet.checkedThrough).toBeNull();
    // the day's balance is his count, never "on a statement" — and never a row's "you entered it" (§6A 50)
    expect(sheet.inputs[0]!.verdict).toBe("counted");
  });

  /*
   * 🔴 S19, A COPY OF THE RULE RATHER THAN THE RULE. The anchored-day branch
   * above hard-coded "adds up" (`sourced` → `derived`) and always said "so the
   * total it sits in is checked", on the premise that `summedRowsProvenance`
   * grades the same row `derived`. That premise holds only while the account's
   * `verifiedThrough` reaches the row. On an anchored day AFTER a gap, or after
   * a run nothing checked, the sheet read "adds up … checked through Jul 10"
   * while a total holding only that row read "broken" / "unverified" and "0 of
   * 1 checked" (review of uc/provenance-main, 2026-09-15; not live on the real
   * ledger, where no account has a gap day).
   *
   * ⛔ The owner's decision (S19 a, 2026-09-14) is the grade the TOTAL gives —
   * so each case below asks the total and the sheet the same question.
   */
  function sheetAndTotal(txn: string, day: string) {
    const cat = addCategory("c-one-row", "Fixture One Row");
    categorize(txn, cat);
    return {
      sheet: provenanceFor(bundle.db, { kind: "transaction", id: txn })!,
      total: provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: day, to: day })!,
    };
  }

  test("an anchored day after a gap is broken on the sheet, as in a total over that row", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    const pdf = addFile("f2", "20260710-statements-3522-.pdf", "chase-checking-statement-pdf");
    addPeriod("p2", id, pdf, "2026-06-11", "2026-07-10", "reconciled");
    addAnchor(id, "2026-07-10", "statement", pdf);
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-02", basis: "gap" },
      { day: "2026-07-10", basis: "anchored" },
    ]);
    const txn = addTxn(id, "2026-07-10", { importFileId: csv });

    const { sheet, total } = sheetAndTotal(txn, "2026-07-10");
    expect(total.verdict).toBe("broken");
    expect(sheet.verdict).toBe(total.verdict);
    expect(sheet.headline).not.toMatch(/is checked/);
    expect(sheet.headline).toContain("stopped adding up on Jul 2, 2026");
    expect(sheet.checkedThrough).toBeNull();
    // the day keeps its own verdict, and the document that anchors it is still listed
    expect(sheet.inputs[0]!.verdict).toBe("sourced");
    expect(sheet.sources.some((s) => s.kind === "anchor" && s.label === "20260710-statements-3522-.pdf")).toBe(true);
  });

  test("an anchored day after a run nothing checked is unverified on the sheet, as in a total over that row", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    addAnchor(id, "2026-07-10", "live");
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-03", basis: "derived_unverified" },
      { day: "2026-07-10", basis: "anchored" },
    ]);
    const txn = addTxn(id, "2026-07-10", { importFileId: csv });

    const { sheet, total } = sheetAndTotal(txn, "2026-07-10");
    expect(total.verdict).toBe("unverified");
    expect(sheet.verdict).toBe(total.verdict);
    expect(sheet.headline).not.toMatch(/is checked/);
    expect(sheet.headline).toMatch(/nothing checks the total it sits in/);
    expect(sheet.checkedThrough).toBeNull();
  });

  test("a derived day after a gap is graded the way a total grades it, not by the day alone", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity.CSV", "chase-deposit-csv");
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-02", basis: "gap" },
      { day: "2026-07-03", basis: "anchored" },
      { day: "2026-07-04", basis: "derived" },
    ]);
    const txn = addTxn(id, "2026-07-04", { importFileId: csv });

    const { sheet, total } = sheetAndTotal(txn, "2026-07-04");
    expect(sheet.verdict).toBe(total.verdict);
    expect(sheet.verdict).toBe("broken");
    expect(sheet.headline).toContain("stopped adding up on Jul 2, 2026");
    expect(sheet.headline).not.toMatch(/chain closes across this day/);
  });

  /*
   * 🔴 S31 AT THE OTHER END. The derived and anchored branches ask whether the
   * row's own file recorded a balance; the last branch did not, and told a row
   * from `Chase3522_Activity_20260710.CSV` — which records Chase Checking's
   * balance on Jul 8 — that its file "carries no balances". Reachable on the
   * real ledger's shape (that CSV carries rows dated after Jul 8); not live on
   * 2026-09-15 only because a later statement anchors those days.
   */
  test("an unchecked day does not say the file that recorded a balance carries none", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    addAnchor(id, "2026-07-08", "ofx_ledger", csv);
    addDays(id, [
      { day: "2026-07-08", basis: "anchored" },
      { day: "2026-07-09", basis: "derived_unverified" },
    ]);
    const txn = addTxn(id, "2026-07-09", { importFileId: csv });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).not.toMatch(/carries no balances/);
    expect(p.headline).toContain("recorded Chase Checking's balance on Jul 8, 2026");
    expect(p.headline).toMatch(/nothing checks the total it sits in/);
  });

  /*
   * ⛔ Two guards 8013a5b added that no test could make fail (mutation-tested on
   * review, 2026-09-15): reversing the same-day rows instead of `pickWinners`,
   * and dropping "only a reconciled period earns a checked-through date", each
   * left the whole file green. Same-day ties are live on the real ledger —
   * Robinhood Cash on 2023-12-31 (ofx_ledger + statement).
   */
  test("among balances recorded on one day, the sheet names the one the replay uses", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const rocket = addFile("f0", "rocket-money-export.csv", "rocket-money-csv");
    const csv = addFile("f1", "Chase3522_Activity_20260710.CSV", "chase-deposit-csv");
    const pdf = addFile("f2", "20260710-statements-3522-.pdf", "chase-checking-statement-pdf");
    // neither insertion order nor its reverse puts the statement first
    addAnchor(id, "2026-07-10", "manual");
    addAnchor(id, "2026-07-10", "statement", pdf);
    addAnchor(id, "2026-07-10", "ofx_ledger", csv);
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "anchored" },
    ]);
    const txn = addTxn(id, "2026-07-10", { importFileId: rocket });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.headline).toContain("was recorded by 20260710-statements-3522-.pdf");
    expect(p.sources.filter((s) => s.kind === "anchor").map((s) => s.label)).toEqual(["20260710-statements-3522-.pdf"]);
  });

  /*
   * ⚖️ ONE verb for a balance he typed (his answer, 2026-10-05): "counted", net worth's ("you counted it on …").
   * This branch said his count "was recorded by you" — the word a document's balance wears on the same sheet.
   */
  test("a day his count anchors, that a replay from a statement landed on, names it counted — and checked", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260731-statements-3522-.pdf", "chase-checking-statement-pdf");
    const csv = addFile("f2", "wallet-export.csv", "generic-csv");
    addAnchor(id, "2026-07-31", "statement", pdf);
    addAnchor(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-07-31", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
    ]);
    const txn = addTxn(id, "2026-08-03", { importFileId: csv });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("derived");
    expect(p.headline).toBe(
      "This row came from wallet-export.csv, which carries no balances of its own — but Chase Checking's balance on this day was counted by you, so the total it sits in is checked.",
    );
  });

  test("a period covering the day that reconciled nothing earns no checked-through date", () => {
    const id = addAccount("a", "Chase Checking", "checking");
    const csv = addFile("f1", "Chase3522_Activity.CSV", "chase-deposit-csv");
    const rocket = addFile("f2", "rocket-money-export.csv", "rocket-money-csv");
    addPeriod("p1", id, rocket, "2026-07-01", "2026-07-31", "not_applicable", { beginning: null, ending: null });
    addAnchor(id, "2026-07-10", "manual");
    // the replay lands on his Jul 10 balance, so the arithmetic — not the balance — checks the day
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-09", basis: "derived" },
      { day: "2026-07-10", basis: "anchored" },
    ]);
    const txn = addTxn(id, "2026-07-10", { importFileId: csv });

    const p = provenanceFor(bundle.db, { kind: "transaction", id: txn })!;
    expect(p.verdict).toBe("derived");
    expect(p.checkedThrough).toBeNull();
  });

  test("a row that does not exist is null", () => {
    expect(provenanceFor(bundle.db, { kind: "transaction", id: "nope" })).toBeNull();
  });
});

/* ── an account's rows ────────────────────────────────────────────────── */

/**
 * S33 — "N transactions landed in X" is a claim about an account's ROWS, and it
 * was proven with the account's BALANCE. This kind grades the rows exactly as a
 * category or merchant total grades its own.
 */
describe("provenanceFor — an account's rows", () => {
  test("grades each row against the account's chain, so one row past it is unchecked", () => {
    const id = addAccount("a", "Robinhood Cash", "checking");
    const file = addFile("f1", "robinhood-cash.pdf", "robinhood-statement-pdf");
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-02", { importFileId: file });
    addTxn(id, "2026-08-03", { importFileId: file });

    const p = provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("1 of 2 checked");
    expect(p.headline).toMatch(/sum of 2 rows from 1 document/);
    expect(p.sources.map((s) => s.label)).toContain("robinhood-cash.pdf");
    expect(p.checkedThrough).toBe("2026-08-02");
  });

  /*
   * 🔴 PREHISTORY WAS COUNTED AS CHECKED. `gradeRow` called any row on or before
   * `verifiedThrough` checked, and `accountCoverage` deliberately does not treat
   * the days before an account's first recorded balance as a break — so those
   * rows passed. Measured 2026-09-15 on the real ledger: `/accounts/<Robinhood
   * Cash>` read "2,387 of 2,392 checked" while two of the 2,387 — the Dec 6 and
   * Dec 7, 2023 rows, before its first recorded balance on Dec 31 — each read
   * "nothing checks the total it sits in" on their own sheet. The badge and the
   * sheet disagreed about the same two rows; the sheet was right.
   */
  test("a row before the account's first recorded balance is unchecked — in the count and on its own sheet", () => {
    const id = addAccount("a", "Robinhood Cash", "checking");
    const csv = addFile("f1", "3ab6c2a8-5f00-5de8-b339-c3e514d5b7a7.csv", "robinhood-csv");
    addDays(id, [
      { day: "2023-12-05", basis: "derived_unverified" },
      { day: "2023-12-07", basis: "derived_unverified" },
      { day: "2023-12-31", basis: "anchored" },
      { day: "2024-01-10", basis: "derived" },
    ]);
    const early = addTxn(id, "2023-12-07", { importFileId: csv });
    addTxn(id, "2024-01-10", { importFileId: csv });

    const count = provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!;
    expect(count.verdict).toBe("unverified");
    expect(count.badgeWord).toBe("1 of 2 checked");
    expect(provenanceFor(bundle.db, { kind: "transaction", id: early })!.verdict).toBe("unverified");
  });

  test("rows you entered by hand read as yours, one rule with every other total", () => {
    const id = addAccount("a", "Cash on Hand", "cash");
    addTxn(id, "2026-08-11");
    expect(provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!.verdict).toBe("manual");
  });

  test("an account with no rows has nothing to stand on — never a measured zero", () => {
    const id = addAccount("a", "Capital One 360 Checking", "checking");
    const p = provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!;
    expect(p.verdict).toBe("unknown");
    expect(p.headline).not.toMatch(/zero rather than unproven/);
    expect(p.checkedThrough).toBeNull();
  });

  test("an account that does not exist is null", () => {
    expect(provenanceFor(bundle.db, { kind: "accountRows", accountId: "nope" })).toBeNull();
  });
});

/* ── net worth ────────────────────────────────────────────────────────── */

describe("provenanceFor — net worth", () => {
  test("the total takes the weakest account's verdict, and says how many are proven", () => {
    const good = addAccount("a", "Chase Checking", "checking");
    addDays(good, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
    ]);
    addTxn(good, "2026-08-04");

    const weak = addAccount("b", "Robinhood Cash", "checking");
    addDays(weak, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived_unverified" },
    ]);
    addTxn(weak, "2026-08-04");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.verdict).toBe("unverified");
    expect(p.headline).toMatch(/1 of 2 accounts add up/);
    expect(p.headline).toMatch(/1 has nothing checking it/);
  });

  /*
   * ⚖️ His answer, 2026-10-07 (§6A 50): an account standing on nothing but a balance he typed is `counted` — "you
   * counted it" — in net worth's list, the trust card's group and every badge that reads the grade, and the sentence
   * still counts it among the accounts he counts himself.
   */
  test("an account resting on his count alone is one he counted, and the sentence still counts it as his", () => {
    const good = addAccount("a", "Chase Checking", "checking");
    addDays(good, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
    ]);
    addTxn(good, "2026-08-04");
    const safe = addAccount("b", "Safe", "checking");
    addDays(safe, [{ day: "2026-08-01", basis: "anchored" }]);
    addAnchor(safe, "2026-08-01", "manual");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.inputs.find((i) => i.label === "Safe")!.verdict).toBe("counted");
    expect(p.verdict).toBe("counted");
    expect(p.headline).toMatch(/1 of 2 accounts add up against a document, 1 you count yourself\./);
    expect(p.headline).not.toMatch(/nothing checking/);
  });

  /**
   * ⛔ An EMPTY account contributes $0 and nothing is missing, so dragging the
   * whole total's verdict down for it is noise — and noise is what teaches a
   * reader to stop reading the badge.
   */
  test("an empty account does not weaken the total", () => {
    const good = addAccount("a", "Chase Checking", "checking");
    addDays(good, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
    ]);
    addTxn(good, "2026-08-04");
    addAccount("b", "Capital One 360 Checking", "checking"); // no rows, no balances

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.verdict).toBe("derived");
    expect(p.inputs.find((i) => i.label === "Capital One 360 Checking")!.detail).toMatch(/empty/i);
  });

  /**
   * ⛔ …and it must not be COUNTED as one either. Excluding an empty account
   * from the verdict while leaving it inside `weak` made the sentence read
   * "1 has nothing checking it" about a set of zero — which the dashboard's
   * trust card then rendered above a note saying that same account has
   * "nothing to check, and nothing missing from any total". The service
   * disagreed with itself depending on which number you read.
   *
   * It stays inside the "of N" denominator on purpose: it IS one of his
   * accounts, and quietly dropping it would hide one.
   */
  test("an empty account is counted as empty, never as unchecked", () => {
    const good = addAccount("a", "Chase Checking", "checking");
    addDays(good, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
    ]);
    addTxn(good, "2026-08-04");
    addAccount("b", "Capital One 360 Checking", "checking"); // no rows, no balances

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.headline).toContain("1 of 2 accounts add up");
    expect(p.headline).toContain("1 is empty");
    expect(p.headline).not.toContain("nothing checking");
  });

  /**
   * The opposite case, and the most useful sentence this service can produce:
   * rows with no balance are money the total CANNOT SEE. Wells Fargo is exactly
   * this — 39 real rows and no anchor, because the app refuses to derive a
   * balance from the same rows a balance exists to check.
   */
  test("rows with no balance are named as a hole, with the amount", () => {
    const good = addAccount("a", "Chase Checking", "checking");
    addDays(good, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
    ]);
    addTxn(good, "2026-08-04");

    const hole = addAccount("b", "Wells Fargo Everyday Checking", "checking");
    addTxn(hole, "2026-08-02", { cents: 150_000 });
    addTxn(hole, "2026-08-03", { cents: -50_000 });

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.headline).toMatch(/Wells Fargo Everyday Checking holds 2 rows worth \$1,000\.00/);
    expect(p.headline).toMatch(/cannot see/);
    expect(p.verdict).toBe("unknown");
  });

  /**
   * The total cannot be proven past the FIRST account that stops being checked,
   * so the oldest verified-through bounds it — not the newest, which would
   * flatter the figure.
   */
  test("the oldest closed account bounds how far the total is proven", () => {
    const early = addAccount("a", "SoFi Savings", "savings");
    addDays(early, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-20", basis: "derived" },
    ]);
    addTxn(early, "2026-07-20");

    const late = addAccount("b", "Chase Checking", "checking");
    addDays(late, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-04", basis: "derived" },
    ]);
    addTxn(late, "2026-08-04");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.checkedThrough).toBe("2026-07-20");
  });

  test("with no accounts at all the answer is unknown, not proven", () => {
    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.verdict).toBe("unknown");
    expect(p.inputs).toEqual([]);
  });
});

/* ── a category total ─────────────────────────────────────────────────── */

function addCategory(id: string, name: string, parentId: string | null = null): string {
  bundle.db
    .insert(categories)
    .values({ id, name, parentId, kind: "expense", sortOrder: 0, createdAt: now(), updatedAt: now() })
    .run();
  return id;
}

function categorize(txnId: string, categoryId: string): void {
  bundle.db.run(sql`UPDATE transactions SET category_id = ${categoryId} WHERE id = ${txnId}`);
}

describe("provenanceFor — a category total", () => {
  test("names how many rows and how many documents are underneath it", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    const file = addFile("f1", "20260801-statements-3522-.pdf", "chase-checking-statement-pdf");
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-15", basis: "derived" },
    ]);
    for (const day of ["2026-07-10", "2026-07-15"]) categorize(addTxn(acct, day, { importFileId: file }), cat);
    readThrough(acct, "2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.headline).toMatch(/sum of 2 rows from 1 document/);
    expect(p.verdict).toBe("derived");
    expect(p.sources[0]!.label).toBe("20260801-statements-3522-.pdf");
  });

  test("the fifth document onward is summarised, and one of them is a document", () => {
    /*
     * 🔴 "and 1 more documents" — the hand-entered row four lines below it in
     * the same builder has pluralised its own noun since it shipped.
     */
    const acct = addAccount("a", "Chase Checking", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-15", basis: "derived" }]);
    // SOURCES_NAMED is 4, so five files leave exactly one unnamed
    for (let i = 1; i <= 5; i++) {
      const f = addFile(`f${i}`, `doc-${i}.pdf`, "chase-checking-statement-pdf");
      categorize(addTxn(acct, "2026-07-10", { importFileId: f }), cat);
    }

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.sources.at(-1)!.label).toBe("and 1 more document");
    expect(p.sources.map((x) => x.label)).not.toContain("and 1 more documents");
  });

  test("two unnamed documents stay plural", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-15", basis: "derived" }]);
    for (let i = 1; i <= 6; i++) {
      const f = addFile(`f${i}`, `doc-${i}.pdf`, "chase-checking-statement-pdf");
      categorize(addTxn(acct, "2026-07-10", { importFileId: f }), cat);
    }

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.sources.at(-1)!.label).toBe("and 2 more documents");
  });

  /** A parent's total includes its children, the same way the app reports it. */
  test("a parent total includes its children's rows", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const parent = addCategory("c-food", "Fixture Food");
    const child = addCategory("c-dining", "Fixture Dining", parent);
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-15", basis: "derived" }]);
    const file = addFile("f1", "s.pdf", "chase-checking-statement-pdf");
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), parent);
    categorize(addTxn(acct, "2026-07-15", { importFileId: file }), child);

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: parent, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.headline).toMatch(/sum of 2 rows/);
  });

  /**
   * ⛔ Three buckets, not two. Folding `market_value` into "not checked" told
   * the truth about arithmetic and lied about the figure — every
   * `Investments > Buys` row read "0 of 404 checked" as though 404 rows were
   * missing evidence, when they are priced from holdings.
   */
  test("priced-from-holdings rows are not reported as unchecked", () => {
    const acct = addAccount("a", "Robinhood Brokerage", "investment");
    // a holding prices it — without one this account is held at a recorded balance (see the describe at the end)
    addHoldingEvent(acct, "AAPL", "stock", "2026-07-01", 100_000_000);
    const cat = addCategory("c-buys", "Fixture Buys");
    const file = addFile("f1", "rh.pdf", "robinhood-brokerage-statement-pdf");
    addDays(acct, [{ day: "2026-07-10", basis: "derived" }]);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.headline).toMatch(/priced from holdings/);
    expect(p.headline).not.toMatch(/nothing checking/);
    // a category that is entirely market value reads "market value", not a fraction
    expect(p.badgeWord).toBeUndefined();
  });

  /**
   * ⛔ `manual` is a BASIS, not an absence. For cash in a safe the owner IS the
   * best evidence that will ever exist, and calling his own count "nothing
   * checking it" is both wrong and insulting to the only source there is. It
   * read exactly that way on /budgets until a screenshot caught it — and every
   * test here passed while it did, which is why this one exists.
   */
  test("a row the owner entered is a basis, not something unchecked", () => {
    const acct = addAccount("a", "Cash on Hand", "cash");
    const cat = addCategory("c-food", "Fixture Food");
    addDays(acct, [{ day: "2026-07-10", basis: "anchored" }]);
    categorize(addTxn(acct, "2026-07-10"), cat);

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.sources.some((s) => s.kind === "hand-entered" && /1 row you entered/.test(s.label))).toBe(true);
    expect(p.headline).toMatch(/1 you entered yourself/);
    expect(p.headline).not.toMatch(/nothing checking/);
  });

  /*
   * 🔴 A $66,477.60 TOTAL "YOU ENTERED". /summary/2026's "Spending in Jan 1 – Aug 12, 2026 came to $66,477.60." took
   * the weakest row's verdict, `manual`, from ONE $5,000.00 row he typed (the Cash on Hand down payment), and was badged
   * "you entered it" and named "…is known — it was entered by hand" over hundreds of rows statements check (review,
   * 2026-10-07). The verdict stays the weakest row's; the word and the name say it is PART of the total.
   */
  test("a total only part of which he typed says so — in the badge and the name — and an all-typed one does not", () => {
    const chase = addAccount("a", "Chase Checking", "checking");
    const coh = addAccount("b", "Cash on Hand", "cash");
    const cat = addCategory("c-car", "Fixture Car");
    const file = addFile("f1", "s.pdf", "chase-checking-statement-pdf");
    addDays(chase, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-15", basis: "derived" }]);
    addDays(coh, [{ day: "2026-07-10", basis: "anchored" }]);
    categorize(addTxn(coh, "2026-07-11"), cat);
    readThrough(coh, "2026-07-31");
    readThrough(chase, "2026-07-31");
    const total = () =>
      provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;

    // every row his: the stock word, and the stock name
    expect(total().verdict).toBe("manual");
    expect(total().badgeWord).toBeUndefined();
    expect(total().badgeName).toBeUndefined();

    for (const day of ["2026-07-10", "2026-07-15"]) categorize(addTxn(chase, day, { importFileId: file }), cat);
    const p = total();
    expect(p.verdict).toBe("manual");
    expect(p.badgeWord).toBe("part you entered");
    expect(p.badgeName).toBe("part of it was entered by hand");
    expect(provenanceTriggerName("Spending came to $3.00.", p.verdict, p.badgeWord, p.badgeName)).toBe(
      "How Spending came to $3.00 is known — part of it was entered by hand",
    );
    // the panel says the same: how many of its rows he typed
    expect(p.headline).toMatch(/^This total is the sum of 3 rows from 1 document, 1 you entered yourself\./);
  });

  /** One row is "it", not "them" — the copy is the product here. */
  test("the hand-entered source reads singular for one row", () => {
    const acct = addAccount("a", "Cash on Hand", "cash");
    const cat = addCategory("c-food", "Fixture Food");
    addDays(acct, [{ day: "2026-07-10", basis: "anchored" }]);
    categorize(addTxn(acct, "2026-07-10"), cat);
    const one = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(one.sources.find((s) => s.kind === "hand-entered")!.detail).toBe("no statement carries it");

    categorize(addTxn(acct, "2026-07-11"), cat);
    const two = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(two.sources.find((s) => s.kind === "hand-entered")!.detail).toBe("no statement carries them");
  });

  /*
   * 🔴 A ZERO IS ONLY MEASURED IF SOMEONE LOOKED, and this branch asserted a
   * measurement over ANY empty window. Measured on the real ledger 2026-09-11 —
   * newest active row 2026-08-31, today the 11th — the default September window
   * on every category page carried "so this total is zero rather than unproven"
   * over eleven unread days, 92 figures across /categories and /budgets, while
   * the same page said the honest thing forty lines below. These two tests
   * pinned the false reading.
   */
  test("an empty window nobody has imported is NOT called a measured zero", () => {
    const cat = addCategory("c-food", "Fixture Food");
    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2019-01-01", to: "2019-12-31" })!;
    expect(p.headline).toMatch(/a window nobody has looked at rather than a measurement/);
    expect(p.headline).not.toMatch(/zero rather than unproven/);
    expect(p.sources).toEqual([]);
  });

  /** …and a window the ledger really does cover keeps the measured wording. */
  test("an empty window INSIDE the records is a measured zero, and still says so", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    // rows either side of the window, so the ledger COVERS April 2019
    addTxn(acct, "2019-03-01");
    addTxn(acct, "2019-09-30");
    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2019-04-01", to: "2019-04-30" })!;
    expect(p.headline).toMatch(/zero rather than unproven/);
  });

  /*
   * 🔴 …AND A WINDOW THE IMPORT STOPS INSIDE HAS BEEN LOOKED AT, IN PART. It was called "a window nobody has looked at"
   * under a headline the page calls a lower bound — `/categories/<id>`'s "No spending or income in the part of … that
   * has been imported … so this is a lower bound rather than a measurement" (113 empty category-months on his ledger
   * copy 2026-10-12). The proof says what the page says.
   */
  test("an empty window the import stops INSIDE is a lower bound, not a window nobody looked at", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    addTxn(acct, "2019-03-01");
    addTxn(acct, "2019-09-30");
    // Sep 15–30 read, Oct 1–15 not
    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2019-09-15", to: "2019-10-15" })!;
    expect(p.headline).toBe(
      "Nothing has been imported for 15 days between Sep 15, 2019 and Oct 15, 2019, so this zero is a lower bound rather than a measurement.",
    );
    expect(p.verdict).toBe("unknown");
  });

  /** A row past its account's `verifiedThrough` is not covered by it. */
  test("a row after the chain stops being checked drags the total", () => {
    const acct = addAccount("a", "Robinhood Cash", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    const file = addFile("f1", "s.pdf", "chase-checking-statement-pdf");
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "derived" },
      { day: "2026-07-20", basis: "derived_unverified" },
    ]);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-07-20", { importFileId: file }), cat);
    readThrough(acct, "2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("1 of 2 checked");
  });

  /*
   * 🔴 A COUNT LEFT THE COMPARISON HERE TOO. `footingThrough` is the rule the
   * net worth date reads — an account resting on a balance he TYPED bounds the
   * picture at the day before nothing stands under it — and this path compared
   * `verifiedThrough` alone, so a count-only account dropped out of the bound
   * altogether. Every summed total holding one of its rows then dated itself
   * past the day the trust card beside it calls unchecked. Measured 2026-09-22
   * on a copy of the real ledger: /categories/Car Payment for August 2026 sums
   * the $5,000.00 down payment out of Cash on Hand with one Chase Checking row,
   * and read "Checked through 2026-08-12" — two days past Aug 11, which the
   * same app gives as the day nothing checks Cash on Hand any more.
   */
  test("an account resting on his count bounds a summed total where the count stops standing", () => {
    const cat = addCategory("c-food", "Fixture Food");

    const coh = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(coh, "2026-08-03", "manual");
    addDays(coh, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    categorize(addTxn(coh, "2026-08-11"), cat);

    const sofi = addAccount("sofi", "SoFi Checking", "checking");
    addDays(sofi, [
      { day: "2026-08-20", basis: "anchored" },
      { day: "2026-08-21", basis: "derived" },
    ]);
    categorize(addTxn(sofi, "2026-08-21"), cat);
    readThrough(coh, "2026-08-31");
    readThrough(sofi, "2026-08-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-08-01", to: "2026-08-31" })!;
    expect(p.checkedThrough).toBe("2026-08-10");
    // and the date says whose word it is, in net worth's own words
    expect(p.headline).toMatch(
      / The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check\.$/,
    );
    // one ledger, one day, one rule — net worth already answers it this way
    expect(provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!.checkedThrough).toBe("2026-08-10");
  });

  /**
   * ⛔ …and a total standing on his count ALONE is dated the same way (owner
   * decision 2026-09-28, handoff §6A 28). It printed no date at all, while net
   * worth — over the same Cash on Hand — printed the day his count stops
   * standing, so one account read two ways on one ledger depending on which
   * figure was asked. He chose to make them agree: the day, and net worth's own
   * sentence saying that day is his word rather than a check.
   */
  test("a total standing on his count alone is dated where the count stops standing, in net worth's words", () => {
    const cat = addCategory("c-food", "Fixture Food");
    const coh = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(coh, "2026-08-03", "manual");
    addDays(coh, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    categorize(addTxn(coh, "2026-08-11"), cat);
    readThrough(coh, "2026-08-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-08-01", to: "2026-08-31" })!;
    const netWorth = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!;
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.checkedThrough).toBe(netWorth.checkedThrough);
    const COUNT_NOTE =
      " The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check.";
    expect(p.headline.endsWith(COUNT_NOTE)).toBe(true);
    expect(netWorth.headline.endsWith(COUNT_NOTE)).toBe(true);
  });

  /*
   * 🔴 THE BADGE PRINTED RAW INTEGERS. `/accounts/<Robinhood Cash>` read "2,365
   * transactions landed in Robinhood Cash since it opened" beside a badge reading
   * "2364 of 2365 checked" on 2026-09-14 — one count spelled two ways on one
   * line. Every summed-rows badge and headline over a thousand rows did the same
   * ("the sum of 2365 rows"); the insight grammar has grouped its counts with
   * `toLocaleString("en-US")` all along.
   */
  test("counts over a thousand are grouped the way the sentence beside the badge groups them", () => {
    const acct = addAccount("a", "Robinhood Cash", "checking");
    const cat = addCategory("c-food", "Fixture Food");
    const file = addFile("f1", "s.pdf", "chase-checking-statement-pdf");
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "derived" },
      { day: "2026-07-20", basis: "derived_unverified" },
    ]);
    bundle.sqlite.transaction(() => {
      for (let i = 0; i < 1_000; i += 1) categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);
    })();
    categorize(addTxn(acct, "2026-07-20", { importFileId: file }), cat);
    readThrough(acct, "2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.badgeWord).toBe("1,000 of 1,001 checked");
    expect(p.headline).toContain("the sum of 1,001 rows from 1 document");
  });

  test("a category that does not exist is null", () => {
    expect(provenanceFor(bundle.db, { kind: "categorySpend", categoryId: "nope", from: "2026-01-01", to: "2026-12-31" })).toBeNull();
  });
});

/* ── holdings ─────────────────────────────────────────────────────────── */

function addHolding(accountId: string, symbol: string, assetType: string, quantityE8: number): void {
  bundle.db
    .insert(holdings)
    .values({
      id: `h-${accountId}-${symbol}`,
      accountId,
      symbol,
      assetType: assetType as never,
      quantityE8,
      isActive: true,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let evtSeq = 0;
function addHoldingEvent(accountId: string, symbol: string, assetType: string, day: string, deltaE8: number): void {
  evtSeq += 1;
  bundle.db
    .insert(holdingEvents)
    .values({
      id: `he-${evtSeq}`,
      accountId,
      symbol,
      assetType: assetType as never,
      occurredOn: day,
      quantityDeltaE8: deltaE8,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function addPrice(symbol: string, assetType: string, day: string, close: number, source = "yahoo"): void {
  bundle.db
    .insert(priceCache)
    .values({
      id: `p-${symbol}-${day}`,
      symbol,
      assetType: assetType as never,
      quotedOn: day,
      close,
      source: source as never,
      fetchedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

describe("provenanceFor — a holding", () => {
  test("a share count that closes against its events reads as market value, and says the count adds up", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "AAPL", "stock", 200000000);
    addHoldingEvent(acct, "AAPL", "stock", "2025-01-02", 150000000);
    addHoldingEvent(acct, "AAPL", "stock", "2025-06-02", 50000000);
    addPrice("AAPL", "stock", TODAY, 312.64);

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "AAPL", assetType: "stock", day: TODAY })!;
    expect(p.verdict).toBe("market_value");
    expect(p.badgeWord).toBeUndefined();
    expect(p.headline).toContain("2 shares × yahoo's $312.64 close");
    expect(p.headline).toContain("The share count adds up");
    // the price is never promoted to a proof, however fresh it is
    expect(p.headline).toContain("an observation, not a document");
  });

  /**
   * ⛔ THE guard. `0 === 0` is true, so a holding with no events at all would
   * report "the share count adds up" on the strength of a check that never ran
   * — pass 56's `Math.sign(0)` ruler in a new place. Both directions are pinned
   * because only pinning the passing one is how that bug shipped last time.
   */
  test("a holding with NO events does not claim its share count adds up", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "ZERO", "stock", 0);
    addPrice("ZERO", "stock", TODAY, 10);

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "ZERO", assetType: "stock", day: TODAY })!;
    expect(p.headline).not.toContain("adds up");
    expect(p.headline).toContain("Nothing checks the share count");
  });

  test("a share count that does NOT close against its events is broken, and says so in the badge", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "AAPL", "stock", 300000000);
    addHoldingEvent(acct, "AAPL", "stock", "2025-01-02", 150000000);
    addPrice("AAPL", "stock", TODAY, 100);

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "AAPL", assetType: "stock", day: TODAY })!;
    expect(p.verdict).toBe("broken");
    expect(p.badgeWord).toBe("share count is off");
    expect(p.headline).toContain("does not add up");
  });

  test("no price at all is unknown — there is nothing to value the shares at", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "NOPX", "stock", 100000000);
    addHoldingEvent(acct, "NOPX", "stock", "2025-01-02", 100000000);

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "NOPX", assetType: "stock", day: TODAY })!;
    expect(p.verdict).toBe("unknown");
    expect(p.headline).toContain("No price has ever been recorded");
  });

  /**
   * A closed position is worth $0 whatever the price does, so its price age is
   * irrelevant rather than alarming. The generic sentence read "0 shares ×
   * yahoo's $179.44 close … now 208 days old" for PM on the real ledger.
   */
  test("a closed position says it is closed instead of reporting a stale price", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "PM", "stock", 0);
    addHoldingEvent(acct, "PM", "stock", "2025-01-02", 100000000);
    addHoldingEvent(acct, "PM", "stock", "2025-09-02", -100000000);
    addPrice("PM", "stock", "2026-01-30", 179.44);

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "PM", assetType: "stock", day: TODAY })!;
    expect(p.headline).toContain("This position is closed");
    expect(p.headline).not.toContain("days old");
  });

  test("a stale price is named and aged, using the app's own staleness boundary", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "SPY", "stock", 100000000);
    addHoldingEvent(acct, "SPY", "stock", "2025-01-02", 100000000);
    addPrice("SPY", "stock", "2026-08-04", 765.14);

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "SPY", assetType: "stock", day: TODAY })!;
    // TODAY is 2026-08-05, so a 2026-08-04 close is one day old — and the app's
    // boundary is `> 0 days`, not some looser threshold invented here
    expect(p.headline).toContain("now 1 day old");
    expect(p.sources.some((s) => s.detail?.includes("1 day old"))).toBe(true);
  });

  test("crypto is counted in coins, not shares", () => {
    const acct = addAccount("rhc", "Robinhood Crypto", "investment");
    addHolding(acct, "ETH", "crypto", 100000000);
    addHoldingEvent(acct, "ETH", "crypto", "2025-11-01", 100000000);
    addPrice("ETH", "crypto", TODAY, 2451.31, "coinbase");

    const p = provenanceFor(bundle.db, { kind: "holding", symbol: "ETH", assetType: "crypto", day: TODAY })!;
    expect(p.headline).toContain("1 coins");
    expect(p.headline).toContain("The coin count adds up");
  });

  /**
   * ⛔ `checkedThrough` renders as "Checked through <date>" — a claim the MONEY
   * added up to that day. A price date is not that claim and must never be
   * printed as one.
   */
  test("a holding never reports a checkedThrough date", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "AAPL", "stock", 100000000);
    addHoldingEvent(acct, "AAPL", "stock", "2025-01-02", 100000000);
    addPrice("AAPL", "stock", TODAY, 100);

    expect(provenanceFor(bundle.db, { kind: "holding", symbol: "AAPL", assetType: "stock", day: TODAY })!.checkedThrough).toBeNull();
  });

  test("a symbol that was never held is null", () => {
    expect(provenanceFor(bundle.db, { kind: "holding", symbol: "ZZZZ", assetType: "stock", day: TODAY })).toBeNull();
  });
});

/* ── a recurring series' amount ───────────────────────────────────────── */

let seriesSeq = 0;
function addSeries(
  name: string,
  opts: { amountAvg?: number | null; userAmount?: number | null; nextAmount?: number | null } = {},
): string {
  seriesSeq += 1;
  const id = `rs-${seriesSeq}`;
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name,
      kind: "bill",
      cadence: "monthly",
      amountCentsAvg: opts.amountAvg ?? -1000,
      nextExpectedAmountCents: opts.nextAmount ?? opts.amountAvg ?? -1000,
      userAmountCents: opts.userAmount ?? null,
      status: "confirmed",
      confidence: 1,
      toleranceDays: 3,
      createdAt: now(),
      updatedAt: now(),
    } as never)
    .run();
  return id;
}

function tagToSeries(txnId: string, seriesId: string): void {
  bundle.db.run(sql`UPDATE transactions SET recurring_series_id = ${seriesId} WHERE id = ${txnId}`);
}

describe("provenanceFor — a recurring series' amount", () => {
  /**
   * ⛔ THE floor. `MIN_OCCURRENCES` is the codebase's single definition of
   * "enough occurrences to be a statistic" and this service imports it rather
   * than re-picking one. Two postings must NOT read like a measured pattern,
   * however identical they are.
   */
  test("below MIN_OCCURRENCES the evidence is an anecdote, not a pattern — even when every posting agrees", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Thin");
    for (const d of ["2026-06-01", "2026-07-01"]) tagToSeries(addTxn(acct, d, { cents: -1000 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("seen 2 times");
    expect(p.headline).toContain("below the 3 this app requires");
    expect(p.headline).toContain("anecdote rather than a statistic");
  });

  test("at MIN_OCCURRENCES with every posting identical, the forecast is backed by measured evidence", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    // the forecast is what they paid — "adds up" is over the figure (see the test after this one)
    const s = addSeries("Amazon Prime", { amountAvg: -499 });
    for (const d of ["2026-05-05", "2026-06-05", "2026-07-05"]) tagToSeries(addTxn(acct, d, { cents: -499 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("derived");
    expect(p.badgeWord).toBeUndefined();
    expect(p.headline).toContain("All 3 tagged postings");
    // ⛔ never `sourced` — no document states NEXT month's amount
    expect(p.verdict).not.toBe("sourced");
    expect(p.headline).toContain("a forecast, not a record");
  });

  /*
   * ⛔ …and agreeing with each other is not agreeing with the FIGURE: "adds up" grades the amount on screen, so every
   * counted payment must be it. 🔴 Graded on the payments alone, a forecast none of them paid read "adds up" — his
   * Netflix's -$17.75 beside "were -$19.59, exactly" (review of 442de07, a copy of his ledger, 2026-10-12).
   */
  test("at MIN_OCCURRENCES, identical postings that are not the forecast do not add up to it", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Amazon Prime", { amountAvg: -495 });
    for (const d of ["2026-05-05", "2026-06-05", "2026-07-05"]) tagToSeries(addTxn(acct, d, { cents: -499 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("paid -$4.99 each time");
    expect(p.headline).toContain(
      "All 3 tagged postings since May 5, 2026 were -$4.99, exactly. None of the 3 paid the -$4.95 forecast here.",
    );
  });

  /**
   * ⛔ Rent: three postings at three different amounts. "nothing checks it" is
   * FALSE — three documents check it and disagree — so the badge must say which
   * of the two soft cases this is.
   */
  test("postings that disagree say so, instead of claiming nothing checks the figure", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Rent");
    for (const [d, c] of [["2026-06-16", -228570], ["2026-06-30", -110000], ["2026-07-08", -150000]] as const) {
      tagToSeries(addTxn(acct, d, { cents: c }), s);
    }

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("3 different amounts");
    expect(p.headline).toContain("3 different amounts");
    expect(p.headline).toContain("an average, not a repeat");
  });

  test("an owner override is graded manual — he is the source, not an absence of one", () => {
    const s = addSeries("Car lease", { amountAvg: null, userAmount: -55989 });

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("manual");
    expect(p.headline).toContain("You set this amount yourself");
    expect(p.headline).toContain("no evidence behind it at all");
    expect(p.sources[0]!.kind).toBe("hand-entered");
  });

  /**
   * The live ledger's "Cash job": the owner set $1,047.00 while the postings
   * average $1,046.00. A popover that stays silent about that is hiding the one
   * thing worth knowing.
   *
   * ⛔ THIS FIXTURE USED TO CONTRADICT ITS OWN COMMENT. It posted a single row
   * of $1,047.00 — the same as the override — and seeded `amountCentsAvg` at
   * $1,046.00, so the assertion passed only because the clause read the SEED.
   * The postings now really do average what the comment says they do.
   */
  test("an override that disagrees with what actually posted says so", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Cash job", { amountAvg: 104600, userAmount: 104700 });
    for (const d of ["2026-06-04", "2026-06-11", "2026-06-18"]) tagToSeries(addTxn(acct, d, { cents: 104600 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("manual");
    expect(p.headline).toContain("The ledger's own average of what actually posted is $1,046.00");
  });

  /**
   * 🔴 ONE SENTENCE DENYING WHAT THE NEXT ONE MEASURES. The clause read
   * `amountCentsAvg`, which `recurring.ts` documents as "the detector's SEED:
   * written when the series was created and never recomputed as rows are
   * attached afterwards" — adding that "anything claiming to be the average of
   * the postings reads [postedAvgCents]". On the real ledger 2026-09-11,
   * /recurring/<Car lease> printed both halves in one breath:
   *
   *   "Nothing tagged to it has ever posted, so there is no evidence behind it
   *    at all. ⚠️ The ledger's own average of what actually posted is
   *    -$559.89, which is not what you set."
   *
   * and no row in the 10,178-row ledger has ever posted at -$559.89.
   */
  test("a series with NOTHING posted names no average of what posted", () => {
    const s = addSeries("Car lease", { amountAvg: -55989, userAmount: -69504 });

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.headline).toContain("no evidence behind it at all");
    expect(p.headline).not.toContain("actually posted");
    expect(p.headline).not.toContain("-$559.89");
  });

  /** ⛔ and the figure it names is the postings' mean, never the detector's seed */
  test("the average named is the postings', not the seed the detector wrote", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    // the real Flamingo rent: seeded at -$2,285.70, four charges averaging -$1,739.40
    const s = addSeries("Flamingo South Beach", { amountAvg: -228570, userAmount: -200000 });
    for (const [d, c] of [
      ["2026-05-01", -223711],
      ["2026-06-01", -110000],
      ["2026-07-01", -223711],
      ["2026-08-01", -138338],
    ] as const) {
      tagToSeries(addTxn(acct, d, { cents: c }), s);
    }

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.headline).toContain("The ledger's own average of what actually posted is -$1,739.40");
    expect(p.headline).not.toContain("-$2,285.70");
  });

  test("an override that matches the observed average does NOT raise a disagreement", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Agreeing", { amountAvg: -1000, userAmount: -1000 });
    tagToSeries(addTxn(acct, "2026-06-04", { cents: -1000 }), s);

    expect(provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!.headline).not.toContain("which is not what you set");
  });

  test("a series with nothing tagged and no override has no basis at all", () => {
    const s = addSeries("Detected but never seen", { amountAvg: -2500 });

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("unknown");
    expect(p.sources).toHaveLength(0);
  });

  test("a single posting is described in the singular", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("FPL");
    tagToSeries(addTxn(acct, "2026-07-10", { cents: -1421 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.badgeWord).toBe("seen once");
    // "every one of them" over a population of one is a plural claim
    expect(p.sources[0]!.detail).toBe("it was -$14.21");
  });

  /** A forecast is never "checked through" a day — that phrase means the money added up. */
  test("a series never reports a checkedThrough date", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Rocket Money");
    for (const d of ["2026-05-15", "2026-06-15", "2026-07-15"]) tagToSeries(addTxn(acct, d, { cents: -600 }), s);

    expect(provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!.checkedThrough).toBeNull();
  });

  test("a series that does not exist is null", () => {
    expect(provenanceFor(bundle.db, { kind: "recurringSeries", id: "nope" })).toBeNull();
  });
});

/**
 * ⚖️ Owner decision 2026-10-12 (§6A 63): a bill or subscription with a rate history averages only the payments at the
 * rate in force now — so those are the evidence its popover GRADES, as they are what its sentence counts. Latent on his
 * ledger (2026-10-12), where only his pay has a history: the recorded history here is hypothetical; the amounts are his
 * Netflix's own, -$16.86 then -$19.59 (from Feb 25, 2025), never set by hand, so its verdict is the evidence's.
 *
 * 🔴 Graded on the rows of every rate (review of a64b99a, a copy of his ledger, 2026-10-12): his Netflix given a history
 * through Jun 30, 2025 read "adds up" on its ONE payment since — the 17 before the change got it past the 3 the app
 * requires before calling a repeat a pattern, and one payment trivially agrees with itself — beside "Its one payment at
 * the rate in force since Jul 1, 2025 was -$19.59".
 */
describe("provenanceFor — a recurring series' amount, with a rate history (§6A 63)", () => {
  const TODAY_ERA = "2026-10-12";
  const OLD_RATE = -1686;
  const NEW_RATE = -1959;
  const OLD_DAYS = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15"];

  /**
   * -$16.86 on each of `oldDays`, recorded as the rate through May 31; then `newRate` paid on its days. `forecast` is
   * detection's amount (`nextExpectedAmountCents`) — the new rate unless a test says otherwise.
   */
  function raisedSubscription(
    newRate: readonly (readonly [string, number])[],
    oldDays = OLD_DAYS,
    forecast = NEW_RATE,
  ): string {
    const s = addSeries("Netflix", { amountAvg: NEW_RATE, nextAmount: forecast });
    const acct = addAccount(`card-${s}`, "Chase Sapphire", "credit");
    for (const d of oldDays) tagToSeries(addTxn(acct, d, { cents: OLD_RATE }), s);
    for (const [d, c] of newRate) tagToSeries(addTxn(acct, d, { cents: c }), s);
    bundle.db.run(
      sql`UPDATE recurring_series SET user_amount_history = ${JSON.stringify([
        { throughOn: "2026-05-31", amountCents: OLD_RATE },
      ])} WHERE id = ${s}`,
    );
    return s;
  }
  const popover = (id: string) => provenanceFor(bundle.db, { kind: "recurringSeries", id, today: TODAY_ERA })!;

  test("one payment at the new rate is an anecdote, however many came before the change", () => {
    const p = popover(raisedSubscription([["2026-06-15", NEW_RATE]]));
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("seen once at the new rate");
    expect(p.headline).toContain(
      "Its one payment at the rate in force since Jun 1, 2026 was -$19.59, on Jun 15, 2026. Its 5 payments before " +
        "Jun 1, 2026 were at an earlier rate, and are not counted. That is one payment at the rate in force now — " +
        "below the 3 this app requires before calling a repeat a pattern, so it is an anecdote rather than a " +
        "statistic.",
    );
  });

  test("two identical payments at the new rate are still not a pattern", () => {
    const p = popover(raisedSubscription([["2026-06-15", NEW_RATE], ["2026-07-15", NEW_RATE]]));
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("seen 2 times at the new rate");
    expect(p.headline).toContain("Its 2 payments at the rate in force since Jun 1, 2026 were -$19.59, exactly.");
    expect(p.headline).toContain("That is 2 payments at the rate in force now — below the 3 this app requires");
  });

  /* ⛔ graded on the new rate's amounts alone: the old rate's -$16.86 is not a disagreement */
  test("three identical payments at the new rate add up, though the rate before was another", () => {
    const newRate = [["2026-06-15", NEW_RATE], ["2026-07-15", NEW_RATE], ["2026-08-15", NEW_RATE]] as const;
    const p = popover(raisedSubscription(newRate));
    expect(p.verdict).toBe("derived");
    expect(p.badgeWord).toBeUndefined();
    expect(p.headline).toContain("Its 3 payments at the rate in force since Jun 1, 2026 were -$19.59, exactly.");
    expect(p.headline).not.toContain("below the 3");
  });

  /*
   * ⛔ …but only when the figure graded IS that amount. A forecast nobody set is detection's
   * (`nextExpectedAmountCents`): the mean of the rows it saw, at both rates. 🔴 Graded on the payments alone, his Netflix
   * given its real price change as a history (through Feb 24, 2025) read "adds up" over a Per charge of -$17.75 — the
   * mean of its 18 rows — beside "Its 6 payments at the rate in force since Feb 25, 2025 were -$19.59, exactly." and
   * "posted avg -$19.59" (review of 442de07, a copy of his ledger, 2026-10-12).
   */
  test("three identical payments at the new rate do not add up to a forecast none of them paid", () => {
    // detection's mean of the eight rows, at both rates: -$17.88
    const forecast = Math.round((OLD_DAYS.length * OLD_RATE + 3 * NEW_RATE) / (OLD_DAYS.length + 3));
    const newRate = [["2026-06-15", NEW_RATE], ["2026-07-15", NEW_RATE], ["2026-08-15", NEW_RATE]] as const;
    const p = popover(raisedSubscription(newRate, OLD_DAYS, forecast));
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("paid -$19.59 at the new rate");
    expect(p.headline).toContain(
      "Its 3 payments at the rate in force since Jun 1, 2026 were -$19.59, exactly. Its 5 payments before Jun 1, " +
        "2026 were at an earlier rate, and are not counted. None of the 3 paid the -$17.88 forecast here.",
    );
  });

  test("three at the new rate that disagree name their own amounts, not the old rate's", () => {
    const p = popover(raisedSubscription([["2026-06-15", NEW_RATE], ["2026-07-15", -1999], ["2026-08-15", NEW_RATE]]));
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("2 different amounts");
  });

  /*
   * ⛔ Fewer than 3 rows in all: the words count the one payment at the new rate, as the badge and the average do —
   * never "Only 2 tagged postings have ever landed" beside an average of one of them.
   */
  test("one payment either side of the change: the badge and the words count the one at the new rate", () => {
    const p = popover(raisedSubscription([["2026-06-15", NEW_RATE]], ["2026-05-15"]));
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("seen once at the new rate");
    expect(p.headline).not.toContain("Only 2 tagged postings");
    expect(p.headline).toContain(
      "Its one payment at the rate in force since Jun 1, 2026 was -$19.59, on Jun 15, 2026. Its one payment before " +
        "Jun 1, 2026 was at an earlier rate, and is not counted. That is one payment at the rate in force now",
    );
  });

  /* nothing at the new rate is nothing checking it — never "seen N times" of the old rate's payments */
  test("nothing paid at the new rate yet: nothing checks it, however many payments came before", () => {
    for (const oldDays of [OLD_DAYS, ["2026-04-15", "2026-05-15"]]) {
      const p = popover(raisedSubscription([], oldDays));
      expect(p.verdict).toBe("unverified");
      expect(p.badgeWord).toBeUndefined();
      expect(p.headline).toContain(
        `Its ${oldDays.length} payments before Jun 1, 2026 were at an earlier rate, and nothing has posted at the ` +
          "rate in force since — so there is no average of it yet.",
      );
      expect(p.headline).not.toContain("below the 3");
    }
  });
});

/* ── all spending in a window ─────────────────────────────────────────── */

function addKindedCategory(id: string, name: string, kind: "expense" | "income" | "transfer"): string {
  bundle.db
    .insert(categories)
    .values({ id, name, parentId: null, kind, sortOrder: 0, createdAt: now(), updatedAt: now() })
    .run();
  return id;
}

function addSplit(txnId: string, categoryId: string, cents: number, seq: number): void {
  bundle.db
    .insert(transactionSplits)
    .values({
      id: `sp-${txnId}-${seq}`,
      transactionId: txnId,
      categoryId,
      amountCents: cents,
      sortOrder: seq,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/**
 * ⛔ These pin the SET of rows the proof is about, not the arithmetic — the
 * arithmetic is `summedRowsProvenance`, already covered by the category tests.
 * What is new and worth guarding is which transactions get to be underneath the
 * app's largest number: every expense category rather than one, uncategorized
 * outflows but not uncategorized credits, and a split counted once.
 */
describe("provenanceFor — all spending in a window", () => {
  const WINDOW = { from: "2026-07-01", to: "2026-07-31" } as const;

  test("spans every expense category, not one", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const food = addKindedCategory("c-food", "Fixture Food", "expense");
    const rent = addKindedCategory("c-rent", "Fixture Rent", "expense");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), food);
    categorize(addTxn(acct, "2026-07-11", { importFileId: file }), rent);
    readThrough(acct, WINDOW.to);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.headline).toMatch(/sum of 2 rows from 1 document/);
    expect(p.verdict).toBe("derived");
  });

  /** The app's spending total counts uncategorized OUTFLOWS; its proof must too. */
  test("an uncategorized outflow is spending and an uncategorized credit is not", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    addTxn(acct, "2026-07-10", { importFileId: file, cents: -500 });
    addTxn(acct, "2026-07-11", { importFileId: file, cents: 900 });

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.headline).toMatch(/sum of 1 row from 1 document/);
  });

  test("income rows and transfer rows are not spending", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const food = addKindedCategory("c-food", "Fixture Food", "expense");
    const pay = addKindedCategory("c-pay", "Fixture Salary", "income");
    const move = addKindedCategory("c-move", "Fixture Transfer", "transfer");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), food);
    categorize(addTxn(acct, "2026-07-11", { importFileId: file, cents: 5000 }), pay);
    // a transfer LEG is a debit like any purchase — only its category keeps it out
    categorize(addTxn(acct, "2026-07-12", { importFileId: file, cents: -2000 }), move);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.headline).toMatch(/sum of 1 row from 1 document/);
  });

  /**
   * ⛔ A credit in an expense category is a REFUND, and `periodTotals` keeps it
   * out of "Spent" entirely rather than netting it down. A proof that counted
   * its row would name a document underneath a figure that document did not
   * contribute a cent to.
   */
  test("a refund inside an expense category is not a row underneath the total", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const food = addKindedCategory("c-food", "Fixture Food", "expense");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), food);
    categorize(addTxn(acct, "2026-07-11", { importFileId: file, cents: 4000 }), food);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.headline).toMatch(/sum of 1 row from 1 document/);
  });

  /**
   * ⛔ THE reason this is not a thin wrapper. `activeTxnsInRange` explodes a
   * split into one pseudo-row per part so each part lands in its own category;
   * counting those would report three rows from one document for one charge.
   */
  test("a transaction split three ways is one row, not three", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const food = addKindedCategory("c-food", "Fixture Food", "expense");
    const rent = addKindedCategory("c-rent", "Fixture Rent", "expense");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    const txn = addTxn(acct, "2026-07-10", { importFileId: file, cents: -6000 });
    categorize(txn, food);
    addSplit(txn, food, -2000, 1);
    addSplit(txn, rent, -3000, 2);
    addSplit(txn, food, -1000, 3);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.headline).toMatch(/sum of 1 row from 1 document/);
  });

  /**
   * A split that sends part of a charge somewhere that is not spending still
   * rests on the one document carrying the whole line — so the transaction
   * contributes exactly once, and having a non-spending part does not delete it.
   */
  test("a split with one spending part still contributes its transaction once", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const food = addKindedCategory("c-food", "Fixture Food", "expense");
    const through = addKindedCategory("c-through", "Fixture Pass-through", "transfer");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    const txn = addTxn(acct, "2026-07-10", { importFileId: file, cents: -5000 });
    categorize(txn, food);
    addSplit(txn, food, -4000, 1);
    addSplit(txn, through, -1000, 2);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.headline).toMatch(/sum of 1 row from 1 document/);
  });

  test("a window nobody has imported is not a measured zero", () => {
    addAccount("a", "Chase Checking", "checking");
    const p = provenanceFor(bundle.db, { kind: "allSpend", from: "2019-01-01", to: "2019-12-31" })!;
    expect(p.headline).toMatch(/a window nobody has looked at rather than a measurement/);
    expect(p.verdict).toBe("unknown");
    expect(p.sources).toEqual([]);
  });

  /** Graded like every other total: the first unchecked row bounds the whole thing. */
  test("a row past its account's coverage drags the total", () => {
    const acct = addAccount("a", "Robinhood Cash", "checking");
    const food = addKindedCategory("c-food", "Fixture Food", "expense");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "derived" },
      { day: "2026-07-20", basis: "derived_unverified" },
    ]);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), food);
    categorize(addTxn(acct, "2026-07-20", { importFileId: file }), food);
    readThrough(acct, WINDOW.to);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...WINDOW })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("1 of 2 checked");
  });

  test("the window's own label is used when one is given", () => {
    addAccount("a", "Chase Checking", "checking");
    // the label rides the MEASURED branch — the uncovered one names the window
    // by its two ends, because "nobody looked at Jul 2026" is about the days
    addTxn("a", "2019-03-01");
    addTxn("a", "2019-09-30");
    const p = provenanceFor(bundle.db, { kind: "allSpend", from: "2019-04-01", to: "2019-04-30", label: "Jul 2026" })!;
    expect(p.headline).toMatch(/No rows in Jul 2026/);
  });
});

/* ── a budget's plan ──────────────────────────────────────────────────── */

function addBudget(
  id: string,
  categoryId: string,
  opts: {
    amountCents?: number;
    period?: "daily" | "weekly" | "monthly" | "annual";
    startsOn?: string;
    endsOn?: string | null;
    rolloverEnabled?: boolean;
    createdAt?: string;
  } = {},
): string {
  bundle.db
    .insert(budgets)
    .values({
      id,
      categoryId,
      period: opts.period ?? "monthly",
      amountCents: opts.amountCents ?? 120000,
      startsOn: opts.startsOn ?? "2026-01-01",
      endsOn: opts.endsOn ?? null,
      isActive: true,
      rolloverEnabled: opts.rolloverEnabled ?? false,
      rolloverStartsOn: null,
      rolloverCapCents: null,
      createdAt: opts.createdAt ?? "2026-01-01T09:00:00.000Z",
      updatedAt: now(),
    })
    .run();
  return id;
}

/**
 * ⛔ A budget is the one figure this service grades that is a DECISION rather
 * than a measurement, and "nothing checks it" is the right answer rather than a
 * hole. These tests pin that distinction: `manual`, never `unverified`, and no
 * `checkedThrough` date — a plan is not something that adds up through a day.
 */
describe("provenanceFor — a budget's plan", () => {
  test("a plan is the owner's own, not something unchecked", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    addBudget("b1", cat);

    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!;
    expect(p.verdict).toBe("manual");
    /*
     * ⛔ `manual`'s stock word is "you entered it", which over-claims here:
     * these budgets were proposed by a script and kept, and the headline is
     * deliberately careful not to say he typed them. A badge that said it anyway
     * would contradict the sentence it opens.
     */
    expect(p.badgeWord).toBe("a plan");
    expect(p.headline).toMatch(/This is a plan, not a record: \$1,200\.00 a month for Fixture Housing/);
    expect(p.sources[0]!.kind).toBe("hand-entered");
    expect(p.sources[0]!.label).toBe("$1,200.00 a month for Fixture Housing");
  });

  /** Each period gets its own words — "$1,200.00 a monthly" is not a sentence. */
  test("the period is spelled the way a sentence needs it", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    for (const [i, [period, words]] of (
      [
        ["daily", "a day"],
        ["weekly", "a week"],
        ["monthly", "a month"],
        ["annual", "a year"],
      ] as const
    ).entries()) {
      const child = addCategory(`c-${period}`, `Fixture ${period}`, cat);
      addBudget(`b-${i}`, child, { period });
      const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: `b-${i}` })!;
      expect(p.headline).toContain(`$1,200.00 ${words} for Fixture ${period}`);
    }
  });

  /**
   * ⛔ The day he DECIDED, not the day the plan starts running. `startsOn` is
   * backdatable and says when the money is planned for, which is a different
   * fact — a proof dated by it would claim he made a decision on a day it can
   * only prove he planned FOR.
   */
  test("the source is dated when the budget was created, not when it starts", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    addBudget("b1", cat, { startsOn: "2025-06-01", createdAt: "2026-02-14T09:00:00.000Z" });

    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!;
    expect(p.sources[0]!.on).toBe("2026-02-14");
    expect(p.headline).toMatch(/running since Jun 1, 2025/);
  });

  /** A plan never "adds up through" a day — that phrase means money reconciled. */
  test("a plan reports no checkedThrough date", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    addBudget("b1", cat);
    expect(provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!.checkedThrough).toBeNull();
  });

  /**
   * ⛔ With rollover on, the line the period is graded against is the plan PLUS
   * a carry measured from the ledger. A proof that silently covered only the
   * chosen half would be the "basis in a caption" mistake — true of the fact and
   * wrong to the reader looking at the bigger number.
   */
  test("rollover is named, because it changes what the reader is looking at", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    addBudget("b1", cat, { rolloverEnabled: true });

    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!;
    expect(p.headline).toMatch(/Rollover is on/);
    expect(p.headline).toMatch(/measured from your ledger and is not part of what you chose/);
    expect(p.sources.some((s) => s.label === "rollover is on")).toBe(true);
    // still the owner's decision — the carry does not make the plan a measurement
    expect(p.verdict).toBe("manual");
  });

  /*
   * ⚖️ OWNER DECISION 2026-10-13 (decision 67): a closed period not fully imported banks nothing until its statements
   * land, and the bills that came due in a period are subtracted before it banks. 🔴 This proof still said what the
   * carry was before both — "this plan plus whatever you underspent in closed periods", and "unspent plan from closed
   * periods is added to this one" (10cd4f7, Aug 27). On his ledger copy 2026-10-21 Transport's popover said it over a
   * $227.95 plan with $141.96 spent in September and $0.00 carried, while the panel on the same row said "September
   * 2026 is not fully imported, so nothing rolls over from it yet" (review of 9249ae7). The rule is the panel's own
   * words, so the two cannot drift again.
   */
  test("rollover's rule is the panel's: a period not fully imported adds nothing, and bills that came due are subtracted", () => {
    const cat = addCategory("c-food", "Fixture Food");
    addBudget("b1", cat, { rolloverEnabled: true });

    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!;
    expect(p.headline).not.toMatch(/whatever you underspent/);
    expect(p.headline).toContain(
      "A period that came in under plan adds its leftover; one that went over adds nothing, and overspend is never " +
        "carried as a debt. Bills that came due are subtracted whether they are not posted or no statement has " +
        "covered them yet. A closed period that is not fully imported adds nothing until its statements land.",
    );
    const rollover = p.sources.find((s) => s.label === "rollover is on")!;
    expect(rollover.detail).not.toMatch(/unspent plan from closed periods is added/);
    expect(rollover.detail).toBe(
      "a closed period's leftover is added to this one — none from a period not fully imported — and that carry is " +
        "computed from your ledger",
    );
  });

  test("with rollover off nothing is said about a carry", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    addBudget("b1", cat);

    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!;
    expect(p.headline).not.toMatch(/[Rr]ollover/);
    expect(p.sources).toHaveLength(1);
  });

  test("an end date is stated when the budget has one", () => {
    const cat = addCategory("c-house", "Fixture Housing");
    addBudget("b1", cat, { endsOn: "2026-12-31" });
    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1" })!;
    expect(p.headline).toMatch(/stops after Dec 31, 2026/);

    addBudget("b2", cat, { endsOn: null, period: "annual" });
    expect(provenanceFor(bundle.db, { kind: "budgetPlan", id: "b2" })!.headline).not.toMatch(/stops after/);
  });

  /** /budgets shows "Food > Dining", and the proof should say what the page says. */
  test("a caller's label wins over the bare category name", () => {
    const parent = addCategory("c-food", "Fixture Food");
    const child = addCategory("c-dining", "Fixture Dining", parent);
    addBudget("b1", child);

    const p = provenanceFor(bundle.db, { kind: "budgetPlan", id: "b1", label: "Fixture Food > Fixture Dining" })!;
    expect(p.headline).toContain("for Fixture Food > Fixture Dining");
    expect(p.sources[0]!.label).toBe("$1,200.00 a month for Fixture Food > Fixture Dining");
  });

  test("a budget that does not exist is null", () => {
    expect(provenanceFor(bundle.db, { kind: "budgetPlan", id: "nope" })).toBeNull();
  });
});

/**
 * ⛔ A comparison rests on both of its windows. `spending-insights` renders a
 * `rose_between` delta today and proves only its current window, which is a
 * looseness these tests deliberately do not repeat: a year-over-year sentence
 * stands on last year's documents exactly as much as on this year's.
 */
describe("provenanceFor — all spending, compared against another window", () => {
  const JUL = { from: "2026-07-01", to: "2026-07-31" } as const;
  const JUN = { from: "2026-06-01", to: "2026-06-30" } as const;

  function twoMonths(): { acct: string; cat: string; file: string } {
    const acct = addAccount("a", "Chase Checking", "checking");
    const cat = addKindedCategory("c-food", "Fixture Food", "expense");
    const file = addFile("f1", "both.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-06-01", basis: "anchored" }, { day: "2026-07-31", basis: "derived" }]);
    readThrough(acct, JUL.to);
    return { acct, cat, file };
  }

  test("both windows are counted, and each is named with its own verdict", () => {
    const { acct, cat, file } = twoMonths();
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-07-20", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-06-10", { importFileId: file }), cat);

    const p = provenanceFor(bundle.db, {
      kind: "allSpend",
      ...JUL,
      label: "Jul 2026",
      against: { ...JUN, label: "Jun 2026" },
    })!;
    expect(p.headline).toMatch(/Jul 2026 holds 2 rows; Jun 2026 holds 1 row\./);
    expect(p.inputs.map((i) => i.label)).toEqual(["Jul 2026", "Jun 2026"]);
    expect(p.inputs[0]!.detail).toMatch(/^2 rows, Jul 1, 2026 to Jul 31, 2026$/);
    expect(p.inputs[1]!.detail).toMatch(/^1 row, Jun 1, 2026 to Jun 30, 2026$/);
    expect(p.inputs.every((i) => i.verdict === "derived")).toBe(true);
  });

  // 🔴 the year-against-year sentence on /summary takes the combined proof's word — so it takes its name too
  test("a comparison only part of which he typed wears the same word and name", () => {
    const { acct, cat, file } = twoMonths();
    const coh = addAccount("b", "Cash on Hand", "cash");
    addDays(coh, [{ day: "2026-07-10", basis: "anchored" }]);
    categorize(addTxn(coh, "2026-07-11"), cat);
    readThrough(coh, JUL.to);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-06-10", { importFileId: file }), cat);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...JUL, against: { ...JUN } })!;
    expect(p.verdict).toBe("manual");
    expect(p.badgeWord).toBe("part you entered");
    expect(p.badgeName).toBe("part of it was entered by hand");
  });

  /**
   * ⛔ THE reason the grading runs over both row sets at once. A badge saying
   * "2 of 3 checked" has to be true of a real set of rows; taking the weaker of
   * two separately-computed fractions would print one that is true of neither
   * half.
   */
  test("the badge counts every row under the comparison, not one window's", () => {
    const acct = addAccount("a", "Robinhood Cash", "checking");
    const cat = addKindedCategory("c-food", "Fixture Food", "expense");
    const file = addFile("f1", "both.pdf", "chase-checking-statement-pdf");
    addDays(acct, [
      { day: "2026-06-01", basis: "anchored" },
      { day: "2026-06-30", basis: "derived" },
      { day: "2026-07-20", basis: "derived_unverified" },
    ]);
    // two proven rows in June, one unchecked row in July
    categorize(addTxn(acct, "2026-06-10", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-06-20", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-07-20", { importFileId: file }), cat);
    readThrough(acct, JUL.to);

    const p = provenanceFor(bundle.db, {
      kind: "allSpend",
      ...JUL,
      label: "Jul 2026",
      against: { ...JUN, label: "Jun 2026" },
    })!;
    expect(p.badgeWord).toBe("2 of 3 checked");
    expect(p.verdict).toBe("unverified");
    // …and the reader can see WHICH half is the weak one
    expect(p.inputs[0]!.verdict).toBe("unverified");
    expect(p.inputs[1]!.verdict).toBe("derived");
  });

  /**
   * ⛔ The mirror of the test above, and it exists because a mutation survived
   * without it: with only the current-window-is-weak case covered, replacing
   * `inputs[0]`'s own verdict with the COMBINED verdict changed nothing, since
   * in that direction the two happen to be equal. A reader has to be able to
   * see which half is the weak one, and that is only falsifiable when the weak
   * half is the one the composite verdict is NOT about.
   */
  test("a weak PRIOR window leaves the current one reading as proven", () => {
    /*
     * Two accounts, deliberately. `verifiedThrough` stops at the FIRST untrusted
     * day and never resumes, so one account cannot be broken in June and sound
     * in July — a single-account fixture makes both halves weak and proves
     * nothing about which one the composite is naming.
     */
    const solid = addAccount("a", "Chase Checking", "checking");
    const shaky = addAccount("b", "Robinhood Cash", "checking");
    const cat = addKindedCategory("c-food", "Fixture Food", "expense");
    const file = addFile("f1", "both.pdf", "chase-checking-statement-pdf");
    addDays(solid, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-31", basis: "derived" }]);
    addDays(shaky, [{ day: "2026-06-01", basis: "anchored" }, { day: "2026-06-15", basis: "derived_unverified" }]);
    categorize(addTxn(shaky, "2026-06-20", { importFileId: file }), cat);
    categorize(addTxn(solid, "2026-07-10", { importFileId: file }), cat);
    readThrough(solid, JUL.to);
    readThrough(shaky, JUL.to);

    const p = provenanceFor(bundle.db, {
      kind: "allSpend",
      ...JUL,
      label: "Jul 2026",
      against: { ...JUN, label: "Jun 2026" },
    })!;
    expect(p.verdict).toBe("unverified");
    expect(p.inputs[0]!.verdict).not.toBe(p.verdict);
    expect(p.inputs[1]!.verdict).toBe("unverified");
  });

  /** An empty half is an absence, and it says so rather than hiding. */
  test("a window with nothing in it is named as having no basis", () => {
    const { acct, cat, file } = twoMonths();
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);

    const p = provenanceFor(bundle.db, {
      kind: "allSpend",
      ...JUL,
      label: "Jul 2026",
      against: { ...JUN, label: "Jun 2026" },
    })!;
    expect(p.headline).toMatch(/Jun 2026 holds 0 rows/);
    expect(p.inputs[1]!.verdict).toBe("unknown");
  });

  /** Without `against` it is the plain single-window total it has always been. */
  test("no comparison window means no comparison sentence", () => {
    const { acct, cat, file } = twoMonths();
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);

    const p = provenanceFor(bundle.db, { kind: "allSpend", ...JUL, label: "Jul 2026" })!;
    expect(p.headline).not.toMatch(/compares two windows/);
    expect(p.inputs).toEqual([]);
  });

  /**
   * The union bounds decide which day `accountCoverage` is asked about. Asked
   * about the EARLIER window's end, every row in the later one would be graded
   * against a frontier that has not reached it yet.
   */
  test("the earlier window may be the one passed as the comparison", () => {
    const { acct, cat, file } = twoMonths();
    categorize(addTxn(acct, "2026-06-10", { importFileId: file }), cat);
    categorize(addTxn(acct, "2026-07-10", { importFileId: file }), cat);

    const forward = provenanceFor(bundle.db, { kind: "allSpend", ...JUL, against: { ...JUN } })!;
    const backward = provenanceFor(bundle.db, { kind: "allSpend", ...JUN, against: { ...JUL } })!;
    expect(forward.verdict).toBe("derived");
    expect(backward.verdict).toBe("derived");
    expect(forward.checkedThrough).toBe(backward.checkedThrough);
  });

  /*
   * ⛔ A comparison writes its OWN headline and borrows only the combined
   * proof's date, so the sentence saying that date is his count's was dropped:
   * "Checked through" printed the last day Cash on Hand rests on the balance he
   * typed as though a document had checked it. Net worth's day and net worth's
   * sentence, here too (owner decision 2026-09-28, handoff §6A 28) — whether his
   * count is all there is or sits beside a check that runs past it.
   */
  test("a comparison dated by his count says the date is his word", () => {
    const cat = addKindedCategory("c-food", "Fixture Food", "expense");
    const coh = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(coh, "2026-08-03", "manual");
    addDays(coh, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    categorize(addTxn(coh, "2026-08-11"), cat);
    readThrough(coh, "2026-08-31");
    const compared = () =>
      provenanceFor(bundle.db, {
        kind: "allSpend",
        from: "2026-08-01",
        to: "2026-08-31",
        label: "Aug 2026",
        against: { ...JUL, label: "Jul 2026" },
      })!;
    const COUNT_NOTE =
      / The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check\.$/;

    const alone = compared();
    expect(alone.checkedThrough).toBe("2026-08-10");
    expect(alone.headline).toMatch(/^This compares two windows/);
    expect(alone.headline).toMatch(COUNT_NOTE);

    const sofi = addAccount("sofi", "SoFi Checking", "checking");
    const file = addFile("f1", "sofi.pdf", "chase-checking-statement-pdf");
    addDays(sofi, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-08-21", basis: "derived" },
    ]);
    categorize(addTxn(sofi, "2026-07-10", { importFileId: file }), cat);
    readThrough(sofi, "2026-08-31");

    const beside = compared();
    expect(beside.checkedThrough).toBe("2026-08-10");
    expect(beside.headline).toMatch(COUNT_NOTE);
  });
});

/* ── a count of one ───────────────────────────────────────────────────── */

/**
 * 🔴 THREE PROOFS PRINTED "1" BESIDE A PLURAL NOUN, each beside a sibling that
 * already agreed with its count: the net-worth hole's own sentence says "holds
 * 1 row", the holding's sources say "1 recorded buy or sell". None is live on
 * the owner's ledger or the e2e fixture (measured 2026-09-15: no account with
 * rows and no balance, no statement gap of a cent, no holding whose one trade
 * disagrees with it) — every one is a shape the next import can make.
 */
describe("provenanceFor — a count of one keeps its numeral and a singular noun", () => {
  test("a hole of ONE row is one row, in the account's line as in the sentence", () => {
    const hole = addAccount("b", "Wells Fargo Everyday Checking", "checking");
    addTxn(hole, "2026-08-02", { cents: 150_000 });

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    // ⚖️ no balance of any kind is "no balance" — "recorded" is a statement's (§6A 50), as on the cards-owed proof
    expect(p.inputs.find((i) => i.label === "Wells Fargo Everyday Checking")!.detail).toBe(
      "1 row but no balance — not in this total",
    );
    expect(p.headline).toContain("holds 1 row worth $1,500.00 that this total cannot see, because it has no balance.");

    addTxn(hole, "2026-08-03", { cents: -50_000 });
    expect(
      provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!.inputs.find(
        (i) => i.label === "Wells Fargo Everyday Checking",
      )!.detail,
    ).toBe("2 rows but no balance — not in this total");
  });

  test.each([
    [1, "1 cent"],
    [-1, "-1 cent"],
    [2, "2 cents"],
  ])("a statement gap of %i reads %s", (gapCents, detail) => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "s.pdf", "chase-checking-statement-pdf");
    addPeriod("p1", acct, file, "2026-07-01", "2026-07-31", "gap");
    bundle.db.run(sql`update statement_periods set gap_cents = ${gapCents} where id = 'p1'`);

    const p = provenanceFor(bundle.db, { kind: "statementPeriod", id: "p1" })!;
    expect(p.sources.find((s) => s.label === "unexplained difference")!.detail).toBe(detail);
  });

  test("ONE trade that does not close is one buy or sell, not 'buys and sells'", () => {
    const acct = addAccount("rh", "Robinhood Brokerage", "investment");
    addHolding(acct, "AAPL", "stock", 300000000);
    addHoldingEvent(acct, "AAPL", "stock", "2025-01-02", 150000000);
    addPrice("AAPL", "stock", TODAY, 100);

    const one = provenanceFor(bundle.db, { kind: "holding", symbol: "AAPL", assetType: "stock", day: TODAY })!;
    expect(one.headline).toContain("1 recorded buy or sell does not sum to the 3 on file");
    expect(one.headline).not.toContain("1 recorded buys");

    addHoldingEvent(acct, "AAPL", "stock", "2025-02-02", 50000000);
    const two = provenanceFor(bundle.db, { kind: "holding", symbol: "AAPL", assetType: "stock", day: TODAY })!;
    expect(two.headline).toContain("2 recorded buys and sells do not sum to the 3 on file");
  });
});

/* ── market value that no holding prices ──────────────────────────────── */

/**
 * 🔴 "PRICED FROM HOLDINGS" OF AN ACCOUNT NO HOLDING PRICES. `market_value` is
 * every investment account; `derivesFromHoldings` is the rule for which of them
 * a holding prices — the branch the rebuild takes, and the one
 * `accountBalanceProvenance` and /imports' coverage row already read. An
 * investment account with no holding events is a recorded balance held flat,
 * and three more surfaces still said holdings priced it:
 *
 *  - the net-worth popover's per-account line ("priced from holdings") and its
 *    count ("1 is priced from holdings"), which the trust card prints verbatim;
 *  - every summed-rows total — category, merchant, spending, account rows —
 *    "N are priced from holdings rather than checked by arithmetic";
 *  - the badge's accessible name wherever a `market_value` proof set no badge
 *    word: "How X is known — it is priced from holdings, not checked by
 *    arithmetic" (`VERDICT_PRESENTATION.market_value.ariaSuffix`), on a row's
 *    sheet, a statement period and a total entirely in market value.
 *
 * Latent on the owner's ledger and the e2e fixture (measured 2026-09-15: every
 * investment account has holding events); AccountForm creates one — type
 * investment, "Current balance (optional)".
 */
describe("provenanceFor — market value that no holding prices", () => {
  /** an investment account with a balance recorded — by his hand unless `source` says whose — and no holding events */
  function heldAccount(id: string, name: string, source = "manual"): string {
    const acct = addAccount(id, name, "investment");
    addAnchor(acct, "2026-07-01", source);
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "carried" },
    ]);
    return acct;
  }

  /** an investment account a holding prices */
  function pricedAccount(id: string, name: string): string {
    const acct = addAccount(id, name, "investment");
    addHoldingEvent(acct, "AAPL", "stock", "2026-07-01", 100_000_000);
    addDays(acct, [
      { day: "2026-07-01", basis: "derived" },
      { day: "2026-07-10", basis: "derived" },
    ]);
    return acct;
  }

  const name = (label: string, p: { verdict: ProvenanceVerdict; badgeWord?: string }): string =>
    provenanceTriggerName(label, p.verdict as PresentedVerdict, p.badgeWord);

  /** no import dates an investment account, so a total over one is read through the ledger's day (`readThrough`) */
  const readLedgerThrough = (day: string): void => readThrough(addAccount("ledger", "Chase Checking", "checking"), day);

  test("net worth names each account by what values it, and counts them apart", () => {
    heldAccount("held", "Brokerage");
    // a balance he typed on an account holdings price is no held count (his ledger's are all on such accounts)
    addAnchor(pricedAccount("priced", "Robinhood Brokerage"), "2026-07-01", "manual");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    const detail = (label: string) => p.inputs.find((i) => i.label === label)!.detail;
    expect(detail("Robinhood Brokerage")).toBe("priced from holdings");
    // ⚖️ a value he typed is one he counted (his answer, 2026-10-05) — as its own balance proof says
    expect(detail("Brokerage")).toBe("held at the balance you counted on Jul 1, 2026");
    expect(p.headline).toContain("1 is priced from holdings, 1 is held at a balance you counted");
  });

  test("net worth with only held accounts never says holdings price one", () => {
    heldAccount("held-a", "Brokerage");
    heldAccount("held-b", "Old IRA");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    expect(p.headline).not.toContain("priced from holdings");
    expect(p.headline).toContain("2 are held at balances you counted");
    expect(p.inputs.map((i) => i.detail)).toEqual([
      "held at the balance you counted on Jul 1, 2026",
      "held at the balance you counted on Jul 1, 2026",
    ]);
  });

  /*
   * 🔴 "COUNTED" IN ITS OWN POPOVER, "RECORDED" EVERYWHERE ELSE. b9de5e6 made a held value he typed read "the balance
   * you counted on Sep 1, 2026, held forward" on its balance proof, and four more surfaces naming the same value kept
   * "recorded": net worth's line ("held at its recorded balance") and count ("1 is held at its recorded balance"), a
   * rows total ("held at a recorded balance rather than checked by arithmetic") and /imports' coverage row (review,
   * 2026-10-05, through the real services: `createAccount` investment, `addManualAnchor` $1,000.00 for Sep 1).
   *
   * ⛔ ONE rule decides the verb on all five: the balance the day holds (`heldBalanceAnchor`) — a statement's keeps
   * "recorded", and a live reading's too.
   */
  test("a value a statement recorded keeps 'recorded', and net worth counts it apart from one he counted", () => {
    heldAccount("held-a", "Brokerage");
    heldAccount("held-b", "Old 401k", "statement");
    heldAccount("held-c", "Old IRA", "statement");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;
    const detail = (label: string) => p.inputs.find((i) => i.label === label)!.detail;
    expect(detail("Brokerage")).toBe("held at the balance you counted on Jul 1, 2026");
    expect(detail("Old 401k")).toBe("held at its recorded balance");
    expect(detail("Old IRA")).toBe("held at its recorded balance");
    expect(p.headline).toContain("2 are held at their recorded balances, 1 is held at a balance you counted");
  });

  test("every surface names the balance its own day holds: a statement's, then his count, then a live reading", () => {
    const acct = addAccount("held", "Brokerage", "investment");
    addAnchor(acct, "2026-07-01", "statement");
    addAnchor(acct, "2026-07-05", "manual");
    addAnchor(acct, "2026-08-05", "live");
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-03", basis: "carried" },
      { day: "2026-07-05", basis: "anchored" },
      { day: "2026-07-08", basis: "carried" },
      // rebuilt on Aug 5: that day's live reading stands for that day only
      { day: "2026-08-04", basis: "carried" },
      { day: "2026-08-05", basis: "anchored" },
    ]);
    const balance = (day: string) => provenanceFor(bundle.db, { kind: "accountBalance", accountId: acct, day })!.headline;
    expect(balance("2026-07-03")).toContain("is the balance recorded on Jul 1, 2026, held forward.");
    expect(balance("2026-07-08")).toContain("is the balance you counted on Jul 5, 2026, held forward.");

    const cat = addCategory("c-buys", "Fixture Buys");
    const file = addFile("f1", "b.pdf", "robinhood-brokerage-statement-pdf");
    for (const day of ["2026-07-03", "2026-07-08", "2026-07-08"]) categorize(addTxn(acct, day, { importFileId: file }), cat);
    const rows = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(rows.headline).toContain(
      "1 is held at a recorded balance rather than checked by arithmetic, 2 are held at a balance you counted rather than checked by arithmetic",
    );

    const detail = (day: string) =>
      provenanceFor(bundle.db, { kind: "netWorth", day })!.inputs.find((i) => i.label === "Brokerage")!.detail;
    expect(detail("2026-08-04")).toBe("held at the balance you counted on Jul 5, 2026");
    expect(detail("2026-08-05")).toBe("held at its recorded balance");
    expect(detail("2026-07-03")).toBe("held at its recorded balance");
  });

  test("a total of rows on a held account says so, and its badge's name drops holdings", () => {
    const held = heldAccount("held", "Brokerage");
    const cat = addCategory("c-buys", "Fixture Buys");
    const file = addFile("f1", "b.pdf", "robinhood-brokerage-statement-pdf");
    categorize(addTxn(held, "2026-07-10", { importFileId: file }), cat);
    readLedgerThrough("2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.verdict).toBe("market_value");
    expect(p.headline).not.toContain("priced from holdings");
    expect(p.headline).toContain("1 is held at a balance you counted rather than checked by arithmetic");
    expect(p.badgeWord).toBe("market value");
    expect(name("Fixture Buys", p)).not.toContain("priced from holdings");
  });

  test("a total over both kinds counts each, and still names no holdings on its badge", () => {
    const held = heldAccount("held", "Brokerage");
    const priced = pricedAccount("priced", "Robinhood Brokerage");
    const cat = addCategory("c-buys", "Fixture Buys");
    const file = addFile("f1", "b.pdf", "robinhood-brokerage-statement-pdf");
    categorize(addTxn(held, "2026-07-10", { importFileId: file }), cat);
    categorize(addTxn(priced, "2026-07-10", { importFileId: file }), cat);
    categorize(addTxn(priced, "2026-07-10", { importFileId: file }), cat);
    readLedgerThrough("2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.headline).toContain(
      "2 are priced from holdings rather than checked by arithmetic, 1 is held at a balance you counted rather than checked by arithmetic",
    );
    expect(p.badgeWord).toBe("market value");
  });

  test("a total entirely priced from holdings keeps its sentence and its unset badge", () => {
    const priced = pricedAccount("priced", "Robinhood Brokerage");
    const cat = addCategory("c-buys", "Fixture Buys");
    const file = addFile("f1", "b.pdf", "robinhood-brokerage-statement-pdf");
    categorize(addTxn(priced, "2026-07-10", { importFileId: file }), cat);
    readLedgerThrough("2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.headline).toContain("1 is priced from holdings rather than checked by arithmetic");
    expect(p.badgeWord).toBeUndefined();
    expect(name("Fixture Buys", p)).toContain("priced from holdings");
  });

  test("a row's sheet: the badge's name claims holdings only where a holding prices the account", () => {
    const file = addFile("f1", "b.pdf", "robinhood-brokerage-statement-pdf");
    const heldRow = provenanceFor(bundle.db, {
      kind: "transaction",
      id: addTxn(heldAccount("held", "Brokerage"), "2026-07-10", { importFileId: file }),
    })!;
    expect(heldRow.verdict).toBe("market_value");
    expect(heldRow.badgeWord).toBe("market value");
    expect(name("This row", heldRow)).not.toContain("priced from holdings");

    const pricedRow = provenanceFor(bundle.db, {
      kind: "transaction",
      id: addTxn(pricedAccount("priced", "Robinhood Brokerage"), "2026-07-10", { importFileId: file }),
    })!;
    expect(pricedRow.verdict).toBe("market_value");
    expect(pricedRow.badgeWord).toBeUndefined();
  });

  test("a statement period that records a value: the same branch", () => {
    const file = addFile("f1", "b.pdf", "robinhood-brokerage-statement-pdf");
    addPeriod("held-p", heldAccount("held", "Brokerage"), file, "2026-07-01", "2026-07-31", "value_anchor");
    addPeriod("priced-p", pricedAccount("priced", "Robinhood Brokerage"), file, "2026-07-01", "2026-07-31", "value_anchor");

    const held = provenanceFor(bundle.db, { kind: "statementPeriod", id: "held-p" })!;
    expect(held.verdict).toBe("market_value");
    expect(held.badgeWord).toBe("market value");
    expect(name("This statement", held)).not.toContain("priced from holdings");

    const priced = provenanceFor(bundle.db, { kind: "statementPeriod", id: "priced-p" })!;
    expect(priced.badgeWord).toBeUndefined();
  });
});

/* ── a balance he typed, and nothing more ─────────────────────────────── */

/**
 * 🔴 "CHECKED THROUGH 2026-08-03" OF A BALANCE HE TYPED. Measured 2026-09-16 on
 * a copy of the real ledger: Cash on Hand is a checking account with no
 * statement period and no import file, one balance typed by hand on Aug 3, 2026
 * ($5,000.00), carried Aug 4–10, and the hand-entered car down payment on Aug
 * 11. Its /accounts/[id] header asks about Aug 11, and the popover read "nothing
 * checks it" above "Checked through 2026-08-03." — the only thing on Aug 3 is
 * his own count. The proof beside "1 transaction landed in Cash on Hand since it
 * opened" printed the same date, and a day carried from the count (Aug 5) read
 * "adds up".
 *
 * ⛔ A count is the owner's evidence (`manual`, "you entered it"), never a check.
 * What the popover says instead is what the day stands on: the balance he
 * counted, named by its date — "counted", ONE verb for a balance he typed (his
 * answer, 2026-10-05), as net worth says it.
 */
describe("provenanceFor — a balance he typed checks nothing", () => {
  function cashOnHand(): string {
    const id = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-11"); // entered by hand, as the car down payment was
    return id;
  }

  const balance = (accountId: string, day: string) =>
    provenanceFor(bundle.db, { kind: "accountBalance", accountId, day })!;
  // the ids of an account's rows, oldest first
  const rowsOf = (accountId: string): string[] =>
    bundle.db
      .select({ id: transactions.id, accountId: transactions.accountId, postedOn: transactions.postedOn })
      .from(transactions)
      .all()
      .filter((t) => t.accountId === accountId)
      .sort((a, b) => (a.postedOn < b.postedOn ? -1 : a.postedOn > b.postedOn ? 1 : 0))
      .map((t) => t.id);

  /*
   * ⚖️ His call, 2026-10-02 (handoff §6A 33): DATE BOTH, in net worth's words. The proof beside "1 transaction
   * landed" was dated where his count stops standing (§6A 28) while this one, over the same Cash on Hand on the same
   * page, printed no date at all — measured 2026-10-05 on a temp ledger with a $5,000.00 count typed for Aug 3 and
   * the down payment entered by hand on Aug 11: rows "Checked through 2026-08-10" with net worth's sentence, balance
   * nothing. Every day of its balance carries net worth's day and net worth's sentence; the verdict stays what the
   * day is.
   */
  const COUNT_NOTE =
    " The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check.";

  test("the newest day names the balance he counted, dated where his count stops standing, in net worth's words", () => {
    const p = balance(cashOnHand(), "2026-08-11");
    expect(p.verdict).toBe("unverified");
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.headline).toBe(
      `Replayed past the balance you counted on Aug 3, 2026, so nothing checks Cash on Hand on Aug 11, 2026. The rows are real; the total is unconfirmed.${COUNT_NOTE}`,
    );
  });

  test("a day carried from his count is as proven as the count — his, not 'adds up' — and dated by it", () => {
    const p = balance(cashOnHand(), "2026-08-05");
    expect(p.verdict).toBe("counted");
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.headline).toBe(
      `Cash on Hand had no activity to replay on Aug 5, 2026, so the balance you counted on Aug 3, 2026 was carried forward.${COUNT_NOTE}`,
    );
  });

  test("the day he typed it is his, and its date is his count's, never a check's", () => {
    const p = balance(cashOnHand(), "2026-08-03");
    expect(p.verdict).toBe("counted");
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.headline.endsWith(COUNT_NOTE)).toBe(true);
  });

  /*
   * ⛔ One account, one day, one sentence — on every proof that names its balance or its rows, and in net worth. The
   * date and the sentence are `footingBounds`', so a caller cannot print the day without saying whose word it is.
   */
  test("its balance, its rows, a row's own sheet and net worth carry one date and one sentence", () => {
    const id = cashOnHand();
    const proofs = [
      balance(id, "2026-08-11"),
      provenanceFor(bundle.db, { kind: "accountBalance", accountId: id })!,
      provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!,
      provenanceFor(bundle.db, { kind: "transaction", id: rowsOf(id)[0]! })!,
      provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!,
    ];
    for (const p of proofs) {
      expect(p.checkedThrough).toBe("2026-08-10");
      expect(p.headline.endsWith(COUNT_NOTE)).toBe(true);
    }
  });

  /*
   * 🔴 THE ONE PROOF OF HIS COUNT STILL UNDATED. With §6A 33 the balance and "1 transaction landed" on
   * /accounts/<Cash on Hand> both read "Checked through 2026-08-10" and net worth's sentence, while the sheet of the
   * one row they sum — the $5,000.00 down payment he entered by hand on Aug 11 — printed no date at all.
   *
   * ⚖️ His answer, 2026-10-05: a single row's sheet on a count-only account is DATED too — the same day, the same
   * sentence, from the same rule (`footingBounds` over that account, when `countFooting` says it rests on his count).
   * The verdict stays the row's: he entered it.
   */
  test("a row he entered by hand on it is dated where his count stops standing, in net worth's words", () => {
    const sheet = provenanceFor(bundle.db, { kind: "transaction", id: rowsOf(cashOnHand())[0]! })!;
    expect(sheet.verdict).toBe("manual");
    expect(sheet.checkedThrough).toBe("2026-08-10");
    expect(sheet.headline).toBe(
      `You entered this row by hand. No statement carries it, so nothing else can confirm it.${COUNT_NOTE}`,
    );
  });

  /*
   * ⚖️ His answer, 2026-10-07 (§6A 50): one account, two things he typed, two words. The balance he counted reads
   * "you counted it"; the down payment he entered by hand — its sheet and the count of its rows — keeps "you entered
   * it". The verdict says which, so every badge, name and group reads it from `VERDICT_PRESENTATION` alone.
   */
  test("⚖️ on one wallet, the balance is counted and the row he typed is entered", () => {
    const id = cashOnHand();
    expect(balance(id, "2026-08-03").verdict).toBe("counted");
    expect(balance(id, "2026-08-05").verdict).toBe("counted");
    expect(provenanceFor(bundle.db, { kind: "transaction", id: rowsOf(id)[0]! })!.verdict).toBe("manual");
    expect(provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!.verdict).toBe("manual");
  });

  test("an imported row on it is dated by the same rule", () => {
    const id = cashOnHand();
    const csv = addFile("f-coh", "wallet-export.csv", "generic-csv");
    const imported = addTxn(id, "2026-08-11", { importFileId: csv, cents: 0 });

    const sheet = provenanceFor(bundle.db, { kind: "transaction", id: imported })!;
    expect(sheet.verdict).toBe("unverified");
    expect(sheet.checkedThrough).toBe("2026-08-10");
    expect(sheet.headline).toBe(
      `This row came from wallet-export.csv — which carries no balances, so nothing checks the total it sits in.${COUNT_NOTE}`,
    );
  });

  test("a row he entered by hand on an account a statement checks is dated by no count", () => {
    const id = addAccount("stmt", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260803-statements-3522-.pdf", "chase-checking-statement-pdf");
    addAnchor(id, "2026-08-03", "statement", pdf);
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    const typed = addTxn(id, "2026-08-11");

    const sheet = provenanceFor(bundle.db, { kind: "transaction", id: typed })!;
    expect(sheet.checkedThrough).toBeNull();
    expect(sheet.headline).toBe("You entered this row by hand. No statement carries it, so nothing else can confirm it.");
  });

  /*
   * 🔴 A DAY BEFORE HIS COUNT READ "REPLAYED PAST" IT. A row he enters for a day before the balance he counted is
   * replayed BACKWARDS from that count (`deriveBackward`), and the day read "Replayed past the last recorded
   * balance" — the direction of a day after a balance, naming no balance at all. /imports and net worth already say
   * those days are "replayed backwards from it" (`beforeFirstBalance`).
   */
  function countedAfterARow(): string {
    const id = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-07-31", basis: "derived_unverified" },
      { day: "2026-08-01", basis: "derived_unverified" },
      { day: "2026-08-02", basis: "derived_unverified" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    addTxn(id, "2026-08-01"); // entered by hand for a day before his count
    addTxn(id, "2026-08-11");
    return id;
  }

  test("a day before his count is replayed backwards from it, named as his count, and dated by it", () => {
    const p = balance(countedAfterARow(), "2026-08-01");
    expect(p.verdict).toBe("unverified");
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.headline).toBe(
      `Replayed backwards from the balance you counted on Aug 3, 2026, so nothing checks Cash on Hand on Aug 1, 2026. The rows are real; the total is unconfirmed.${COUNT_NOTE}`,
    );
  });

  // ⛔ the direction is the replay's, whoever's balance it starts from; a statement's balance keeps its words
  test("a day before a statement's first balance is replayed backwards from it, in the statement's words", () => {
    const id = addAccount("rh", "Robinhood Cash", "checking");
    const pdf = addFile("f1", "robinhood-2023-12.pdf", "robinhood-statement-pdf");
    addAnchor(id, "2023-12-31", "statement", pdf);
    addDays(id, [
      { day: "2023-12-05", basis: "derived_unverified" },
      { day: "2023-12-06", basis: "derived_unverified" },
      { day: "2023-12-31", basis: "anchored" },
      { day: "2024-01-02", basis: "carried" },
    ]);
    addTxn(id, "2023-12-06", { importFileId: pdf });

    expect(balance(id, "2023-12-06").headline).toBe(
      "Replayed backwards from the balance recorded on Dec 31, 2023, so nothing checks Robinhood Cash on Dec 6, 2023. The rows are real; the total is unconfirmed.",
    );
  });

  /*
   * ⚖️ ONE verb for a balance he typed (his answer, 2026-10-05) on every sentence of the balance proof that names
   * one: a replay that starts from his count, and a replay that missed it. A document's balance keeps its words.
   */
  test("a replay from his count that a statement checked names the count it started from", () => {
    const id = addAccount("landed", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260810-statements-3522-.pdf", "chase-checking-statement-pdf");
    addAnchor(id, "2026-08-03", "manual");
    addAnchor(id, "2026-08-10", "statement", pdf);
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "derived" },
      { day: "2026-08-10", basis: "anchored" },
    ]);
    addTxn(id, "2026-08-05", { importFileId: pdf });

    const p = balance(id, "2026-08-05");
    expect(p.verdict).toBe("derived");
    expect(p.headline).toBe(
      "Every transaction was replayed forward from the balance you counted on Aug 3, 2026 and landed exactly on the next one, through Aug 5, 2026.",
    );
  });

  test("a statement's balance keeps its words, replayed from or missed", () => {
    const id = addAccount("stmt", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260810-statements-3522-.pdf", "chase-checking-statement-pdf");
    addAnchor(id, "2026-08-01", "statement", pdf);
    addAnchor(id, "2026-08-10", "statement", pdf);
    addAnchor(id, "2026-08-20", "statement", pdf);
    addDays(id, [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-05", basis: "derived" },
      { day: "2026-08-10", basis: "anchored" },
      { day: "2026-08-15", basis: "gap" },
      { day: "2026-08-20", basis: "anchored" },
    ]);
    addTxn(id, "2026-08-05", { importFileId: pdf });

    expect(balance(id, "2026-08-05").headline).toBe(
      "Every transaction was replayed forward from a recorded balance and landed exactly on the next one, through Aug 5, 2026.",
    );
    expect(balance(id, "2026-08-15").headline).toBe(
      "The replay did NOT land on Chase Checking's next recorded balance. Money is provably missing or double-counted around Aug 15, 2026.",
    );
  });

  /*
   * ⛔ The count of its rows is a summed total, so it is dated where his count
   * stops standing and says the day is his word — net worth's day and sentence
   * (owner decision 2026-09-28, handoff §6A 28). It is still no check: the
   * verdict stays his.
   */
  test("the count of its rows is dated where his count stops standing, as his word", () => {
    const p = provenanceFor(bundle.db, { kind: "accountRows", accountId: cashOnHand() })!;
    expect(p.verdict).toBe("manual");
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.headline).toMatch(
      / The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check\.$/,
    );
  });

  /*
   * 🔴 …BUT A COUNT STILL BOUNDS THE PICTURE. Once his count stopped being a
   * `verifiedThrough`, Cash on Hand left the "oldest account" comparison
   * altogether, and the date ran past the day the same popover calls unchecked:
   * measured 2026-09-16 on a copy of the real ledger with SoFi (the Jul 31
   * bound) set aside, net worth read "Checked through 2026-08-12" beside
   * "Cash on Hand — you counted it on Aug 3, 2026, and nothing checks it since
   * Aug 11, 2026". The picture stands on his count through Aug 10 and on
   * nothing after, and the sentence says the date is his count's, not a check.
   */
  test("net worth is bounded where his count stops standing, and says the date is his count's", () => {
    cashOnHand();
    const sofi = addAccount("sofi", "SoFi Checking", "checking");
    addDays(sofi, [
      { day: "2026-08-20", basis: "anchored" },
      { day: "2026-08-21", basis: "derived" },
    ]);
    addTxn(sofi, "2026-08-21");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!;
    expect(p.checkedThrough).toBe("2026-08-10");
    expect(p.inputs.find((i) => i.label === "Cash on Hand")!.detail).toBe(
      "you counted it on Aug 3, 2026, and nothing checks it since Aug 11, 2026",
    );
    expect(p.headline).toMatch(
      / The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check\.$/,
    );
  });

  test("a checked account older than his count keeps the date, and the count is not mentioned", () => {
    cashOnHand();
    const sofi = addAccount("sofi", "SoFi Checking", "checking");
    addDays(sofi, [
      { day: "2026-07-30", basis: "anchored" },
      { day: "2026-07-31", basis: "derived" },
    ]);
    addTxn(sofi, "2026-07-31");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!;
    expect(p.checkedThrough).toBe("2026-07-31");
    expect(p.headline).not.toMatch(/checked through|counted/);
  });

  test("an account resting on his count to its last day bounds nothing, like one he counts outright", () => {
    const id = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-09-16", basis: "carried" },
    ]);
    addTxn(id, "2026-08-03");
    const sofi = addAccount("sofi", "SoFi Checking", "checking");
    addDays(sofi, [
      { day: "2026-08-20", basis: "anchored" },
      { day: "2026-08-21", basis: "derived" },
    ]);
    addTxn(sofi, "2026-08-21");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!;
    expect(p.checkedThrough).toBe("2026-08-21");
    expect(p.inputs.find((i) => i.label === "Cash on Hand")!.detail).toBe(
      "you counted it on Aug 3, 2026, and nothing else checks it",
    );
  });

  /*
   * 🔴 A SECOND COUNT BROUGHT THE CHECK BACK. Measured 2026-09-16 on a copy of
   * the real ledger: recording Cash on Hand at $0.00 for Aug 12 — after the
   * $5,000.00 down payment he entered by hand on Aug 11 — made Aug 4–11
   * `derived`, and every proof read "Checked through 2026-08-12", the carried
   * days after it "adds up", and net worth "8 of 13 accounts add up against a
   * document". His own row reconciling two of his own counts is his word.
   */
  function recounted(): string {
    const id = addAccount("coh", "Cash on Hand", "checking");
    addAnchor(id, "2026-08-03", "manual");
    addAnchor(id, "2026-08-12", "manual");
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "derived" },
      { day: "2026-08-11", basis: "derived" },
      { day: "2026-08-12", basis: "anchored" },
      { day: "2026-08-20", basis: "carried" },
    ]);
    return id;
  }

  test("a replay between two of his counts is his word, and dates no check", () => {
    const id = recounted();
    addTxn(id, "2026-08-11");
    // an imported row on a replayed day, so its sheet has a day line to read
    const csv = addFile("f-coh", "wallet-export.csv", "generic-csv");
    const imported = addTxn(id, "2026-08-05", { importFileId: csv, cents: 0 });

    const replayed = balance(id, "2026-08-05");
    expect(replayed.verdict).toBe("counted");
    expect(replayed.checkedThrough).toBeNull();
    expect(replayed.headline).toBe(
      "Every transaction was replayed forward from the balance you counted on Aug 3, 2026 and landed exactly on the one you counted on Aug 12, 2026. Both are your own counts, so nothing else confirms Cash on Hand on Aug 5, 2026.",
    );
    expect(balance(id, "2026-08-12").checkedThrough).toBeNull();

    const carried = balance(id, "2026-08-20");
    expect(carried.verdict).toBe("counted");
    expect(carried.checkedThrough).toBeNull();
    expect(carried.headline).toBe(
      "Cash on Hand had no activity to replay on Aug 20, 2026, so the balance you counted on Aug 12, 2026 was carried forward.",
    );

    expect(provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!.checkedThrough).toBeNull();
    const sheet = provenanceFor(bundle.db, { kind: "transaction", id: imported })!;
    expect(sheet.inputs[0]!.verdict).toBe("counted");
    expect(sheet.verdict).not.toBe("derived");
    // resting on his count to its newest day, it bounds nothing — as net worth: no date, no count sentence
    expect(sheet.checkedThrough).toBeNull();
    expect(sheet.headline).not.toMatch(/your word, not a check/);
  });

  test("net worth does not count two of his counts as an account that adds up", () => {
    const id = recounted();
    addTxn(id, "2026-08-11");

    const p = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!;
    const line = p.inputs.find((i) => i.label === "Cash on Hand")!;
    expect(line.verdict).toBe("unverified");
    expect(line.detail).toBe("you counted it on Aug 12, 2026, and nothing else checks it");
    expect(p.headline).toMatch(/^0 of 1 accounts add up against a document/);
    expect(p.checkedThrough).toBeNull();
  });

  test("a statement's balance carried forward still adds up, and dates its check", () => {
    const id = addAccount("stmt", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260803-statements-3522-.pdf", "chase-checking-statement-pdf");
    addAnchor(id, "2026-08-03", "statement", pdf);
    addDays(id, [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
    ]);
    addTxn(id, "2026-08-03", { importFileId: pdf });

    const p = balance(id, "2026-08-05");
    expect(p.verdict).toBe("derived");
    expect(p.checkedThrough).toBe("2026-08-03");
    expect(p.headline).toBe("Chase Checking had no activity to replay on Aug 5, 2026, so the last known balance was carried forward.");
  });

  test("a balance he typed that the replay lands on is checked by the replay", () => {
    const id = addAccount("landed", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260731-statements-3522-.pdf", "chase-checking-statement-pdf");
    addAnchor(id, "2026-07-31", "statement", pdf);
    addAnchor(id, "2026-08-03", "manual");
    addDays(id, [
      { day: "2026-07-31", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
    ]);
    addTxn(id, "2026-08-02", { importFileId: pdf });

    const carried = balance(id, "2026-08-05");
    expect(carried.verdict).toBe("derived");
    expect(carried.checkedThrough).toBe("2026-08-03");
    expect(balance(id, "2026-08-03").checkedThrough).toBe("2026-08-03");
  });

  /*
   * ⛔ Only a balance standing on his count takes net worth's day (§6A 33). An account a statement checks again after
   * a break keeps the newest day its own chain closes — net worth's bound for it stops before the break, and a day
   * that adds up dated before itself would contradict its own badge.
   */
  test("an account checked again after a break keeps its own chain's date, and no count sentence", () => {
    const id = addAccount("rebroken", "Chase Checking", "checking");
    const pdf = addFile("f1", "20260801-statements-3522-.pdf", "chase-checking-statement-pdf");
    addAnchor(id, "2026-07-01", "statement", pdf);
    addAnchor(id, "2026-08-01", "statement", pdf);
    addDays(id, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "derived" },
      { day: "2026-07-15", basis: "gap" },
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-05", basis: "carried" },
    ]);
    addTxn(id, "2026-07-10", { importFileId: pdf });

    const p = balance(id, "2026-08-05");
    expect(p.checkedThrough).toBe("2026-08-01");
    expect(p.headline).not.toMatch(/your word|counted/);
  });

  /*
   * 🔴 A RECOUNT THAT DOES NOT RECONCILE, DATED BY TWO RULES. `footingThrough`'s count branch took a `broken` account
   * and `countFooting` refused it, so one wallet carried two answers. Measured 2026-10-05 on a temp ledger through the
   * real services (below): grade broken since Aug 4. "2 transactions landed", net worth and the trust card read
   * "Checked through 2026-09-09" and "…the last day Cash on Hand rests on the balance you counted" — five weeks past
   * the break net worth's own line names ("stopped adding up on Aug 4, 2026") — while every day of its balance proof
   * and both rows' sheets printed no date at all.
   *
   * ⚖️ His answer, 2026-10-05: a typed-balance account that BREAKS bounds every "checked through" date the DAY BEFORE
   * IT BROKE, with a sentence saying it broke after that — as a statement chain's `verifiedThrough` stops before its
   * break. ⛔ One rule (`footingThrough`), one day and one sentence on every proof that names it.
   */
  const BROKEN_NOTE =
    " The date it is checked through, Aug 3, 2026, is the last day before Cash on Hand stopped adding up on Aug 4, 2026; until then it rests on the balance you counted on Aug 3, 2026 — your word, not a check.";

  // as he did it: $5,000.00 counted for Aug 3, the down payment by hand, a $40.00 recount that does not add up
  function brokenWallet({
    spentAfterRecount,
    recountCents = 4_000,
  }: {
    spentAfterRecount: boolean;
    recountCents?: number;
  }): string {
    const id = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-04", openingBalanceCents: 500_000 });
    addManualTransaction(bundle.db, { accountId: id, postedOn: "2026-08-11", amountCents: -500_000, description: "Car down payment" });
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-09-01", enteredCents: recountCents });
    if (spentAfterRecount) {
      addManualTransaction(bundle.db, { accountId: id, postedOn: "2026-09-10", amountCents: -1_000, description: "Lunch" });
    }
    return id;
  }

  test("a wallet whose recount does not add up is checked through the day before it broke, on every proof", () => {
    const id = brokenWallet({ spentAfterRecount: true });
    expect(balance(id, "2026-08-20").verdict).toBe("broken");

    const proofs: [string, ReturnType<typeof balance>][] = [
      ...["2026-08-03", "2026-08-20", "2026-09-01", "2026-09-05", "2026-09-10"].map(
        (day): [string, ReturnType<typeof balance>] => [`balance on ${day}`, balance(id, day)],
      ),
      ["balance today", provenanceFor(bundle.db, { kind: "accountBalance", accountId: id })!],
      ["its rows", provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!],
      ...rowsOf(id).map((row): [string, ReturnType<typeof balance>] => [
        `sheet of ${row}`,
        provenanceFor(bundle.db, { kind: "transaction", id: row })!,
      ]),
      ["net worth", provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!],
    ];
    for (const [label, p] of proofs) {
      expect(p.checkedThrough, label).toBe("2026-08-03");
      expect(p.headline.endsWith(BROKEN_NOTE), `${label}: ${p.headline}`).toBe(true);
    }

    // each day still says what it is; the sentence after it says where the date stops, and why
    expect(balance(id, "2026-08-20").headline).toBe(
      `The replay did NOT land on Cash on Hand's next balance, the one you counted on Sep 1, 2026. Money is provably missing or double-counted around Aug 20, 2026.${BROKEN_NOTE}`,
    );
    const [downPayment] = rowsOf(id);
    expect(provenanceFor(bundle.db, { kind: "transaction", id: downPayment! })!.headline).toBe(
      `You entered this row by hand. No statement carries it, so nothing else can confirm it.${BROKEN_NOTE}`,
    );
    // the words net worth's line for it prints, which the sentence borrows
    const line = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!.inputs.find((i) => i.id === id)!;
    expect(line.detail).toBe("stopped adding up on Aug 4, 2026");
    /*
     * 🔴 …and "the balance you counted" read as the recount its own day names. Sep 10's proof named "the balance you
     * counted on Sep 1, 2026", then "…rests on the balance you counted — your word, not a check — before it stopped
     * adding up on Aug 4, 2026" (temp ledger 2026-10-06), which only his Aug 3 count can be. The sentence names it.
     */
    expect(balance(id, "2026-09-10").headline).toBe(
      `Replayed past the balance you counted on Sep 1, 2026, so nothing checks Cash on Hand on Sep 10, 2026. The rows are real; the total is unconfirmed.${BROKEN_NOTE}`,
    );
  });

  /*
   * 🔴 …AND A RECOUNT THAT ADDS UP LEFT THE SAME WORDS NAMING EITHER COUNT. Same wallet, recounted at $0.00 for Sep 1
   * (temp ledger through the real services, 2026-10-06): Aug 20's proof read "Every transaction was replayed forward
   * from the balance you counted on Aug 3, 2026 and landed exactly on the one you counted on Sep 1, 2026. …" and then
   * "The date it is checked through, Sep 9, 2026, is the last day Cash on Hand rests on the balance you counted — your
   * word, not a check." Sep 9 stands on Sep 1's count, not the Aug 3 one the sentence before it named last.
   */
  test("the date's sentence names the count it stands on, beside a proof naming his other count", () => {
    const id = brokenWallet({ spentAfterRecount: true, recountCents: 0 });
    const note =
      " The date it is checked through, Sep 9, 2026, is the last day Cash on Hand rests on the balance you counted on Sep 1, 2026 — your word, not a check.";

    expect(balance(id, "2026-08-20").headline).toBe(
      `Every transaction was replayed forward from the balance you counted on Aug 3, 2026 and landed exactly on the one you counted on Sep 1, 2026. Both are your own counts, so nothing else confirms Cash on Hand on Aug 20, 2026.${note}`,
    );
    for (const p of [
      balance(id, "2026-08-03"),
      provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!,
      provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!,
    ]) {
      expect(p.checkedThrough).toBe("2026-09-09");
      expect(p.headline.endsWith(note), p.headline).toBe(true);
    }
  });

  /*
   * 🔴 …and with nothing spent past the recount the break dated nothing: resting on his count to its newest day, the
   * wallet "bounds nothing", so net worth dated the picture by its other accounts — or not at all — beside its own line
   * "stopped adding up on Aug 4, 2026".
   */
  test("a wallet resting on a recount that does not add up still bounds the picture the day before it broke", () => {
    const id = brokenWallet({ spentAfterRecount: false });

    for (const p of [
      provenanceFor(bundle.db, { kind: "netWorth", day: "2026-09-16" })!,
      provenanceFor(bundle.db, { kind: "accountBalance", accountId: id })!,
      provenanceFor(bundle.db, { kind: "accountRows", accountId: id })!,
    ]) {
      expect(p.checkedThrough).toBe("2026-08-03");
      expect(p.headline.endsWith(BROKEN_NOTE), p.headline).toBe(true);
    }
  });
});

/* ── a total over days its accounts have not been imported through ────── */

/*
 * ⚖️ His decision 72 (2026-10-13, either/or, the recommended answer): a TOTAL over a window some of whose days are past
 * its own read frontier keeps its figure, and its chip reads "partly read" instead of "adds up", with /budgets' coverage
 * line under the figure. 🔴 Measured on his ledger copy 2026-10-13: `/categories/<Food>` for September printed "SPENT ·
 * SEP 1 – 30, 2026 · adds up · $160.72 · 25 transactions" (25 Venture X rows) while Food's budget card on the same page
 * named Aug 12 as the day its accounts are imported through; `/spending` for September chipped "adds up … 43 rows from
 * 3 documents" beside its own What moved naming Aug 12 as the last day every account he spends from was imported
 * through. ⛔ The frontier is the one each page already names: a category's own (`categoryReachFor`, its budget row's),
 * all spending's `spendingCoverageThrough`.
 */
describe("⚖️ decision 72 — a total over days its accounts have not been imported through is partly read", () => {
  const JULY = { from: "2026-07-01", to: "2026-07-31" } as const;
  let fakeToday: string | undefined;
  let food: string;

  beforeEach(() => {
    fakeToday = process.env.MONEYAPP_FAKE_TODAY;
    process.env.MONEYAPP_FAKE_TODAY = "2026-10-13";
    food = addKindedCategory("c-food", "Fixture Food", "expense");
  });

  afterEach(() => {
    if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
    else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
  });

  /** a card imported through `through` — Food on the 10th and on that day, its chain checked to it */
  function cardThrough(through: string, categoryId = food): string {
    const acct = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: through, basis: "derived" }]);
    for (const day of ["2026-07-10", through]) categorize(addTxn(acct, day, { importFileId: file }), categoryId);
    return acct;
  }

  const foodTotal = (window: { from: string; to: string } = JULY) =>
    provenanceFor(bundle.db, { kind: "categorySpend", categoryId: food, ...window })!;
  const allSpend = (window: { from: string; to: string } = JULY) =>
    provenanceFor(bundle.db, { kind: "allSpend", ...window, label: "July 2026" })!;

  test("a window read through its last day adds up, as it always has", () => {
    cardThrough("2026-07-31");
    for (const p of [foodTotal(), allSpend()]) {
      expect(p.verdict).toBe("derived");
      expect(p.partlyRead).toBeUndefined();
      expect(p.headline).not.toMatch(/read only in part/);
    }
  });

  test("one day short of its end it is partly read — 1 day unaccounted, in /budgets' words", () => {
    cardThrough("2026-07-30");
    const line = "spending imported through Jul 30 · 1 day of this period unaccounted";
    for (const p of [foodTotal(), allSpend()]) {
      expect(p.verdict).toBe("partly_read");
      expect(p.badgeWord).toBeUndefined();
      expect(p.partlyRead).toEqual({ uncoveredDays: 1, line });
      expect(p.headline).toBe(
        "This total is the sum of 2 rows from 1 document. A total is only as proven as its weakest row. " +
          `It is read only in part: ${line}, so this total is a lower bound rather than a measurement.`,
      );
    }
    expect(provenanceTriggerName("this spent total", foodTotal().verdict as PresentedVerdict)).toBe(
      "How this spent total is known — it is partly read: not every account behind it has been imported through all of its days",
    );
  });

  test("a running month counts only the days that have happened", () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-07-20";
    cardThrough("2026-07-20");
    expect(foodTotal().verdict).toBe("derived");
    expect(allSpend().verdict).toBe("derived");
  });

  test("…and a running month read two days short of today leaves 2 days, never the 13 still to come", () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-07-20";
    cardThrough("2026-07-18");
    for (const p of [foodTotal(), allSpend()]) {
      expect(p.partlyRead).toEqual({ uncoveredDays: 2, line: "spending imported through Jul 18 · 2 days of this period unaccounted" });
    }
  });

  /*
   * ⛔ One rule with the row: the category page's headline and the /budgets row over the same window count the same
   * days against the same day, and print the same line — the row's own sentence (`budgetCoverageSentence`).
   */
  test("the proof counts the days its /budgets row counts, and prints that row's line", () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-07-20";
    addBudget("b1", food, { startsOn: "2026-07-01" });
    cardThrough("2026-07-18");
    const [row] = budgetPaceStatuses(bundle.db, "2026-07-20");
    const p = foodTotal({ from: row!.bounds.start, to: row!.bounds.end });
    expect(row!.uncoveredDays).toBe(2);
    expect(p.partlyRead).toEqual({ uncoveredDays: row!.uncoveredDays, line: budgetCoverageSentence(row!) });
  });

  /*
   * ⚖️ CASH WALLETS ARE LEFT OUT (owner decision 2026-09-15, the /budgets rule): no import will ever read a wallet's
   * day, so a window spent only from one is as read as it will ever be — "partly read" forever would be a claim no
   * statement could ever correct.
   */
  test("a category spent only from a cash wallet is never partly read", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-07-01", openingBalanceCents: 50_000 });
    addManualTransaction(bundle.db, { accountId: wallet, postedOn: "2026-07-10", amountCents: -1_000, description: "Lunch", categoryId: food });
    const p = foodTotal();
    expect(p.verdict).toBe("manual");
    expect(p.partlyRead).toBeUndefined();
  });

  test("…and a wallet's newer row never vouches for a card it was spent beside", () => {
    cardThrough("2026-07-20");
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-07-01", openingBalanceCents: 50_000 });
    addManualTransaction(bundle.db, { accountId: wallet, postedOn: "2026-07-31", amountCents: -1_000, description: "Lunch", categoryId: food });
    const p = foodTotal();
    // the weakest part is the window, so the badge says that rather than "part you entered"
    expect(p.verdict).toBe("partly_read");
    expect(p.badgeWord).toBeUndefined();
    expect(p.badgeName).toBeUndefined();
    expect(p.partlyRead).toEqual({ uncoveredDays: 11, line: "spending imported through Jul 20 · 11 days of this period unaccounted" });
  });

  /*
   * ⚖️ …and all spending follows it: with no account a statement is still coming for, the only day to name is a
   * wallet's newest typed row (`spendingCoverageThrough` falls back to every account with a day), which no import will
   * ever move.
   */
  test("all spending on a ledger of cash wallets alone is never partly read", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-07-01", openingBalanceCents: 50_000 });
    addManualTransaction(bundle.db, { accountId: wallet, postedOn: "2026-07-10", amountCents: -1_000, description: "Lunch", categoryId: food });
    const p = allSpend();
    expect(p.verdict).toBe("manual");
    expect(p.partlyRead).toBeUndefined();
  });

  test("a window read in part says so over rows nothing checks — its headline still counts them", () => {
    const acct = addAccount("a", "Robinhood Cash", "checking");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [
      { day: "2026-07-01", basis: "anchored" },
      { day: "2026-07-10", basis: "derived" },
      { day: "2026-07-20", basis: "derived_unverified" },
    ]);
    for (const day of ["2026-07-10", "2026-07-20"]) categorize(addTxn(acct, day, { importFileId: file }), food);
    const p = foodTotal();
    expect(p.verdict).toBe("partly_read");
    // the fraction is a fact about rows, and the rows are not the weakest part
    expect(p.badgeWord).toBeUndefined();
    expect(p.headline).toMatch(/^This total is the sum of 2 rows from 1 document, 1 has nothing checking it\./);
    expect(p.partlyRead?.uncoveredDays).toBe(11);
  });

  test("⛔ a window with no read day and no row is still the empty proof — never partly read (§6A 64)", () => {
    cardThrough("2026-07-31");
    const september = { from: "2026-09-01", to: "2026-09-30" };
    for (const p of [foodTotal(september), allSpend(september)]) {
      expect(p.verdict).toBe("unknown");
      expect(p.partlyRead).toBeUndefined();
      expect(p.headline).toMatch(/window nobody has looked at/);
    }
  });

  /*
   * ⛔ One day for the page. /spending hands its heatmap the day this proof counts from (`spendingReadThrough`), so a
   * card calling a day unaccounted and a day sheet calling it a measured zero cannot both be on it — 🔴 they were, on
   * his ledger copy 2026-10-13 (review of 06c6bf3): "30 days of this period unaccounted" under Where it went, and "No
   * spending or income on this day." on Sep 13 … Sep 22, read against the ledger's newest row.
   */
  test("the day all spending is read through is the day the proof counts from", () => {
    cardThrough("2026-07-30");
    expect(spendingReadThrough(bundle.db, "2026-10-13")).toBe("2026-07-30");
    expect(allSpend().partlyRead?.line).toBe("spending imported through Jul 30 · 1 day of this period unaccounted");
  });

  /*
   * ⛔ …and an EMPTY window is asked against it too. The empty branch asked the ledger's newest day, so a window with no
   * row and not one day read by all spending's day read "zero rather than unproven" — 🔴 on his ledger copy 2026-10-13
   * (review of 2fce458) `/spending` over Sep 13 – 22: "No rows in Sep 13 – 22, 2026 … so this total is zero rather than
   * unproven", the ledger reaching Sep 24 on Wells Fargo while every card he spends from stops by Sep 12. The empty
   * state under it is asked against the same day (`spendingEmptyCopy`), and §6A 64 calls that window a dash.
   */
  test("an empty window past that day is no measured zero — the empty proof is asked against it", () => {
    cardThrough("2026-07-20");
    readThrough(addAccount("b", "Wells Fargo", "checking"), "2026-07-31");
    expect(spendingReadThrough(bundle.db, "2026-10-13")).toBe("2026-07-20");
    const p = allSpend({ from: "2026-07-22", to: "2026-07-25" });
    expect(p.verdict).toBe("unknown");
    expect(p.headline).toBe(
      "Nothing has been imported for 4 days between Jul 22, 2026 and Jul 25, 2026, so this zero is a window nobody has " +
        "looked at rather than a measurement.",
    );
    // a window it has read keeps its measured zero
    expect(allSpend({ from: "2026-07-11", to: "2026-07-19" }).headline).toMatch(/so this total is zero rather than unproven\.$/);
  });

  test("…and there is none on a ledger of cash wallets alone, where no statement could ever move it", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-07-01", openingBalanceCents: 50_000 });
    addManualTransaction(bundle.db, { accountId: wallet, postedOn: "2026-07-10", amountCents: -1_000, description: "Lunch", categoryId: food });
    expect(spendingReadThrough(bundle.db, "2026-10-13")).toBeNull();
    expect(spendingReadThrough(createDatabase(":memory:").db, "2026-10-13")).toBeNull();
  });

  test("a row that does not add up, or has no basis, still outranks a window read in part", () => {
    expect(weakestVerdict(["derived", "partly_read"])).toBe("partly_read");
    expect(weakestVerdict(["unverified", "partly_read"])).toBe("partly_read");
    expect(weakestVerdict(["manual", "partly_read"])).toBe("partly_read");
    expect(weakestVerdict(["broken", "partly_read"])).toBe("broken");
    expect(weakestVerdict(["unknown", "partly_read"])).toBe("unknown");
  });

  test("a comparison stands on both windows, so one read in part makes the whole claim partly read", () => {
    cardThrough("2026-07-30");
    const p = provenanceFor(bundle.db, {
      kind: "allSpend",
      ...JULY,
      label: "Jul 2026",
      against: { from: "2026-06-01", to: "2026-06-30", label: "Jun 2026" },
    })!;
    expect(p.verdict).toBe("partly_read");
    expect(p.inputs.map((i) => i.verdict)).toEqual(["partly_read", "unknown"]);
    expect(p.partlyRead).toEqual({ uncoveredDays: 1, line: "spending imported through Jul 30 · 1 day of this period unaccounted" });
    // a change is no lower bound: the sentence names which half is read in part, in /budgets' words
    expect(p.headline).toMatch(/ Jul 2026 is read only in part: spending imported through Jul 30 · 1 day of this period unaccounted\.$/);

    // …and when the half read in part is the one compared against, that half is the one named
    const back = provenanceFor(bundle.db, {
      kind: "allSpend",
      from: "2026-06-01",
      to: "2026-06-30",
      label: "Jun 2026",
      against: { ...JULY, label: "Jul 2026" },
    })!;
    expect(back.verdict).toBe("partly_read");
    expect(back.inputs.map((i) => i.verdict)).toEqual(["unknown", "partly_read"]);
    expect(back.headline).toMatch(/ Jul 2026 is read only in part: spending imported through Jul 30 · 1 day of this period unaccounted\.$/);
  });

  /*
   * The task's scope is a SPEND total, and the line is /budgets' — "spending imported through …" — which no Received
   * or Net page could print. ❓ Whether an income page's total reads "partly read" too is his call (handoff).
   */
  test("an income category's Received total is not graded by spending's words", () => {
    const pay = addKindedCategory("c-pay", "Fixture Salary", "income");
    const acct = addAccount("a", "Chase Checking", "checking");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(acct, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    for (const day of ["2026-07-10", "2026-07-20"]) categorize(addTxn(acct, day, { importFileId: file, cents: 5_000 }), pay);
    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: pay, ...JULY })!;
    expect(p.verdict).toBe("derived");
    expect(p.partlyRead).toBeUndefined();
  });

  /*
   * ❓ HIS CALL, OPEN (review of 2fce458, the handoff's §6A): a merchant's own window — its first visit to its last
   * (`merchant-insights`) — is not graded. Either it is read by the earliest import day of the accounts it was paid
   * from, as a category's is (`categoryCoverage`), or it is left out: it ends on a row the ledger has read. Pinned as
   * shipped until he answers, in the shape of his rent (Flamingo South Beach on his ledger copy 2026-10-13: one payment
   * on Chase Checking, imported through Aug 12, the two since on Wells Fargo, read through Sep 24), where the category
   * over the same days IS partly read.
   */
  test("❓ a merchant's own window is not graded — the category over the same days is", () => {
    const checking = addAccount("a", "Chase Checking", "checking");
    const wells = addAccount("b", "Wells Fargo", "checking");
    const file = addFile("f1", "july.pdf", "chase-checking-statement-pdf");
    addDays(checking, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-20", basis: "derived" }]);
    addDays(wells, [{ day: "2026-07-01", basis: "anchored" }, { day: "2026-07-31", basis: "derived" }]);
    bundle.db.insert(merchants).values({ id: "m-rent", canonicalName: "Fixture Landlord", createdAt: now(), updatedAt: now() }).run();
    for (const [acct, day] of [[checking, "2026-07-10"], [wells, "2026-07-25"], [wells, "2026-07-31"]] as const) {
      const id = addTxn(acct, day, { importFileId: file });
      categorize(id, food);
      bundle.db.run(sql`UPDATE transactions SET merchant_id = 'm-rent' WHERE id = ${id}`);
    }
    // Chase Checking is read through Jul 20 by a row of its own elsewhere
    categorize(addTxn(checking, "2026-07-20", { importFileId: file }), food);
    const window = { from: "2026-07-10", to: "2026-07-31" };

    const rent = provenanceFor(bundle.db, { kind: "merchantSpend", merchantId: "m-rent", ...window })!;
    expect(rent.verdict).toBe("derived");
    expect(rent.partlyRead).toBeUndefined();
    expect(rent.headline).toMatch(/^This total is the sum of 3 rows from 1 document\./);
    expect(foodTotal(window).partlyRead).toEqual({
      uncoveredDays: 11,
      line: "spending imported through Jul 20 · 11 days of this period unaccounted",
    });
  });
});
