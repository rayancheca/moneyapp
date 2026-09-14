import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import type { Line } from "./profiles/pdf-profile";
import { importStatementFiles, resolveAccount, type ImportInput } from "./service";

/**
 * The ledger's tracked accounts must REACH the Robinhood brokerage parser.
 *
 * 3902f69 made the parser choose the account section by the last4 the ledger
 * tracks, because the 2026-08 statement printed the untracked #655929651
 * ($26.64) FIRST. That choice depends on two links, and until this file no test
 * went through either one:
 *   1. `importOneFile` → `profile.parse(file, parseContextFor(db))`
 *   2. the profile's `parse` → `parseRobinhoodBrokerageDocument(lines, context?.knownLast4s.Robinhood ?? [])`
 *
 * 🔴 Measured by a second reader: mutating link 1 to `profile.parse(file)`, or
 * link 2 to `parseRobinhoodBrokerageDocument(lines, [])`, left
 * `vitest run src/services/import` at 235 passed. Every existing test called
 * `parseRobinhoodBrokerageDocument(doc, TRACKED)` directly, handing it the very
 * list the import path is supposed to supply, and `parseContextFor` was checked
 * only as a map. Either mutation makes the real 2026-08 file fail to import.
 *
 * So this goes through `importStatementFiles` on a real temp database. The one
 * thing faked is text extraction (`extractLines`). Profile routing
 * (`selectProfile`) and the profile's own `parse` both call it, so the mocked
 * lines pass through the real content gates exactly as a real PDF's would.
 */

const { STATEMENT_LINES } = vi.hoisted(() => {
  /** the 2026-08 order: every literal copied from the extracted file (see the profile test's UNTRACKED_FIRST) */
  const texts = [
    "08/01/2026 to 08/31/2026",
    "Individual Account #:655929651",
    "Account Summary",
    "Net Account Balance $26.64 $26.64",
    "Total Securities $0.00 $0.00",
    "Portfolio Value $26.64 $26.64",
    "08/01/2026 to 08/31/2026",
    "Individual Account #:487513525",
    "Account Summary",
    "Brokerage Cash Balance * $1,679.93 $0.68",
    "Deposit Sweep Balance $0.45 $1,000.33",
    "Total Securities ** $67,859.26 $72,959.32",
    "Portfolio Value $69,539.64 $73,960.33",
  ];
  const lines: Line[] = texts.map((text, i) => ({ y: i, text, tokens: [] }));
  return { STATEMENT_LINES: lines };
});

vi.mock("./profiles/pdf-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./profiles/pdf-profile")>()),
  extractLines: async (): Promise<Line[]> => STATEMENT_LINES,
}));

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

/** A fake PDF, just enough for `sniffFile` to see a PDF. The name is an opaque UUID, the way Robinhood names its files. */
const STATEMENT: ImportInput = {
  name: "7c1e4b2a-9d3f-4e8a-b5c6-0f2d8a1e3b47.pdf",
  buffer: Buffer.from("%PDF-1.7\n"),
};

function periods() {
  return bundle.db
    .select({
      account: accounts.name,
      last4: accounts.last4,
      start: statementPeriods.periodStart,
      end: statementPeriods.periodEnd,
      beginCents: statementPeriods.beginningBalanceCents,
      endCents: statementPeriods.endingBalanceCents,
    })
    .from(statementPeriods)
    .innerJoin(accounts, eq(statementPeriods.accountId, accounts.id))
    .all();
}

describe("the ledger's tracked last4 reaches the Robinhood brokerage parser through the import", () => {
  test("⛔ the 2026-08 order: the untracked account prints first, and the tracked one is imported", async () => {
    // the owner's ledger: the brokerage carries last4 3525, and the cash ledger has no number
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage", last4: "3525" });
    resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });

    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    // not "failed … refusing to guess which is Robinhood Cash", which is what a dropped context produces
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
    expect(bundle.db.select().from(accounts).all().filter((a) => a.name.startsWith("Robinhood")).length).toBe(2);
  });

  test("the same bytes on a ledger that tracks no Robinhood last4 are refused, not guessed", async () => {
    // the control: the file is identical, so only the ledger decided the import above
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage" });
    resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });

    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome!.status).toBe("failed");
    expect(outcome!.error).toMatch(/#655929651, #487513525.*refusing to guess/);
    expect(periods()).toEqual([]);
  });
});
