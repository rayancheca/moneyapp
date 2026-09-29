import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { importFiles, printedLines } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { fileSha256 } from "@/lib/hash";
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
/** The statement a day's recorded balance cites — its file, and which read of it. */
const citedBy = (day: string) =>
  bundle.sqlite
    .prepare(
      `SELECT f.file_name AS file, f.parser_version AS version FROM balance_anchors a JOIN import_files f ON f.id = a.import_file_id
        WHERE a.anchored_on = ? AND a.source = 'statement'`,
    )
    .get(day) as { file: string; version: number };
/**
 * ⚖️ What a re-read may say it changed — his rule (§6A 26, 2026-09-28): the files read again, and the records they
 * write. Nothing else.
 */
const onlyTheRecords = (files: number) => [
  `${files} file(s) read again at their profile's version; the older reads retired`,
  `${files} printed-line record(s) over ${files} file(s)`,
  "0 statement cop(ies)",
  "0 card number(s)",
];
/** The last day any account's balances are cached through — what the dashboard counts unchecked days to. */
const lastCachedDay = () => (bundle.sqlite.prepare("SELECT max(day) AS day FROM daily_balances").get() as { day: string }).day;

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

/** Every file under `root` by its path there, with the hash of its bytes — what a run must leave as it found it. */
function listing(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }) : []) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fileSha256(fs.readFileSync(full));
    }
  };
  walk(root);
  return out;
}

/**
 * A read of the same bytes at the profile's version that failed: its row is kept (`REIMPORTABLE_STATUSES`), and its
 * original stays where a read archives first — the institution's folder, not the account's.
 */
async function failedReadAtTodaysVersion(): Promise<typeof importFiles.$inferSelect> {
  const v2 = reads[2]!;
  delete reads[2];
  const [outcome] = await importStatementFiles(bundle.db, [FILE]);
  reads[2] = v2;
  expect(outcome?.status).toBe("failed");
  return bundle.db.select().from(importFiles).where(and(eq(importFiles.parserVersion, 2), eq(importFiles.status, "failed"))).get()!;
}

/**
 * What an import killed or faulted part-way through a file leaves in the archive: its own copy of the original, in the
 * institution's folder, where it archives a file before reading it (`archiveTo`) and moves it from once it has.
 */
function leaveCopyBehind(real: DbBundle): string {
  const original = real.db.select().from(importFiles).where(eq(importFiles.parserVersion, 1)).get()!.storagePath;
  const copy = path.join(dir, "originals", "chase", path.basename(original));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(original, copy);
  return copy;
}

/** The ledger laid out as the owner's is: data/moneyapp.db under the checkout the script runs in, originals in data/statements. */
function asTheRealLedger(): string {
  bundle.sqlite.close();
  ledger = path.join(dir, "data", "moneyapp.db");
  const own = path.join(dir, "data", "statements");
  process.env.MONEYAPP_ORIGINALS_DIR = own;
  bundle = createDatabase(ledger);
  seedDatabase(bundle.db);
  return own;
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
    // the rehearsal names what the re-read changes: the file read again, and its record — nothing else
    expect(dry.allowed).toEqual(onlyTheRecords(1));
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
    expect(written.allowed).toEqual(onlyTheRecords(1));
    // 🔴 the import rebuilds the accounts it reads to today: the cache stops where it stopped, or the dashboard's count
    // of unchecked days moves ("15 days unchecked" read 28 on a copy of the real ledger, 2026-09-28)
    expect(lastCachedDay()).toBe("2026-03-20");
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

  test("a row keeps the dedupe key the ledger gave it — even one the new version derives anew from the day the row carries", async () => {
    // Discover back-dates a dispute credit's Post Date; v2 takes the later printed day, and a one-off script had
    // already re-dated the row in place without re-keying it — so the v2 read derives another key for the same row (3
    // Discover rows on the real ledger). ⚖️ His rule admits the records and nothing else: the key stays as it was.
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
    expect(run.allowed).toEqual(onlyTheRecords(1));
    expect(liveRows()).toEqual(rows);
    const fresh = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.rawDescription, GROCER.rawDescription), eq(transactions.status, "active")))
      .get()!;
    expect(fresh.id).not.toBe(row.id);
    expect(fresh.dedupeHash).toBe(row.dedupeHash);
  });

  test("a dedupe key the write changes is put back", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const rows = liveRows();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      afterWrite: (real) => {
        real.sqlite
          .prepare("UPDATE transactions SET dedupe_hash = 'moved-' || dedupe_hash WHERE status = 'active' AND raw_description = ?")
          .run(GROCER.rawDescription);
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/dedupe key.*CORNER GROCER/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
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

  test("a balance day the ledger did not have is put back — the dashboard would count its unchecked days anew", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    // last rebuilt on 03-20, as on the real ledger (Discover's cache stops at 09-14)
    bundle.db.delete(dailyBalances).where(gt(dailyBalances.day, "2026-03-20")).run();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // one day past where the cache stops, as the import's rebuild to today writes them
      afterWrite: (real) => {
        real.sqlite
          .prepare(
            `INSERT INTO daily_balances (account_id, day, balance_cents, basis)
               SELECT account_id, '2026-03-21', balance_cents, basis FROM daily_balances WHERE day = '2026-03-20'`,
          )
          .run();
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/balance day\(s\) the ledger did not have/);
    expect(run.failures.join("\n")).toMatch(/net worth gained 1 day/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(lastCachedDay()).toBe("2026-03-20");
  });

  test("a re-read keeps each month-end balance citing the statement it cited — the one that closes on it", async () => {
    await twoMonthsReadAprilFirstThenBumped();
    expect(citedBy("2026-03-31")).toEqual({ file: MARCH_FILE.name, version: 1 });
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.failures).toEqual([]);
    expect(run.outcome).toBe("written");
    expect(run.allowed).toEqual(onlyTheRecords(2));
    expect(citedBy("2026-03-31")).toEqual({ file: MARCH_FILE.name, version: 2 });
  });

  test("a month-end balance that comes to cite the other statement that prints it — same day, same balance — is put back", async () => {
    await twoMonthsReadAprilFirstThenBumped();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // what the re-read did before it kept citations: 03-31 to April's new read, which opens the day after it
      afterWrite: (real) => {
        real.sqlite
          .prepare(
            `UPDATE balance_anchors SET (import_file_id, statement_period_id) =
               (SELECT p.import_file_id, p.id FROM statement_periods p JOIN import_files f ON f.id = p.import_file_id
                 WHERE p.period_start = '2026-04-01' AND f.status = 'parsed')
             WHERE anchored_on = '2026-03-31'`,
          )
          .run();
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/cite another statement.*2026-03-31/);
    expect(citedBy("2026-03-31")).toEqual({ file: MARCH_FILE.name, version: 1 });
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

  test("a statement period that comes to belong to another statement is put back", async () => {
    await twoMonthsReadAprilFirstThenBumped();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // the two new reads' periods swapped: same days, same balances, each filed under the other statement (a file
      // holds one period per account, so April's waits under its retired read while March's moves)
      afterWrite: (real) => {
        const read = (input: ImportInput, version: number) =>
          real.db
            .select()
            .from(importFiles)
            .where(and(eq(importFiles.fileName, input.name), eq(importFiles.parserVersion, version)))
            .get()!.id;
        const [march, april, parked] = [read(MARCH_FILE, 2), read(APRIL_FILE, 2), read(APRIL_FILE, 1)];
        const move = real.sqlite.prepare("UPDATE statement_periods SET import_file_id = ? WHERE import_file_id = ?");
        move.run(parked, april);
        move.run(april, march);
        move.run(march, parked);
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/statement period.*2026-03-01/);
    expect(fileRows()).toEqual([
      { version: 1, status: "parsed" },
      { version: 1, status: "parsed" },
    ]);
  });

  test("a row that comes to be filed under another statement is put back", async () => {
    await twoMonthsReadAprilFirstThenBumped();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // the coffee March prints, filed under April's new read: same money, day and words, the other statement named
      afterWrite: (real) => {
        const april = real.db
          .select()
          .from(importFiles)
          .where(and(eq(importFiles.fileName, APRIL_FILE.name), eq(importFiles.parserVersion, 2)))
          .get()!.id;
        real.sqlite
          .prepare("UPDATE transactions SET import_file_id = ? WHERE status = 'active' AND raw_description = ?")
          .run(april, COFFEE.rawDescription);
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/BLUE BOTTLE 12/);
  });

  test("refuses an argument it does not take, and never guesses the database", async () => {
    bundle.sqlite.close();
    await expect(main(["--confirm"])).rejects.toThrow(/--db=<path> is required/);
    await expect(main(args("--yes"))).rejects.toThrow(/--yes/);
    reopen();
  });
});

describe("reread-unrecorded-files — once the restore point is taken, the ledger ends checked or put back", () => {
  test("a write that faults after its restore point is put back, and says so", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const rows = liveRows();
    const archive = listing(path.join(dir, "originals"));
    bundle.sqlite.close();
    let leftover = "";

    const run = await main(args("--confirm"), {
      afterWrite: (real) => {
        leftover = leaveCopyBehind(real);
        throw new Error("the disk filled up");
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/the disk filled up/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    expect(bundle.db.select().from(printedLines).all()).toEqual([]);
    // the write's own copy of an original goes with it: nothing names it now, and the next rehearsal would refuse a
    // write that removes it
    expect(fs.existsSync(leftover)).toBe(false);
    expect(listing(path.join(dir, "originals"))).toEqual(archive);
    bundle.sqlite.close();
    // nothing is left for a later run to take for done, nor to stop it: it plans the re-read again
    expect((await main(args())).outcome).toBe("dry-run");
  });

  test("a write killed before its check leaves none of it: a later run will not call it done, and --confirm closes it", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const rows = liveRows();
    const archive = listing(path.join(dir, "originals"));
    bundle.sqlite.close();
    let dying: DbBundle | undefined;
    let leftover = "";
    // killed in the import: nothing after it runs — no check, no put-back — as when the process dies
    void main(args("--confirm"), {
      afterWrite: (real) => {
        dying = real;
        leftover = leaveCopyBehind(real);
        return new Promise<never>(() => {});
      },
    });
    await vi.waitFor(() => expect(dying).toBeDefined(), { timeout: 10_000 });
    dying!.sqlite.close();
    // …and an original that came after it, which no put-back of this write may take
    const later = path.join(dir, "originals", "chase", "an-upload-after-the-kill.csv");
    fs.writeFileSync(later, "april");

    const dry = await main(args());

    expect(dry.outcome).toBe("unfinished");
    expect(dry.failures.join("\n")).toMatch(/never checked/);
    expect(dry.failures.join("\n")).toMatch(/holds none of it/);
    reopen();
    // the write was one transaction the dead run never committed, and SQLite rolled it back: none of it is on the ledger
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    // …and the dry run touched nothing: the write's own copy is still in the archive
    expect(fs.existsSync(leftover)).toBe(true);
    bundle.sqlite.close();

    const back = await main(args("--confirm"));

    reopen();
    expect(back.outcome).toBe("restored");
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(later)).toBe(true);
    fs.rmSync(later);
    expect(listing(path.join(dir, "originals"))).toEqual(archive);
    // nothing was put back over the ledger: the restore point is the one backup, no copy saved before a restore
    expect(backups()).toEqual([path.basename(back.restorePoint!)]);
    bundle.sqlite.close();
    expect((await main(args())).outcome).toBe("dry-run");
  });

  /**
   * 🔴 After a kill, nothing stops the ledger being written — the app, an upload, a backfill: none reads the journal — and
   * UNFINISHED --confirm put the journal's restore point back over it without a look, taking every later write out of the
   * live ledger (the review of uc/reread-34-runbook, 2026-09-29).
   */
  test("what the ledger is written with after a killed write stays through UNFINISHED --confirm", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    // a statement he uploads once the run is dead
    reads[2]!.april = statement([RENT], APRIL);
    bundle.sqlite.close();
    let dying: DbBundle | undefined;
    void main(args("--confirm"), {
      afterWrite: (real) => {
        dying = real;
        return new Promise<never>(() => {});
      },
    });
    await vi.waitFor(() => expect(dying).toBeDefined(), { timeout: 10_000 });
    dying!.sqlite.close();
    // …and the app writes on: his note on the grocer, and the upload
    bundle = createDatabase(ledger);
    bundle.db
      .update(transactions)
      .set({ notes: "his, after the kill" })
      .where(and(eq(transactions.rawDescription, GROCER.rawDescription), eq(transactions.status, "active")))
      .run();
    const [upload] = await importStatementFiles(bundle.db, [{ name: `${PREFIX}april.csv`, buffer: Buffer.from("april") }]);
    expect(upload!.status).toBe("parsed");
    const his = liveRows();
    expect(his.map((r) => [r.description, r.notes])).toEqual([
      [COFFEE.rawDescription, null],
      [GROCER.rawDescription, "his, after the kill"],
      [RENT.rawDescription, null],
    ]);
    bundle.sqlite.close();

    const back = await main(args("--confirm"));

    reopen();
    expect(back.failures.join("\n")).toMatch(/never checked/);
    expect(liveRows()).toEqual(his);
    // nothing was put back over the ledger: the restore point is the one backup, no copy saved before a restore
    expect(backups()).toEqual([path.basename(back.restorePoint!)]);
    bundle.sqlite.close();
    // the journal is gone, and the next run plans the re-read afresh
    expect((await main(args())).outcome).toBe("dry-run");
  });

  /** SQLite ends a transaction itself on some errors (a full disk), and what runs after it commits on its own. */
  function loseTheTransaction(real: DbBundle): void {
    real.sqlite.exec("ROLLBACK");
    real.sqlite.prepare("UPDATE transactions SET notes = 'committed on its own' WHERE raw_description = ?").run(GROCER.rawDescription);
  }
  const notesOnTheGrocer = () => liveRows().find((r) => r.description === GROCER.rawDescription)?.notes;

  test("a write whose transaction did not hold to its check is put back from its restore point", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const rows = liveRows();
    bundle.sqlite.close();

    const run = await main(args("--confirm"), { afterWrite: loseTheTransaction });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/did not hold to its check/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    // what the ledger held is saved before the restore point goes back over it
    expect(backups()).toHaveLength(2);
    bundle.sqlite.close();
    expect((await main(args())).outcome).toBe("dry-run");
  });

  test("a put-back that cannot be made leaves every later run refusing — never 'Nothing to do'", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    bundle.sqlite.close();

    const first = await main(args("--confirm"), {
      afterWrite: (real) => {
        // the transaction ends part-way, the restore point is lost, then the write faults: nothing can put it back
        loseTheTransaction(real);
        for (const name of backups()) fs.rmSync(path.join(dir, "backups", name));
        throw new Error("the disk filled up");
      },
    }).catch((error: unknown) => ({ outcome: `threw ${String(error)}`, failures: [] as string[] }));
    const again = await main(args());
    const retried = await main(args("--confirm"));

    expect(again.outcome).toBe("unfinished");
    expect(first.outcome).toBe("unfinished");
    expect(first.failures.join("\n")).toMatch(/could not be put back/);
    expect(retried.outcome).toBe("unfinished");
    expect(retried.failures.join("\n")).toMatch(/restore point/);
    // …and nothing was put back over the ledger: what the run left is there, for someone to compare
    reopen();
    expect(notesOnTheGrocer()).toBe("committed on its own");
  });

  test("a ledger that may hold part of a write is never put back over: its journal closes once it reads as its restore point", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const rows = liveRows();
    bundle.sqlite.close();
    let dying: DbBundle | undefined;
    // the transaction ends part-way, one statement after it commits on its own — the older read retired — then a kill
    void main(args("--confirm"), {
      afterWrite: (real) => {
        dying = real;
        real.sqlite.exec("ROLLBACK");
        real.sqlite.prepare("UPDATE import_files SET status = 'superseded' WHERE parser_version = 1").run();
        return new Promise<never>(() => {});
      },
    });
    await vi.waitFor(() => expect(dying).toBeDefined(), { timeout: 10_000 });
    dying!.sqlite.close();

    const dry = await main(args());
    const refused = await main(args("--confirm"));

    for (const run of [dry, refused]) {
      expect(run.outcome).toBe("unfinished");
      expect(run.failures.join("\n")).toMatch(/may hold part of it/);
      expect(run.failures.join("\n")).toMatch(/does not read as its restore point/);
    }
    reopen();
    expect(fileRows()).toEqual([{ version: 1, status: "superseded" }]);
    // someone compares the two, and puts back what the run left
    bundle.sqlite.prepare("UPDATE import_files SET status = 'parsed' WHERE parser_version = 1").run();
    bundle.sqlite.close();

    const back = await main(args("--confirm"));

    reopen();
    expect(back.outcome).toBe("restored");
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(liveRows()).toEqual(rows);
    bundle.sqlite.close();
    expect((await main(args())).outcome).toBe("dry-run");
  });
});

describe("reread-unrecorded-files — a dry run moves nothing outside scratch, and the archive is the ledger's own", () => {
  test("refuses, and moves nothing, when a read of the same bytes at today's version is already on the ledger", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const failed = await failedReadAtTodaysVersion();
    const archive = listing(path.join(dir, "originals"));
    expect(archive[path.relative(path.join(dir, "originals"), failed.storagePath)]).toBeDefined();
    bundle.sqlite.close();

    const dry = await main(args());

    reopen();
    expect(dry.outcome).toBe("refused");
    // ⛔ the rehearsal took that read up, moved its original into scratch — and deleted scratch
    expect(fs.existsSync(failed.storagePath)).toBe(true);
    expect(listing(path.join(dir, "originals"))).toEqual(archive);
    expect(dry.failures.join("\n")).toMatch(/already read at test-reread-unrecorded v2/);
    expect(backups()).toEqual([]);
  });

  test("the rehearsal reads a copy of the archive: a write that would remove an original is refused before it is made", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    // an original no row names, where a read of these bytes archives first — a failed read's, its row since removed
    const failed = await failedReadAtTodaysVersion();
    bundle.db.delete(importFiles).where(eq(importFiles.id, failed.id)).run();
    const archive = listing(path.join(dir, "originals"));
    bundle.sqlite.close();

    const run = await main(args("--confirm"));

    reopen();
    expect(run.outcome).toBe("refused");
    expect(fs.existsSync(failed.storagePath)).toBe(true);
    expect(listing(path.join(dir, "originals"))).toEqual(archive);
    expect(run.failures.join("\n")).toMatch(/gone or changed/);
    expect(backups()).toEqual([]);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
  });

  test("the real ledger's re-reads archive into its own statements root — MONEYAPP_ORIGINALS_DIR elsewhere is refused", async () => {
    const own = asTheRealLedger();
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const archive = listing(own);
    bundle.sqlite.close();
    process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "elsewhere");

    const run = main(args("--confirm"), { cwd: dir });

    await expect(run).rejects.toThrow(/MONEYAPP_ORIGINALS_DIR/);
    reopen();
    expect(fs.existsSync(path.join(dir, "elsewhere"))).toBe(false);
    expect(listing(own)).toEqual(archive);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
    expect(backups()).toEqual([]);
  });

  test("a copy of the ledger never archives into a checkout's data/statements — this one's or another's", async () => {
    bundle.sqlite.close();
    process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "main-checkout", "data", "statements");

    await expect(main(args())).rejects.toThrow(/a checkout's archive/);

    expect(fs.existsSync(path.join(dir, "main-checkout"))).toBe(false);
    reopen();
  });

  test("on the real ledger each new read lands on the original its older read names, and the archive is as it was", async () => {
    const own = asTheRealLedger();
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    const older = bundle.db.select().from(importFiles).get()!;
    const archive = listing(own);
    bundle.sqlite.close();

    const run = await main(args("--confirm"), { cwd: dir });

    reopen();
    expect(run.failures).toEqual([]);
    expect(run.outcome).toBe("written");
    const fresh = bundle.db.select().from(importFiles).where(eq(importFiles.parserVersion, 2)).get()!;
    expect(fresh.storagePath).toBe(older.storagePath);
    expect(listing(own)).toEqual(archive);
  });

  test("a new read whose original is named anywhere but where the run archived it is put back", async () => {
    await importedBeforeRecordsThenBumped(statement([COFFEE, GROCER]), statement([COFFEE, GROCER]));
    bundle.sqlite.close();

    const run = await main(args("--confirm"), {
      // the new read names a copy of its original outside the archive the run wrote: same folder, name and bytes
      afterWrite: (real) => {
        const fresh = real.db.select().from(importFiles).where(eq(importFiles.parserVersion, 2)).get()!;
        const elsewhere = path.join(dir, "elsewhere", path.basename(path.dirname(fresh.storagePath)), path.basename(fresh.storagePath));
        fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
        fs.copyFileSync(fresh.storagePath, elsewhere);
        real.db.update(importFiles).set({ storagePath: elsewhere }).where(eq(importFiles.id, fresh.id)).run();
      },
    });

    reopen();
    expect(run.outcome).toBe("restored");
    expect(run.failures.join("\n")).toMatch(/archived at .*elsewhere/);
    expect(fileRows()).toEqual([{ version: 1, status: "parsed" }]);
  });
});
