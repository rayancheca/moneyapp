import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { withheldNoticeOf, withheldSectionsOf } from "@/lib/import-file-label";
import { createAccount } from "@/services/accounts";
import { accountCoverage } from "@/services/coverage";
import { statementGaps } from "@/services/statement-gaps";
import { PROFILES } from "./profiles";
import type { Line } from "./profiles/pdf-profile";
import { importStatementFiles, resolveAccount, type ImportInput } from "./service";
import type { ParsedStatement } from "./types";

/**
 * The ledger's tracked accounts must REACH the Robinhood statement parsers.
 *
 * 3902f69 made the brokerage parser choose the account section by the last4 the
 * ledger tracks, because the 2026-08 statement printed #655929651 ($26.64)
 * FIRST. That choice depends on two links, and until this file no test went
 * through either one:
 *   1. `importOneFile` → `profile.parse(file, parseContextFor(db))`
 *   2. the profile's `parse` → the section choice, fed from `context.knownAccounts`
 *
 * 🔴 Measured by a second reader: mutating link 1 to `profile.parse(file)`, or
 * link 2 to an empty tracked list, left `vitest run src/services/import` at 235
 * passed. Every existing test called the parser directly, handing it the very
 * list the import path is supposed to supply. Either mutation makes the real
 * 2026-08 file fail to import.
 *
 * So this goes through `importStatementFiles` on a real temp database. The one
 * thing faked is text extraction (`extractLines`), keyed by the fake file's
 * bytes. Profile routing (`selectProfile`) and the profile's own `parse` both
 * call it, so the mocked lines pass through the real content gates exactly as a
 * real PDF's would.
 */

const { DOCUMENTS } = vi.hoisted(() => ({ DOCUMENTS: new Map<string, Line[]>() }));

vi.mock("./profiles/pdf-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./profiles/pdf-profile")>()),
  extractLines: async (buffer: Buffer): Promise<Line[]> => {
    const lines = DOCUMENTS.get(buffer.toString("latin1"));
    if (!lines) throw new Error("no mocked document for these bytes");
    return lines;
  },
}));

const line = (text: string, tokens: [string, number][] = []): Line => ({
  y: 0,
  text,
  tokens: tokens.map(([str, x]) => ({ str, x })),
});

/** A fake PDF, just enough for `sniffFile` to see a PDF. Opaque UUID names, the way Robinhood names its files. */
function pdf(name: string, lines: Line[]): ImportInput {
  const buffer = Buffer.from(`%PDF-1.7\n% ${name}\n`, "latin1");
  DOCUMENTS.set(buffer.toString("latin1"), lines);
  return { name, buffer };
}

/* Every literal below is copied from the extracted file it names. */

/** #487513525, 2026-08 (48afc52f…, lines 160–176). */
const AUGUST_BROKERAGE = [
  "08/01/2026 to 08/31/2026",
  "Individual Account #:487513525",
  "Account Summary",
  "Brokerage Cash Balance * $1,679.93 $0.68",
  "Deposit Sweep Balance $0.45 $1,000.33",
  "Total Securities ** $67,859.26 $72,959.32",
  "Portfolio Value $69,539.64 $73,960.33",
].map((t) => line(t));

/** #655929651, 2026-08 (48afc52f…, lines 2–44) — printed FIRST that month. */
const AUGUST_SECOND = [
  line("08/01/2026 to 08/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $26.64 $26.64"),
  line("Total Securities $0.00 $0.00"),
  line("Portfolio Value $26.64 $26.64"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $26.64 100.00%"),
  line("Account Activity"),
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [["Debit", 685.13], ["Credit", 743.4]]),
  line("Total Funds Paid and Received $0.00 $0.00", [["Total Funds Paid and Received", 36], ["$0.00", 685.13], ["$0.00", 743.4]]),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** #487513525, 2026-06 (747059b1…, lines 2–18 and 116–121). */
const JUNE_BROKERAGE = [
  line("06/01/2026 to 06/30/2026"),
  line("Individual Account #:487513525"),
  line("Account Summary"),
  line("Brokerage Cash Balance * $0.38 $192.22"),
  line("Deposit Sweep Balance $0.34 $0.07"),
  line("Total Securities ** $62,556.95 $59,329.88"),
  line("Portfolio Value $62,557.67 $59,522.17"),
  line("Account Activity"),
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [["Debit", 687.6], ["Credit", 746.63]]),
  // the brokerage's side of the transfer — a DEBIT, and the activity CSV's row, not this file's
  line("Transfer from Brokerage to Brokerage Margin ITRF 06/05/2026 $26.64", [
    ["Transfer from Brokerage to Brokerage", 36],
    ["Margin", 391.8],
    ["ITRF", 445.69],
    ["06/05/2026", 507.26],
    ["$26.64", 687.6],
  ]),
];

/** #655929651, 2026-06 (747059b1…, lines 373–416) — its first statement, so the opening is `N/A`. */
const JUNE_SECOND = [
  line("06/01/2026 to 06/30/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance N/A $26.64"),
  line("Total Securities N/A $0.00"),
  line("Portfolio Value N/A $26.64"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $26.64 100.00%"),
  line("Account Activity"),
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [["Debit", 695.33], ["Credit", 746.51]]),
  line("Transfer from Brokerage to Brokerage Cash ITRF 06/05/2026 $26.64", [
    ["Transfer from Brokerage to Brokerage", 36],
    ["Cash", 347.25],
    ["ITRF", 426.3],
    ["06/05/2026", 516.67],
    ["$26.64", 746.51],
  ]),
  line("Total Funds Paid and Received $0.00 $26.64", [["Total Funds Paid and Received", 36], ["$0.00", 695.33], ["$26.64", 746.51]]),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** The activity CSV's one ITRF row, verbatim from the all-time export (3ab6c2a8…). */
const ACTIVITY_CSV: ImportInput = {
  name: "19f645c5-b6a7-5cc9-b6cb-704104af4792.csv",
  buffer: Buffer.from(
    [
      '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"',
      '"6/5/2026","6/5/2026","6/5/2026","","Transfer from Brokerage to Brokerage","ITRF","","","($26.64)"',
    ].join("\n"),
  ),
};

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rh-context-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

function periods() {
  return bundle.db
    .select({
      account: accounts.name,
      last4: accounts.last4,
      start: statementPeriods.periodStart,
      end: statementPeriods.periodEnd,
      beginCents: statementPeriods.beginningBalanceCents,
      endCents: statementPeriods.endingBalanceCents,
      reconciliation: statementPeriods.reconciliation,
    })
    .from(statementPeriods)
    .innerJoin(accounts, eq(statementPeriods.accountId, accounts.id))
    // files import in name order, not period order — 48afc52f (2026-08) before 747059b1 (2026-06)
    .orderBy(accounts.name, statementPeriods.periodStart)
    .all();
}

function robinhoodAccounts() {
  return bundle.db
    .select({ id: accounts.id, name: accounts.name, type: accounts.type, last4: accounts.last4 })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(institutions.name, "Robinhood"))
    .all();
}

/** The owner's ledger today: the brokerage carries last4 3525, and the cash ledger has no number. */
function trackBrokerageAndCash(db: AppDatabase = bundle.db): void {
  resolveAccount(db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage", last4: "3525" });
  resolveAccount(db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });
}

/**
 * …and Robinhood Agentic, created the way the guarded script creates it — NOT through resolveAccount, which would
 * ADOPT Robinhood Cash (checking, no last4) and stamp ····9651 on the wrong account.
 */
function trackAllThree(db: AppDatabase = bundle.db): string {
  trackBrokerageAndCash(db);
  const robinhood = db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  return createAccount(db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
}

describe("the ledger's tracked accounts reach the Robinhood brokerage parser through the import", () => {
  test("⛔ the 2026-08 order: the untracked account prints first, and the tracked one is imported", async () => {
    trackBrokerageAndCash();

    const [outcome] = await importStatementFiles(bundle.db, [pdf("7c1e4b2a-9d3f-4e8a-b5c6-0f2d8a1e3b47.pdf", [...AUGUST_SECOND, ...AUGUST_BROKERAGE])]);

    // not "failed … refusing to guess", which is what a dropped context produces
    expect(outcome!.error).toBeUndefined();
    expect(outcome!.status).toBe("parsed");
    const file = bundle.db.select().from(importFiles).get()!;
    expect(file.status).toBe("parsed");
    expect(file.parserProfile).toBe("robinhood-brokerage-statement-pdf"); // the mocked text routed where a real file would

    const byAccount = new Map(periods().map((p) => [p.account, p]));
    expect([...byAccount.keys()].sort()).toEqual(["Robinhood Brokerage", "Robinhood Cash"]);
    expect(byAccount.get("Robinhood Cash")).toMatchObject({
      start: "2026-08-01",
      end: "2026-08-31",
      beginCents: 167993 + 45, // brokerage cash + deposit sweep of #487513525, not 2664
      endCents: 68 + 100033, // not 2664
    });
    expect(byAccount.get("Robinhood Brokerage")).toMatchObject({
      last4: "3525",
      start: "2026-08-01",
      end: "2026-08-31",
      beginCents: 6785926, // not 0, the untracked account's Total Securities
      endCents: 7295932,
    });

    // no account was created for the untracked #655929651
    expect(robinhoodAccounts()).toHaveLength(2);
  });

  test("the same bytes on a ledger that tracks no Robinhood last4 are refused, not guessed", async () => {
    // the control: the file is identical, so only the ledger decided the import above
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage" });
    resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });

    const [outcome] = await importStatementFiles(bundle.db, [pdf("7c1e4b2a-9d3f-4e8a-b5c6-0f2d8a1e3b47.pdf", [...AUGUST_SECOND, ...AUGUST_BROKERAGE])]);

    expect(outcome!.status).toBe("failed");
    expect(outcome!.error).toMatch(/#655929651, #487513525.*refusing to guess/);
    expect(periods()).toEqual([]);
  });

  test("⛔ BOTH accounts tracked: each section imports into its own account, in either print order", async () => {
    // the owner, 2026-09-14: "i gave claude agentic in robinhood 25$ to trade so yes i guess it a new acocunt".
    // Created the way the guarded script creates it — NOT through resolveAccount, which would ADOPT
    // Robinhood Cash (checking, no last4) and stamp ····9651 on the wrong account.
    trackBrokerageAndCash();
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agenticId = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });

    const outcomes = await importStatementFiles(bundle.db, [
      ACTIVITY_CSV, // Robinhood Cash's −$26.64, as it sits in the ledger today
      pdf("747059b1-3904-3242-af2e-de66f2c94f5e.pdf", [...JUNE_BROKERAGE, ...JUNE_SECOND]), // tracked account first
      pdf("48afc52f-8955-351d-bdad-7248305c5a2b.pdf", [...AUGUST_SECOND, ...AUGUST_BROKERAGE]), // second account first
    ]);

    expect(outcomes.map((o) => [o.status, o.error, o.withheld])).toEqual([
      ["parsed", undefined, []],
      ["parsed", undefined, []],
      ["parsed", undefined, []], // a section the cash reader proves is never withheld
    ]);
    expect(bundle.db.select({ status: importFiles.status, error: importFiles.error }).from(importFiles).all()).toEqual([
      { status: "parsed", error: null },
      { status: "parsed", error: null },
      { status: "parsed", error: null },
    ]);

    const rows = periods();
    const of = (name: string) => rows.filter((p) => p.account === name).map(({ start, beginCents, endCents }) => ({ start, beginCents, endCents }));
    // #487513525's figures, exactly as when only it was tracked
    expect(of("Robinhood Cash")).toEqual([
      { start: "2026-06-01", beginCents: 38 + 34, endCents: 19222 + 7 },
      { start: "2026-08-01", beginCents: 167993 + 45, endCents: 68 + 100033 },
    ]);
    expect(of("Robinhood Brokerage")).toEqual([
      { start: "2026-06-01", beginCents: 6255695, endCents: 5932988 },
      { start: "2026-08-01", beginCents: 6785926, endCents: 7295932 },
    ]);
    // #655929651's: June declares its coverage (its opening printed N/A), August is a real period that closes
    expect(rows.filter((p) => p.account === "Robinhood Agentic")).toEqual([
      { account: "Robinhood Agentic", last4: "9651", start: "2026-06-01", end: "2026-06-30", beginCents: null, endCents: null, reconciliation: "not_applicable" },
      { account: "Robinhood Agentic", last4: "9651", start: "2026-08-01", end: "2026-08-31", beginCents: 2664, endCents: 2664, reconciliation: "reconciled" },
    ]);

    const anchors = bundle.db
      .select({ on: balanceAnchors.anchoredOn, cents: balanceAnchors.balanceCents, source: balanceAnchors.source })
      .from(balanceAnchors)
      .where(eq(balanceAnchors.accountId, agenticId))
      .orderBy(balanceAnchors.anchoredOn)
      .all();
    expect(anchors).toEqual([
      { on: "2026-06-30", cents: 2664, source: "ofx_ledger" }, // an observation, never a zero opening
      { on: "2026-07-31", cents: 2664, source: "statement" },
      { on: "2026-08-31", cents: 2664, source: "statement" },
    ]);

    // the credit, signed by its column — and paired with Robinhood Cash's debit
    const legs = bundle.db
      .select({ account: accounts.name, cents: transactions.amountCents, description: transactions.rawDescription, group: transactions.transferGroupId })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(eq(transactions.postedOn, "2026-06-05"), eq(transactions.status, "active")))
      .all()
      .sort((a, b) => a.cents - b.cents);
    expect(legs.map(({ account, cents, description }) => ({ account, cents, description }))).toEqual([
      { account: "Robinhood Cash", cents: -2664, description: "Transfer from Brokerage to Brokerage" },
      { account: "Robinhood Agentic", cents: 2664, description: "Transfer from Brokerage to Brokerage" },
    ]);
    expect(legs[0]!.group).not.toBeNull();
    expect(legs[1]!.group).toBe(legs[0]!.group);

    // three Robinhood accounts and no stub; the cash ledger still carries no number
    expect(robinhoodAccounts().map((a) => [a.name, a.type, a.last4]).sort()).toEqual([
      ["Robinhood Agentic", "checking", "9651"],
      ["Robinhood Brokerage", "investment", "3525"],
      ["Robinhood Cash", "checking", null],
    ]);
  });
});

/** #487513525's Account Activity, 2026-08 (48afc52f…, lines 245–246, 271, 301, 303) — the two credits no other source carries. */
const AUGUST_BROKERAGE_ACTIVITY = [
  line("Account Activity", [["Account Activity", 36]]),
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [
    ["Description", 36],
    ["Symbol", 356.7],
    ["Acct Type", 400.35],
    ["Transaction", 455.06],
    ["Date", 517.58],
    ["Qty", 580.54],
    ["Price", 633.34],
    ["Debit", 697.42],
    ["Credit", 751.73],
  ]),
  line("Crypto Money Movement Margin COIN 08/24/2026 $1,499.99", [
    ["Crypto Money Movement", 36],
    ["Margin", 400.35],
    ["COIN", 455.06],
    ["08/24/2026", 517.58],
    ["$1,499.99", 751.73],
  ]),
  line("Crypto Money Movement Margin COIN 08/31/2026 $1,000.11", [
    ["Crypto Money Movement", 36],
    ["Margin", 400.35],
    ["COIN", 455.06],
    ["08/31/2026", 517.58],
    ["$1,000.11", 751.73],
  ]),
  line("Total Funds Paid and Received $5,732.94 $5,053.57", [
    ["Total Funds Paid and Received", 36],
    ["$5,732.94", 697.42],
    ["$5,053.57", 751.73],
  ]),
];
const AUGUST_BROKERAGE_WITH_CREDITS = [...AUGUST_BROKERAGE, ...AUGUST_BROKERAGE_ACTIVITY];

/**
 * The rehearsal's month (agentic-design.json, option (c)): #655929651's real 2026-08 lines with only what a buy of
 * 0.25 WMT for $25.00 on 08/20 would change. CONSTRUCTED — no statement for this account has printed a position yet.
 */
const AGENT_BUYS = [
  line("08/01/2026 to 08/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $26.64 $1.64"),
  line("Total Securities $0.00 $26.22"),
  line("Portfolio Value $26.64 $27.86"),
  line("Portfolio Summary"),
  line("Walmart"),
  line("WMT Cash 0.25 $104.87000 $26.22 $0.24 94.11%"),
  line("Total Securities $26.22 $0.24 94.11%"),
  line("Brokerage Cash Balance $1.64 5.89%"),
  line("Account Activity"),
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [["Debit", 685.13], ["Credit", 743.4]]),
  line("Walmart"),
  line("WMT Cash Buy 08/20/2026 0.25 $100.00000 $25.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Buy", 431.63],
    ["08/20/2026", 534.56],
    ["0.25", 586.28],
    ["$100.00000", 630.19],
    ["$25.00", 685.13],
  ]),
  line("CUSIP: 931142103"),
  line("Total Funds Paid and Received $25.00 $0.00", [["Total Funds Paid and Received", 36], ["$25.00", 685.13], ["$0.00", 743.4]]),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

const JUNE_FILE = "747059b1-3904-3242-af2e-de66f2c94f5e.pdf";
/** a name for the constructed file — its bytes differ from the real August's, as a re-issued statement's would */
const AGENT_BUYS_FILE = "d41f0c83-5a7e-4b2c-9e61-3f8a2b7c9d10.pdf";

/**
 * #655929651's real August with its Total Funds line taken out — CONSTRUCTED: a section the cash reader cannot check,
 * whose balance did not move ($26.64 → $26.64).
 */
const AUGUST_UNCHECKABLE = AUGUST_SECOND.filter((l) => !l.text.startsWith("Total Funds Paid and Received"));
const UNCHECKABLE_AUGUST_FILE = "5e2a9c41-7b3d-4f08-a6e1-c9d2b8f47a13.pdf";
const SEPTEMBER = "09/01/2026 to 09/30/2026";
/** CONSTRUCTED: #655929651's real August figures re-dated to September — cash only, opening at $26.64. */
const SEPTEMBER_SECOND = [line(SEPTEMBER), ...AUGUST_SECOND.slice(1)];
/** CONSTRUCTED: #487513525 opening September where its real August closed, with nothing moving. */
const SEPTEMBER_BROKERAGE = [
  SEPTEMBER,
  "Individual Account #:487513525",
  "Account Summary",
  "Brokerage Cash Balance * $0.68 $0.68",
  "Deposit Sweep Balance $1,000.33 $1,000.33",
  "Total Securities ** $72,959.32 $72,959.32",
  "Portfolio Value $73,960.33 $73,960.33",
].map((t) => line(t));
const SEPTEMBER_FILE = "b7d4e2f1-3c8a-4d59-9e06-2a1f7c5b8e34.pdf";

/** Everything the ledger holds for one account, in a stable order — what "untouched" and "identical" are measured on. */
function stateOf(db: AppDatabase, accountName: string) {
  const { id } = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, accountName)).get()!;
  return {
    periods: db
      .select({
        start: statementPeriods.periodStart,
        end: statementPeriods.periodEnd,
        beginCents: statementPeriods.beginningBalanceCents,
        endCents: statementPeriods.endingBalanceCents,
        reconciliation: statementPeriods.reconciliation,
        gapCents: statementPeriods.gapCents,
      })
      .from(statementPeriods)
      .where(eq(statementPeriods.accountId, id))
      .orderBy(statementPeriods.periodStart)
      .all(),
    anchors: db
      .select({ on: balanceAnchors.anchoredOn, cents: balanceAnchors.balanceCents, source: balanceAnchors.source })
      .from(balanceAnchors)
      .where(eq(balanceAnchors.accountId, id))
      .orderBy(balanceAnchors.anchoredOn, balanceAnchors.source)
      .all(),
    liveRows: db
      .select({ postedOn: transactions.postedOn, cents: transactions.amountCents, description: transactions.rawDescription, status: transactions.status })
      .from(transactions)
      .where(and(eq(transactions.accountId, id), ne(transactions.status, "superseded")))
      .orderBy(transactions.postedOn, transactions.amountCents)
      .all(),
    days: db
      .select({ day: dailyBalances.day, cents: dailyBalances.balanceCents, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, id))
      .orderBy(dailyBalances.day)
      .all(),
  };
}

describe("an unprovable Robinhood Agentic section is withheld, and the rest of the file imports", () => {
  test("⛔ the agent buys a symbol no position in this ledger has held: Robinhood Cash and Brokerage import exactly as a normal August, Robinhood Agentic is untouched, and the file says what it left out", async () => {
    // the same ledger given the PROVABLE August, for comparison
    const normal = createDatabase(path.join(dir, "normal.db"));
    try {
      seedDatabase(normal.db);
      trackAllThree(normal.db);
      await importStatementFiles(normal.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
      await importStatementFiles(normal.db, [pdf("48afc52f-8955-351d-bdad-7248305c5a2b.pdf", [...AUGUST_SECOND, ...AUGUST_BROKERAGE_WITH_CREDITS])]);

      const agenticId = trackAllThree();
      await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
      const agenticBefore = stateOf(bundle.db, "Robinhood Agentic");
      expect(agenticBefore.liveRows).toHaveLength(1); // June's +$26.64, so "untouched" is measured on something

      const [outcome] = await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE_WITH_CREDITS])]);

      // not "failed" — which cost Robinhood Cash $2,500.10 on the real August
      expect(outcome!.status).toBe("parsed");
      expect(outcome!.error).toBeUndefined();
      expect(outcome!.withheld).toEqual([
        {
          accountId: agenticId,
          accountName: "Robinhood Agentic",
          last4: "9651",
          periodStart: "2026-08-01",
          periodEnd: "2026-08-31",
          reason: "it holds WMT, and no position in this ledger records whether WMT is a stock or an ETF",
          notice:
            "Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — it holds WMT, " +
            "and no position in this ledger records whether WMT is a stock or an ETF. Nothing from that section is in the ledger: the activity it lists is missing, " +
            "and the account is not checked for those days unless a later statement's opening balance closes to the cent across them. " +
            "Importing the same file again changes nothing: the next statement parser version reads the section again, " +
            "and positions it proves go into the account's brokerage book, which the import creates.",
        },
      ]);
      // durable, on the file's own row — what /imports reads
      const file = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, AGENT_BUYS_FILE)).get()!;
      expect(file.status).toBe("parsed");
      expect(withheldNoticeOf(file)).toBe(outcome!.withheld[0]!.notice);
      // …kept as FACTS, so the gaps panel and the scripts read which account and which window, not a sentence
      expect(withheldSectionsOf(file)).toEqual([
        {
          accountId: agenticId,
          accountName: "Robinhood Agentic",
          last4: "9651",
          periodStart: "2026-08-01",
          periodEnd: "2026-08-31",
          reason: "it holds WMT, and no position in this ledger records whether WMT is a stock or an ETF",
        },
      ]);

      // Robinhood Agentic: not a row, a period, an anchor or a day moved — nothing reads as checked for August
      expect(stateOf(bundle.db, "Robinhood Agentic")).toEqual(agenticBefore);
      expect(stateOf(bundle.db, "Robinhood Agentic").periods.map((p) => p.end)).toEqual(["2026-06-30"]);

      // Robinhood Cash and Brokerage: exactly what the provable August gave
      for (const name of ["Robinhood Cash", "Robinhood Brokerage"]) {
        expect(stateOf(bundle.db, name)).toEqual(stateOf(normal.db, name));
      }
      expect(
        stateOf(bundle.db, "Robinhood Cash")
          .liveRows.filter((r) => r.description === "Crypto Money Movement")
          .map((r) => [r.postedOn, r.cents]),
      ).toEqual([
        ["2026-08-24", 149999],
        ["2026-08-31", 100011],
      ]);
      expect(stateOf(bundle.db, "Robinhood Brokerage").periods.at(-1)).toMatchObject({ start: "2026-08-01", beginCents: 6785926, endCents: 7295932 });
    } finally {
      normal.sqlite.close();
    }
  });

  test("the same bytes at the same parser version are skipped as a duplicate — the notice stays, and only a version bump reads them again", async () => {
    trackAllThree();
    const file = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE_WITH_CREDITS]);
    await importStatementFiles(bundle.db, [file]);

    const [again] = await importStatementFiles(bundle.db, [file]);

    expect(again!.status).toBe("skipped_duplicate");
    const rows = bundle.db.select({ status: importFiles.status, error: importFiles.error }).from(importFiles).all();
    expect(rows.map((r) => [r.status, withheldNoticeOf(r)])).toEqual([
      ["parsed", expect.stringMatching(/^Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026/)],
    ]);
  });

  test("⛔ once a parser can read the section, its version bump re-reads the file: Robinhood Agentic gains August, nothing else counts twice, and the owner's work carries", async () => {
    trackAllThree();
    const file = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE_WITH_CREDITS]);
    await importStatementFiles(bundle.db, [file]);

    // the owner's note on a row only this PDF carries — the re-parse must not lose it
    const credit = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.postedOn, "2026-08-24"), eq(transactions.amountCents, 149999)))
      .get()!;
    bundle.db.update(transactions).set({ notes: "ETH sold for the car" }).where(eq(transactions.id, credit.id)).run();
    const before = { cash: stateOf(bundle.db, "Robinhood Cash"), brokerage: stateOf(bundle.db, "Robinhood Brokerage") };

    /*
     * A stand-in for the positions reader that does not exist yet: the SAME bytes, a bumped version, and
     * #655929651's August now read — its cash, which the constructed buy took $25.00 of. The version is the
     * only thing that lets the import read this file again (the test above).
     */
    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const { version, parse } = profile;
    const agenticAugust: ParsedStatement = {
      accountHint: { institution: "Robinhood", last4: "9651" },
      txns: [{ postedOn: "2026-08-20", amountCents: -2500, rawDescription: "Walmart", bankCategory: "Buy" }],
      period: { start: "2026-08-01", end: "2026-08-31", beginCents: 2664, endCents: 164 },
    };
    profile.version = version + 1;
    profile.parse = async (f, context) => {
      const read = await parse(f, context);
      return { statements: [...(Array.isArray(read) ? read : read.statements), agenticAugust], withheld: [] };
    };
    let outcome;
    try {
      [outcome] = await importStatementFiles(bundle.db, [file]);
    } finally {
      profile.version = version;
      profile.parse = parse;
    }

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.withheld).toEqual([]);
    expect(outcome!.carriedForward).toBeGreaterThanOrEqual(1);

    // the old version's row is superseded and no longer claims a section is missing; the new one has nothing missing
    expect(
      bundle.db
        .select({ version: importFiles.parserVersion, status: importFiles.status, error: importFiles.error })
        .from(importFiles)
        .orderBy(importFiles.parserVersion)
        .all(),
    ).toEqual([
      { version, status: "superseded", error: null },
      { version: version + 1, status: "parsed", error: null },
    ]);

    // Robinhood Cash and Brokerage: the same periods, anchors, live rows and days — each credit once, not twice
    expect(stateOf(bundle.db, "Robinhood Cash")).toEqual(before.cash);
    expect(stateOf(bundle.db, "Robinhood Brokerage")).toEqual(before.brokerage);
    const notes = bundle.db
      .select({ notes: transactions.notes })
      .from(transactions)
      .where(and(eq(transactions.postedOn, "2026-08-24"), eq(transactions.amountCents, 149999), ne(transactions.status, "superseded")))
      .all();
    expect(notes).toEqual([{ notes: "ETH sold for the car" }]);

    // Robinhood Agentic: its August, at last
    expect(stateOf(bundle.db, "Robinhood Agentic").periods).toEqual([
      { start: "2026-08-01", end: "2026-08-31", beginCents: 2664, endCents: 164, reconciliation: "reconciled", gapCents: null },
    ]);
  });

  /**
   * 🔴 Measured by a second reader on a copy of the real ledger: a withheld August whose balance did not move, then a
   * September opening at that balance. The opening anchor lands on Aug 31, August's days carry, and Robinhood Agentic
   * read verified through Sep 30 with ledger-check green — the rule that an anchor on the far side of a hole closes
   * it. What the file says about August, and what /imports lists for it, must still hold AFTER September.
   */
  test("⛔ a later statement opening at the same balance closes the chain across a withheld month — the notice says it can, and the gaps panel does not send him to fetch it", async () => {
    const fakeToday = process.env.MONEYAPP_FAKE_TODAY;
    process.env.MONEYAPP_FAKE_TODAY = "2026-10-05";
    try {
      const agenticId = trackAllThree();
      await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
      const [august] = await importStatementFiles(bundle.db, [pdf(UNCHECKABLE_AUGUST_FILE, [...AUGUST_UNCHECKABLE, ...AUGUST_BROKERAGE])]);
      expect([august!.status, august!.withheld.map((w) => [w.accountId, w.periodStart, w.periodEnd])]).toEqual([
        "parsed",
        [[agenticId, "2026-08-01", "2026-08-31"]],
      ]);

      await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_SECOND, ...SEPTEMBER_BROKERAGE])]);

      const agentic = accountCoverage(bundle.db, "2026-10-05").find((c) => c.accountId === agenticId)!;
      expect([agentic.verifiedThrough, agentic.brokenSince]).toEqual(["2026-09-30", null]);

      const file = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, UNCHECKABLE_AUGUST_FILE)).get()!;
      expect(withheldNoticeOf(file)).toBe(
        "Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — it prints no Total Funds Paid and Received line, " +
          "so its activity cannot be checked. Nothing from that section is in the ledger: the activity it lists is missing, " +
          "and the account is not checked for those days unless a later statement's opening balance closes to the cent across them. " +
          "Importing the same file again changes nothing: the next statement parser version reads the section again, " +
          "and positions it proves go into the account's brokerage book, which the import creates.",
      );

      const gaps = statementGaps(bundle.db).find((g) => g.accountId === agenticId);
      expect(gaps?.withheld).toEqual([{ from: "2026-08-01", to: "2026-08-31", days: 31, fileName: UNCHECKABLE_AUGUST_FILE }]);
      // July was never imported here: THAT is a file to fetch
      expect(gaps?.holes.map((h) => [h.from, h.to])).toEqual([["2026-07-01", "2026-07-31"]]);
    } finally {
      if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
      else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
    }
  });
});

describe("the ledger's tracked accounts reach the Robinhood crypto parser through the import", () => {
  test("⛔ the ETH account is read even when the second crypto account prints first", async () => {
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "crypto", name: "Robinhood Crypto", last4: "8474" });
    // from robinhood-crypto-2026-07.pdf, with the two accounts' pages swapped
    const texts = [
      "Crypto Statement",
      "07-2026",
      "ACCOUNT NUMBER 311407134147",
      "RHS ACCOUNT NUMBER 655929651",
      "PERIOD START 2026-07-01",
      "PERIOD END 2026-07-31",
      "OPENING BALANCE $0",
      "CLOSING BALANCE $0",
      "You had no coin holding in your crypto account.",
      "Crypto Statement",
      "07-2026",
      "ACCOUNT NUMBER 311070628474",
      "RHS ACCOUNT NUMBER 487513525",
      "PERIOD START 2026-07-01",
      "PERIOD END 2026-07-31",
      "OPENING BALANCE $27359.92709892",
      "CLOSING BALANCE $28365.48180495",
      "ACCOUNT ACTIVITY",
      "DATE TRANSACTION TYPE DEBIT CREDIT PRICE VALUE FEE",
      "2026-07-07 Crypto Sale 2.798146 ETH -- $1786.80688415 $4999.75 --",
    ];

    const [outcome] = await importStatementFiles(bundle.db, [pdf("robinhood-crypto-2026-07.pdf", texts.map((t) => line(t)))]);

    expect(outcome!.error).toBeUndefined();
    expect(bundle.db.select().from(importFiles).get()!.parserProfile).toBe("robinhood-crypto-statement-pdf");
    expect(periods()).toEqual([
      { account: "Robinhood Crypto", last4: "8474", start: "2026-07-01", end: "2026-07-31", beginCents: 2735993, endCents: 2836548, reconciliation: "value_anchor" },
    ]);
  });

  test("⛔ the brokerage's last4 is not a crypto account: a one-account crypto statement imports while Robinhood Crypto has no number", async () => {
    // The crypto profile's hint carries no last4, so a Robinhood Crypto it creates never has one — while the
    // brokerage statement gives Robinhood Brokerage its ····3525. 🔴 Measured on the 18 real crypto PDFs with
    // only ····3525 tracked: ef16a75 refused ALL 18 ("none is an account this ledger tracks (····3525)"), each
    // of which imported before it.
    trackBrokerageAndCash();
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "crypto", name: "Robinhood Crypto" });
    // robinhood-crypto-statement-2025-11 (0a5e6044…): one account, printed with its number
    const texts = [
      "Crypto Statement",
      "11-2025",
      "ACCOUNT NUMBER 311070628474",
      "PERIOD START 2025-11-01",
      "PERIOD END 2025-11-30",
      "OPENING BALANCE $1504.99929923",
      "CLOSING BALANCE $3480.4884827",
      "ACCOUNT ACTIVITY",
      "DATE TRANSACTION TYPE DEBIT CREDIT PRICE VALUE FEE",
      "2025-11-04 Crypto Purchase -- 0.32258 ETH $3098.85441497 $999.63 --",
    ];

    const [outcome] = await importStatementFiles(bundle.db, [pdf("0a5e6044-65c3-5353-9c71-ed985b2f1b75.pdf", texts.map((t) => line(t)))]);

    expect(outcome!.error).toBeUndefined();
    expect(outcome!.status).toBe("parsed");
    expect(periods()).toEqual([
      { account: "Robinhood Crypto", last4: null, start: "2025-11-01", end: "2025-11-30", beginCents: 150500, endCents: 348049, reconciliation: "value_anchor" },
    ]);
  });

  test("a two-account crypto statement is still refused while no crypto account carries a number, whatever else is tracked", async () => {
    trackBrokerageAndCash();
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "crypto", name: "Robinhood Crypto" });
    const texts = [
      "Crypto Statement",
      "ACCOUNT NUMBER 311070628474",
      "PERIOD START 2026-07-01",
      "PERIOD END 2026-07-31",
      "OPENING BALANCE $27359.92709892",
      "CLOSING BALANCE $28365.48180495",
      "Crypto Statement",
      "ACCOUNT NUMBER 311407134147",
      "PERIOD START 2026-07-01",
      "PERIOD END 2026-07-31",
      "OPENING BALANCE $0",
      "CLOSING BALANCE $0",
    ];

    const [outcome] = await importStatementFiles(bundle.db, [pdf("robinhood-crypto-2026-07.pdf", texts.map((t) => line(t)))]);

    expect(outcome!.status).toBe("failed");
    expect(outcome!.error).toMatch(/#311070628474, #311407134147.*refusing to guess/);
    expect(periods()).toEqual([]);
  });
});
