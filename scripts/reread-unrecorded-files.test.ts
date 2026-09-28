import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { importFiles, printedLines } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { rebuildAccount } from "@/services/derivation";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, type ImportInput } from "@/services/import/service";
import type { AccountHint, ParsedStatement, ParserProfile } from "@/services/import/types";
import { main } from "./reread-unrecorded-files";

/**
 * A statement imported at v1 before the importer recorded what a file prints, whose profile has since moved to v2 — the
 * shape of the 34 files on the real ledger (the Discover CSV at v1 against v2, 33 Robinhood brokerage PDFs at v3/v4
 * against v5). The backfills read a file only at the version that imported it, so only a re-read at v2 records it, and
 * the owner's rule for that re-read (2026-09-28): keep every category, and refuse if anything but the records changes.
 */
const PREFIX = "reread-unrecorded-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "5201" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "BLUE BOTTLE 12", bankCategory: "FOOD_AND_DRINK" };
const GROCER = { postedOn: "2026-03-12", amountCents: -2500, rawDescription: "CORNER GROCER", bankCategory: "GROCERIES" };
const MARCH = { start: "2026-03-01", end: "2026-03-31", beginCents: 10_000, endCents: 6_500 };
const statement = (txns: ParsedStatement["txns"], period = MARCH): ParsedStatement[] => [{ accountHint: CHECKING, txns, period }];

/** what each version of the profile reads from each file, by the file's text */
let reads: Record<number, Record<string, ParsedStatement[]>> = {};
const profile: ParserProfile = {
  id: "test-reread-unrecorded",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => reads[profile.version]![f.text]!,
};

let dir: string;
let ledger: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reread-unrecorded-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  process.env.MONEYAPP_BACKUPS_DIR = path.join(dir, "backups");
  fs.mkdirSync(path.join(dir, "scratch"));
  ledger = path.join(dir, "ledger.db");
  bundle = createDatabase(ledger);
  seedDatabase(bundle.db);
  profile.version = 1;
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  delete process.env.MONEYAPP_BACKUPS_DIR;
});

const FILE: ImportInput = { name: `${PREFIX}statement.csv`, buffer: Buffer.from("march") };
const args = (...more: string[]) => [`--db=${ledger}`, `--scratch=${path.join(dir, "scratch")}`, ...more];

function categoryId(parent: string, name: string): string {
  const p = bundle.db.select().from(categories).where(eq(categories.name, parent)).get()!;
  return bundle.db.select().from(categories).where(and(eq(categories.name, name), eq(categories.parentId, p.id))).get()!.id;
}

/** Imported at v1, its record taken away (the importer did not write one then), and the profile moved on to v2. */
async function importedBeforeRecordsThenBumped(v1: ParsedStatement[], v2: ParsedStatement[]): Promise<void> {
  reads = { 1: { march: v1 }, 2: { march: v2 } };
  await importStatementFiles(bundle.db, [FILE]);
  bundle.db.delete(printedLines).run();
  profile.version = 2;
}

/**
 * March and April, both read at v1 and April FIRST — so March's closing balance, written last, is the one the 03-31
 * anchor cites, although April opens on it. A re-read reads them in one call, March first, and April's opening wins.
 */
const MARCH_FILE: ImportInput = { name: `${PREFIX}1-march.csv`, buffer: Buffer.from("march") };
const APRIL_FILE: ImportInput = { name: `${PREFIX}2-april.csv`, buffer: Buffer.from("april") };
const APRIL = { start: "2026-04-01", end: "2026-04-30", beginCents: 6_500, endCents: 5_000 };
const RENT = { postedOn: "2026-04-03", amountCents: -1500, rawDescription: "APRIL RENT SHARE" };
async function twoMonthsReadAprilFirstThenBumped(): Promise<void> {
  const months = { march: statement([COFFEE, GROCER]), april: statement([RENT], APRIL) };
  reads = { 1: months, 2: months };
  await importStatementFiles(bundle.db, [APRIL_FILE]);
  await importStatementFiles(bundle.db, [MARCH_FILE]);
  bundle.db.delete(printedLines).run();
  profile.version = 2;
}
const citedBy = (day: string) =>
  bundle.sqlite
    .prepare("SELECT f.file_name AS file FROM balance_anchors a JOIN import_files f ON f.id = a.import_file_id WHERE a.anchored_on = ?")
    .get(day) as { file: string };

/** The live rows as the owner sees them. */
const liveRows = () =>
  bundle.db
    .select({
      on: transactions.postedOn,
      cents: transactions.amountCents,
      description: transactions.rawDescription,
      category: transactions.categoryId,
      source: transactions.categorizationSource,
      notes: transactions.notes,
    })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .orderBy(transactions.postedOn)
    .all();
const fileRows = () =>
  bundle.db
    .select({ version: importFiles.parserVersion, status: importFiles.status })
    .from(importFiles)
    .orderBy(importFiles.parserVersion)
    .all();
const backups = () => (fs.existsSync(path.join(dir, "backups")) ? fs.readdirSync(path.join(dir, "backups")) : []);

/** Reopen after a run: the script wrote through its own connection. */
function reopen(): void {
  bundle.sqlite.close();
  bundle = createDatabase(ledger);
}

describe("reread-unrecorded-files — re-read the files the backfills cannot, and refuse unless only the records change", () => {
  test("rehearses and writes nothing by default; --confirm re-reads behind a restore point; a second run has nothing to do", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    // his hand category on the coffee, and a note: what a re-read must carry
    const coffee = bundle.db.select().from(transactions).where(eq(transactions.rawDescription, COFFEE.rawDescription)).get()!;
    bundle.db
      .update(transactions)
      .set({ categoryId: categoryId("Food", "Coffee"), categorizationSource: "user", notes: "his" })
      .where(eq(transactions.id, coffee.id))
      .run();
    // the account's balances were last rebuilt on 03-20, as on the real ledger (Discover's stopped at 09-14)
    bundle.db.delete(dailyBalances).where(gt(dailyBalances.day, "2026-03-20")).run();
    const rows = liveRows();
    expect(rows.map((r) => [r.description, r.source])).toEqual([
      [COFFEE.rawDescription, "user"],
      [GROCER.rawDescription, "bank_category"],
    ]);
    bundle.sqlite.close();

    const dry = await main(args());

    reopen();
    expect(dry.outcome).toBe("dry-run");
    expect(dry.failures).toEqual([]);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(bundle.db.select().from(printedLines).all()).toEqual([]);
    expect(backups()).toEqual([]);
    // the rehearsal names what a re-read may change: the record, and the days a rebuild carries to today
    expect(dry.allowed.join("\n")).toMatch(/1 printed-line record/);
    expect(dry.allowed.join("\n")).toMatch(/carried to/);
    bundle.sqlite.close();

    const written = await main(args("--confirm"));

    reopen();
    expect(written.failures).toEqual([]);
    expect(written.outcome).toBe("written");
    expect(written.restorePoint).not.toBeNull();
    expect(backups()).toEqual([path.basename(written.restorePoint!)]);
    expect(fileRows()).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "parsed" },
    ]);
    expect(bundle.db.select().from(printedLines).all()).toHaveLength(1);
    expect(liveRows()).toEqual(rows);
    bundle.sqlite.close();

    const again = await main(args("--confirm"));

    reopen();
    expect(again.outcome).toBe("nothing-to-do");
    expect(backups()).toHaveLength(1);
  });

  test("refuses, and writes nothing, when the re-read would move a category", async () => {
    // v2 reads Discover's bucket for the grocer as dining: the bank-category engine would file it elsewhere
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, { ...GROCER, bankCategory: "FOOD_AND_DRINK" }]));
    const rows = liveRows();
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.outcome).toBe("refused");
    expect(run.failures.join("\n")).toMatch(/CORNER GROCER/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    expect(backups()).toEqual([]);
  });

  test("refuses when the re-read would move money", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, { ...GROCER, amountCents: -2400 }]));
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.outcome).toBe("refused");
    expect(run.failures.length).toBeGreaterThan(0);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(backups()).toEqual([]);
  });

  test("refuses before reading anything when an original is not the imported bytes", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const stored = bundle.db.select().from(importFiles).get()!.storagePath;
    fs.writeFileSync(stored, "april");
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.outcome).toBe("refused");
    expect(run.failures.join("\n")).toMatch(/not the imported bytes/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
  });

  test("a dedupe key that now agrees with the day its row carries is named, not refused", async () => {
    // Discover back-dates a dispute credit's Post Date; v2 takes the later printed day, and a one-off script had
    // already re-dated the row in place — so only the key the v1 read derived from the old day moves
    const backdated = { ...GROCER, postedOn: "2026-03-09" };
    await importedBeforeRecordsThenBumped(statement([COFFEE, backdated]), statement([COFFEE, GROCER]));
    const row = bundle.db.select().from(transactions).where(eq(transactions.rawDescription, GROCER.rawDescription)).get()!;
    bundle.db.update(transactions).set({ postedOn: GROCER.postedOn }).where(eq(transactions.id, row.id)).run();
    rebuildAccount(bundle.db, row.accountId);
    const rows = liveRows();
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.failures).toEqual([]);
    expect(run.outcome).toBe("written");
    expect(run.allowed.join("\n")).toMatch(/dedupe key.*CORNER GROCER/);
    expect(liveRows()).toEqual(rows);
  });

  test("a real write that does not match its rehearsal is put back from its restore point", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const rows = liveRows();
    const dining = categoryId("Food", "Dining");
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // something the rehearsal did not do: the new read's grocer moves to another category on the real ledger
      afterWrite: (real) => {
        real.db
          .update(transactions)
          .set({ categoryId: dining })
          .where(and(eq(transactions.rawDescription, GROCER.rawDescription), eq(transactions.status, "active")))
          .run();
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/CORNER GROCER/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    expect(bundle.db.select().from(printedLines).all()).toEqual([]);
  });

  test("a day carried to today must be what a rebuild of the untouched ledger writes — anything else is put back", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    bundle.db.delete(dailyBalances).where(gt(dailyBalances.day, "2026-03-20")).run();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // a carried day off by a cent: no row, no period and no day net worth had before says so — only the rebuild does
      afterWrite: (real) => {
        real.sqlite.prepare("UPDATE daily_balances SET balance_cents = balance_cents + 1 WHERE day = (SELECT max(day) FROM daily_balances)").run();
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/no rebuild writes/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
  });

  test("a month-end balance may come to cite the other statement that prints it — and is named", async () => {
    await twoMonthsReadAprilFirstThenBumped();
    expect(citedBy("2026-03-31").file).toBe(MARCH_FILE.name);
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.failures).toEqual([]);
    expect(run.outcome).toBe("written");
    expect(citedBy("2026-03-31").file).toBe(APRIL_FILE.name);
    expect(run.allowed.join("\n")).toMatch(/1 month-end balance\(s\) now cite the other statement.*2026-03-31/);
  });

  test("a balance that comes to cite a statement which does not print it is put back", async () => {
    await twoMonthsReadAprilFirstThenBumped();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // March's opening balance, pointed at April's new read: April prints nothing on 02-28
      afterWrite: (real) => {
        real.sqlite
          .prepare(
            `UPDATE balance_anchors SET (import_file_id, statement_period_id) =
               (SELECT p.import_file_id, p.id FROM statement_periods p JOIN import_files f ON f.id = p.import_file_id
                 WHERE p.period_start = '2026-04-01' AND f.status = 'parsed')
             WHERE anchored_on = '2026-02-28'`,
          )
          .run();
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/cite another statement.*2026-02-28/);
    expect(citedBy("2026-02-28").file).toBe(MARCH_FILE.name);
  });

  test("refuses an argument it does not take, and never guesses the database", async () => {
    bundle.sqlite.close();
    await expect(main(["--confirm"])).rejects.toThrow(/--db=<path> is required/);
    await expect(main(args("--yes"))).rejects.toThrow(/--yes/);
    reopen();
  });
});
