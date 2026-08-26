import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache } from "@/db/schema/holdings";
import { recurringSeries } from "@/db/schema/recurring";
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

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.headline).toMatch(/sum of 2 rows from 1 document/);
    expect(p.verdict).toBe("derived");
    expect(p.sources[0]!.label).toBe("20260801-statements-3522-.pdf");
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

  /** An empty window is a ZERO, not an unproven figure — a real distinction. */
  test("an empty window says the total is zero rather than unproven", () => {
    const cat = addCategory("c-food", "Fixture Food");
    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2019-01-01", to: "2019-12-31" })!;
    expect(p.headline).toMatch(/zero rather than unproven/);
    expect(p.sources).toEqual([]);
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

    const p = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: cat, from: "2026-07-01", to: "2026-07-31" })!;
    expect(p.verdict).toBe("unverified");
    expect(p.badgeWord).toBe("1 of 2 checked");
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
    const s = addSeries("Amazon Prime");
    for (const d of ["2026-05-05", "2026-06-05", "2026-07-05"]) tagToSeries(addTxn(acct, d, { cents: -499 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("derived");
    expect(p.badgeWord).toBeUndefined();
    expect(p.headline).toContain("All 3 tagged postings");
    // ⛔ never `sourced` — no document states NEXT month's amount
    expect(p.verdict).not.toBe("sourced");
    expect(p.headline).toContain("a forecast, not a record");
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
   */
  test("an override that disagrees with what actually posted says so", () => {
    const acct = addAccount("a", "Chase Checking", "checking");
    const s = addSeries("Cash job", { amountAvg: 104600, userAmount: 104700 });
    tagToSeries(addTxn(acct, "2026-06-04", { cents: 104700 }), s);

    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: s })!;
    expect(p.verdict).toBe("manual");
    expect(p.headline).toContain("The ledger's own average of what actually posted is $1,046.00");
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
