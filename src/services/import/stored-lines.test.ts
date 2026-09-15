import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import type { Line } from "./profiles/pdf-profile";
import { chaseCardStatementPdf } from "./profiles/chase-card-statement-profile";
import { importStatementFiles, parseContextFor, storedLines, type ImportInput } from "./service";
import { sniffFile } from "./sniff";

/*
 * Text extraction is the one thing faked, keyed by the fake file's bytes (the seam
 * scripts/robinhood-agentic-account.test.ts uses), so routing, the Chase card parser and the importer all run
 * for real on these lines.
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

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-stored-lines-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  DOCUMENTS.clear();
});

/** A Chase card statement PDF as the extractor would read it. */
function cardPdf(name: string, rows: readonly string[], balances: { previous: string; next: string }): ImportInput {
  const buffer = Buffer.from(`%PDF-1.4\n${name}`, "latin1");
  const texts = [
    "Account Number: XXXX XXXX XXXX 9805",
    `Previous Balance ${balances.previous}`,
    `New Balance ${balances.next}`,
    "Opening/Closing Date 09/03/25 - 10/02/25",
    "Credit Access Line $12,100",
    "Merchant Name or Transaction Description $ Amount",
    "PAYMENTS AND OTHER CREDITS",
    ...rows,
  ];
  DOCUMENTS.set(buffer.toString("latin1"), texts.map((text, i) => ({ y: i, text, tokens: [] })));
  return { name, buffer };
}

// Sapphire's straddler (printed 09/02, the day before the period opens), two identical charges on one day, and
// a card payment
const ROWS = [
  "09/02 BEST BUY CO 00012617 BRONX NY -92.53",
  "09/15 CPI*CANTEEN VENDING MIAMI 800-628-8363 FL 1.75",
  "09/15 CPI*CANTEEN VENDING MIAMI 800-628-8363 FL 1.75",
  "09/30 Payment Thank You-Mobile -100.00",
];
// card-side: -92.53 + 1.75 + 1.75 - 100.00 = -189.03
const BALANCES = { previous: "$200.00", next: "$10.97" };

describe("storedLines — the identity a statement's rows are stored under", () => {
  test("names, for every printed row, exactly the columns the import stores", async () => {
    const file = cardPdf("20251002-statements-9805-.pdf", ROWS, BALANCES);
    const [outcome] = await importStatementFiles(bundle.db, [file]);
    expect(outcome).toMatchObject({ status: "parsed", inserted: 4 });
    const card = bundle.db.select().from(accounts).where(eq(accounts.last4, "9805")).get()!;

    const [statement] = await chaseCardStatementPdf.parse(sniffFile(file.name, file.buffer), parseContextFor(bundle.db));
    const lines = storedLines(card.id, card, statement!);

    const stored = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, card.id), ne(transactions.status, "superseded")))
      .all()
      .map((r) => [r.postedOn, r.transactedOn, r.amountCents, r.rawDescription, r.occurrenceIndex, r.dedupeHash].join("|"))
      .sort();
    const named = lines
      .map((l) =>
        [l.stored.postedOn, l.stored.transactedOn ?? null, l.stored.amountCents, l.stored.rawDescription, l.occurrenceIndex, l.hash].join("|"),
      )
      .sort();
    expect(named).toEqual(stored);
    // the straddler is printed before the period and stored on its opening day; the twin charge is numbered 1
    expect(lines.map((l) => [l.printed.postedOn, l.stored.postedOn, l.occurrenceIndex])).toEqual([
      ["2025-09-02", "2025-09-03", 0],
      ["2025-09-15", "2025-09-15", 0],
      ["2025-09-15", "2025-09-15", 1],
      ["2025-09-30", "2025-09-30", 0],
    ]);
    // …and pinned apart from the importer, which asks this same rule: the hash reads the STORED day and the
    // occurrence the day's twins are numbered by
    const vending = "CPI*CANTEEN VENDING MIAMI 800-628-8363 FL";
    expect(lines.map((l) => l.hash)).toEqual([
      dedupeHash({ accountId: card.id, postedOn: "2025-09-03", amountCents: 9253, rawDescription: "BEST BUY CO 00012617 BRONX NY", occurrenceIndex: 0 }),
      dedupeHash({ accountId: card.id, postedOn: "2025-09-15", amountCents: -175, rawDescription: vending, occurrenceIndex: 0 }),
      dedupeHash({ accountId: card.id, postedOn: "2025-09-15", amountCents: -175, rawDescription: vending, occurrenceIndex: 1 }),
      dedupeHash({ accountId: card.id, postedOn: "2025-09-30", amountCents: 10000, rawDescription: "Payment Thank You-Mobile", occurrenceIndex: 0 }),
    ]);
  });

  test("an account whose periods need not close keeps every printed day", async () => {
    const file = cardPdf("20251002-statements-9805-.pdf", ROWS, BALANCES);
    const [statement] = await chaseCardStatementPdf.parse(sniffFile(file.name, file.buffer), parseContextFor(bundle.db));

    const lines = storedLines("any-account", { type: "investment" }, statement!);

    expect(lines.map((l) => l.stored.postedOn)).toEqual(["2025-09-02", "2025-09-15", "2025-09-15", "2025-09-30"]);
  });
});
