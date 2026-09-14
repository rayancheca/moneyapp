import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "@/services/accounts";
import type { Line } from "./profiles/pdf-profile";
import { importStatementFiles, resolveAccount, type ImportInput } from "./service";

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
function trackBrokerageAndCash(): void {
  resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage", last4: "3525" });
  resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });
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

    expect(outcomes.map((o) => [o.status, o.error])).toEqual([
      ["parsed", undefined],
      ["parsed", undefined],
      ["parsed", undefined],
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
});
