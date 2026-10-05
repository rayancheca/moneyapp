import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts, type AccountType } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { addManualAnchor } from "@/services/anchors";
import { accountCoverage } from "@/services/coverage";
import { derivesFromHoldings, heldCountsByAccount, rebuildAccount } from "@/services/derivation";
import { CoveragePanel } from "./CoveragePanel";

/**
 * /imports' coverage panel, rendered as the page renders it, over accounts built through the
 * app's own path — recorded balances, rows, `rebuildAccount`, `accountCoverage` — so the header
 * and the rows below it are read off one ledger, the way he reads them.
 */

let dir: string;
let bundle: DbBundle;
let institutionId: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-coverage-panel-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addAccount(name: string, type: AccountType = "checking"): string {
  const now = new Date().toISOString();
  const id = `a-${(seq += 1)}`;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type,
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/** A statement's closing balance — $5,000.00, so balances with nothing posted between them agree. */
function addStatement(accountId: string, day: string): void {
  const now = new Date().toISOString();
  bundle.db
    .insert(balanceAnchors)
    .values({ accountId, anchoredOn: day, balanceCents: 500_000, source: "statement", createdAt: now, updatedAt: now })
    .run();
}

/** A -$12.34 row. */
function addRow(accountId: string, day: string): void {
  const now = new Date().toISOString();
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `txn-${seq}`,
      accountId,
      postedOn: day,
      amountCents: -1234,
      rawDescription: "TRANSFER",
      normalizedDescription: "transfer",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${seq}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Robinhood Agentic's shape on his ledger: three statements that agree, and the Jun 5 row. */
function addAgentic(): void {
  const id = addAccount("Robinhood Agentic");
  for (const day of ["2026-06-30", "2026-07-31", "2026-08-31"]) addStatement(id, day);
  addRow(id, "2026-06-05");
  rebuildAccount(bundle.db, id, "2026-09-15");
}

/** Rows past its newest statement that nothing has closed yet: the run still open, Sep 3–15. */
function addOpenRun(): void {
  const id = addAccount("Open Run");
  addStatement(id, "2026-08-31");
  addRow(id, "2026-09-03");
  rebuildAccount(bundle.db, id, "2026-09-15");
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&#x27;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:quot|#x27|lt|gt|amp);/g, (e) => ENTITIES[e]!)
    .replace(/\s+/g, " ")
    .trim();
const HEADER = /\d+ accounts? nothing is checking|every account is checked by arithmetic/;

/** The panel as /imports renders it on Oct 1, 2026: its header line, and each row's text by account. */
function panel(): { header: string; rows: Map<string, string> } {
  const coverage = accountCoverage(bundle.db, "2026-10-01");
  // as the page decides them: the accounts holdings price, and the count each one no holding prices is held at
  const pricedFromHoldingsIds = coverage
    .filter((c) => derivesFromHoldings(bundle.db, { id: c.accountId, type: c.accountType as AccountType }))
    .map((c) => c.accountId);
  const heldCounts = heldCountsByAccount(bundle.db, coverage, "2026-10-01");
  const html = renderToStaticMarkup(createElement(CoveragePanel, { coverage, pricedFromHoldingsIds, heldCounts }));
  const [head, ...items] = html.split("<li").map((part, i) => (i === 0 ? part : `<li${part}`));
  const rowOf = (name: string): string => text(items.find((item) => item.includes(`>${name}<`)) ?? "");
  return {
    header: text(head!).match(HEADER)?.[0] ?? `(no header in "${text(head!)}")`,
    rows: new Map(coverage.map((c) => [c.accountName, rowOf(c.accountName)])),
  };
}

/*
 * 🔴 "1 ACCOUNT NOTHING IS CHECKING", over a row that says it closes to the cent through Aug 31
 * (review, 2026-10-01). The header counted every `unverified` account, and Robinhood Agentic's
 * row — directly below — said the account closes through Aug 31, 2026 and that only the days
 * before its first balance are unchecked. On a copy of his ledger the header read "3 accounts
 * nothing is checking" of Cash on Hand, Robinhood Cash and Agentic. Which unverified accounts have
 * only those days is `beforeFirstBalance`, the reading the row and net worth's line share.
 */
describe("CoveragePanel — the header counts what the rows say", () => {
  test("an account unchecked only before its first balance is not one nothing is checking", () => {
    addAgentic();
    addOpenRun();
    const { header, rows } = panel();
    expect(header).toBe("1 account nothing is checking");
    expect(rows.get("Robinhood Agentic")).toContain(
      "closes to the cent through Aug 31, 2026 (31 days ago); " +
        "the 26 days before its first balance, on Jun 30, 2026, are unchecked",
    );
    expect(rows.get("Open Run")).toContain("the first day it does not is Sep 3, 2026");
  });

  test("with nothing else unchecked, the header says every account is checked", () => {
    // ⚠️ every account IS: Agentic closes through Aug 31 and carries that balance to its newest
    // day; its row names the days before its first balance, which nothing earlier could check
    addAgentic();
    expect(panel().header).toBe("every account is checked by arithmetic");
  });

  /*
   * 🔴 The row named `chainOpensOn` — the first day that CLOSES — as "its first balance". His
   * count on Jun 20 closes nothing (the days before it are replayed backwards from it), so the
   * chain opened on the Jun 30 statement and the row read "the 16 days before its first balance,
   * on Jun 30, 2026, are unchecked — replayed backwards from it" of days replayed from his count.
   */
  test("his count as its first balance is the day the row names, as his", () => {
    const id = addAccount("New Checking");
    addRow(id, "2026-06-05");
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-06-20", enteredCents: 500_000 });
    for (const day of ["2026-06-30", "2026-07-31", "2026-08-31"]) addStatement(id, day);
    rebuildAccount(bundle.db, id, "2026-09-15");

    const { header, rows } = panel();
    expect(rows.get("New Checking")).toContain(
      "closes to the cent through Aug 31, 2026 (31 days ago); " +
        "the 16 days before its first balance, the one you counted on Jun 20, 2026, are unchecked — " +
        "replayed backwards from it, with nothing earlier to check them against",
    );
    expect(header).toBe("every account is checked by arithmetic");
  });
});

/*
 * 🔴 "HELD AT ITS RECORDED BALANCE" OF A VALUE HE TYPED. An investment account no holding prices, its value typed
 * through the app's own path (`addManualAnchor` $1,000.00 for Sep 1), read "the balance you counted on Sep 1, 2026,
 * held forward" on its balance proof and "held at its recorded balance" on this row (review, 2026-10-05). ⚖️ A value
 * he typed is one he counted (his answer, 2026-10-05); a statement's keeps "recorded".
 */
describe("CoveragePanel — an account no holding prices names whose balance it is held at", () => {
  test("a balance he typed as his count, a statement's as recorded", () => {
    const typed = addAccount("Brokerage", "investment");
    addManualAnchor(bundle.db, { accountId: typed, anchoredOn: "2026-09-01", enteredCents: 100_000 });
    rebuildAccount(bundle.db, typed, "2026-10-01");
    const printed = addAccount("Old 401k", "investment");
    addStatement(printed, "2026-09-01");
    rebuildAccount(bundle.db, printed, "2026-10-01");

    const { rows } = panel();
    expect(rows.get("Brokerage")).toContain(
      "held at the balance you counted on Sep 1, 2026; no holdings price it, and no transaction arithmetic checks it",
    );
    expect(rows.get("Old 401k")).toContain(
      "held at its recorded balance; no holdings price it, and no transaction arithmetic checks it",
    );
  });
});
