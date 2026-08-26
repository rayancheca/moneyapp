import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
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

function addPeriod(
  id: string,
  accountId: string,
  importFileId: string,
  start: string,
  end: string,
  reconciliation: string,
): string {
  bundle.db
    .insert(statementPeriods)
    .values({
      id,
      importFileId,
      accountId,
      periodStart: start,
      periodEnd: end,
      beginningBalanceCents: 0,
      endingBalanceCents: 1000,
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
    const all: ProvenanceVerdict[] = ["sourced", "derived", "market_value", "manual", "unverified", "unknown", "broken"];
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
    addDays(id, [{ day: "2026-08-02", basis: "derived" }]);
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-02" })!;
    expect(p.verdict).toBe("market_value");
    expect(p.headline).toMatch(/never proves the transactions add up/i);
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

  test("a hand-entered anchor says the owner is the source", () => {
    const id = addAccount("a", "Cash on Hand", "cash");
    addDays(id, [{ day: "2026-08-01", basis: "anchored" }]);
    addAnchor(id, "2026-08-01", "manual");
    const p = provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-01" })!;
    expect(p.sources.some((s) => s.label === "a balance you entered")).toBe(true);
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
    addPeriod("p1", id, file, "2026-07-27", "2026-08-24", "not_applicable");
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

  test("a row that does not exist is null", () => {
    expect(provenanceFor(bundle.db, { kind: "transaction", id: "nope" })).toBeNull();
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
