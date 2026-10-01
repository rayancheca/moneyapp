import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles } from "@/db/schema/imports";
import { fileSha256 } from "@/lib/hash";
import { PROFILES } from "./profiles";
import { importStatementFiles, type ImportInput } from "./service";
import { ParseError, type ParsedStatement, type ParserProfile } from "./types";

/**
 * 🔴 A trial (`pnpm trial-import`) and a `--db=<copy>` rehearsal import into a COPY of the ledger and archive into an
 * archive of their own — .trial/originals, or the copy's originals/ beside it. The copy inherits the ledger's rows, and
 * a read that failed at the profile's current version is one the import takes up again (`openMember`,
 * `REIMPORTABLE_STATUSES`). `recordFile` kept that row's `storage_path`, which names the REAL archive's original, and
 * `relocateArchive` MOVED it into the copy's archive — or deleted it, where that archive held the bytes already from an
 * earlier rehearsal. The real ledger's row then named a file that was not there, and the next trial wiped the moved one
 * (the review of uc/import-refuses-archive, 2026-10-01).
 *
 * A read fails at the current version when the parse throws, when the account a statement needs is not on the ledger
 * yet — the rehearsal creates it on the copy first (scripts/trial-import.ts `--from`) — or when the read is refused. A
 * profile that throws until it is told otherwise stands in for all of them.
 */

const PREFIX = "rehearsal-archive-";
const STATEMENT: ImportInput = { name: `${PREFIX}2026-03.txt`, buffer: Buffer.from("March, in full") };
const SECTION: ParsedStatement = {
  accountHint: { institution: "Chase", type: "checking", last4: "5150" },
  txns: [{ postedOn: "2026-03-10", amountCents: -2500, rawDescription: "REHEARSAL ARCHIVE CHARGE" }],
  period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10000, endCents: 7500 },
};

let unreadable = false;
const profile: ParserProfile = {
  id: "test-rehearsal-archive",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: () => {
    if (unreadable) throw new ParseError("test-rehearsal-archive", "the account this statement needs is not on the ledger yet");
    return [SECTION];
  },
};

let dir: string;
/** the real ledger, and the archive it writes: data/statements */
let ledger: DbBundle;
let realArchive: string;
/** a rehearsal's archive: .trial/originals, or the copy's originals/ */
let rehearsalArchive: string;
const opened: DbBundle[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rehearsal-archive-"));
  realArchive = path.join(dir, "data", "statements");
  rehearsalArchive = path.join(dir, ".trial", "originals");
  ledger = createDatabase(path.join(dir, "moneyapp.db"));
  seedDatabase(ledger.db);
  unreadable = false;
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  for (const bundle of [ledger, ...opened.splice(0)]) bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

/** An import into `bundle`, archiving where its own run would: the env var is how both commands move the archive. */
async function importInto(bundle: DbBundle, archive: string, input: ImportInput = STATEMENT) {
  process.env.MONEYAPP_ORIGINALS_DIR = archive;
  const [outcome] = await importStatementFiles(bundle.db, [input]);
  return outcome!;
}

/** A copy of the ledger as it stands — what a trial or a rehearsal imports into. */
async function copyOfLedger(name: string): Promise<DbBundle> {
  const copy = path.join(dir, `${name}.db`);
  await ledger.sqlite.backup(copy);
  const bundle = createDatabase(copy);
  opened.push(bundle);
  return bundle;
}

const rowOf = (bundle: DbBundle) =>
  bundle.db.select().from(importFiles).where(eq(importFiles.fileSha256, fileSha256(STATEMENT.buffer))).get()!;

/** Every file under `root`, by path, with its sha256. */
function listing(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fileSha256(fs.readFileSync(full));
    }
  };
  walk(root);
  return out;
}

const inside = (p: string, root: string): boolean => !path.relative(root, p).startsWith("..");

/** The ledger's read of STATEMENT failed at the current version; its original is archived in the real archive. */
async function ledgerWithAFailedRead(): Promise<string> {
  unreadable = true;
  expect((await importInto(ledger, realArchive)).status).toBe("failed");
  unreadable = false;
  const original = rowOf(ledger).storagePath;
  expect(inside(original, realArchive)).toBe(true);
  expect(fs.readFileSync(original)).toEqual(STATEMENT.buffer);
  return original;
}

describe("a rehearsal takes up a failed read into its own archive — the real archive's original stays where it is", () => {
  test("a trial of the same bytes on a copy: the original is not moved out of the real archive", async () => {
    const original = await ledgerWithAFailedRead();
    const archived = listing(realArchive);
    const trial = await copyOfLedger("trial");

    expect((await importInto(trial, rehearsalArchive)).status).toBe("parsed");

    // the damage first: what the real ledger's row names is still there, and the real archive is as it was
    expect(fs.existsSync(original)).toBe(true);
    expect(listing(realArchive)).toEqual(archived);
    expect(rowOf(ledger).storagePath).toBe(original);
    // the copy's row names the copy's own original, in its own archive
    const copied = rowOf(trial).storagePath;
    expect(inside(copied, rehearsalArchive)).toBe(true);
    expect(fs.readFileSync(copied)).toEqual(STATEMENT.buffer);
    expect(Object.keys(listing(rehearsalArchive))).toEqual([path.relative(rehearsalArchive, copied)]);
  });

  test("a repeat rehearsal, whose archive holds the bytes already, deletes nothing from the real archive", async () => {
    // the first rehearsal ran before the real import: it archived the bytes into its own archive, as a new read
    const first = await copyOfLedger("first");
    expect((await importInto(first, rehearsalArchive)).status).toBe("parsed");
    expect(Object.keys(listing(rehearsalArchive))).toHaveLength(1);
    // …then the real import failed (the account it needs was made on the copy only), and the rehearsal is run again
    const original = await ledgerWithAFailedRead();
    const archived = listing(realArchive);
    const again = await copyOfLedger("again");

    expect((await importInto(again, rehearsalArchive)).status).toBe("parsed");

    expect(fs.existsSync(original)).toBe(true);
    expect(listing(realArchive)).toEqual(archived);
    const copied = rowOf(again).storagePath;
    expect(inside(copied, rehearsalArchive)).toBe(true);
    expect(fs.readFileSync(copied)).toEqual(STATEMENT.buffer);
  });

  test("the ledger's own re-read, under another name, moves its original into the account's folder: one file, its row's", async () => {
    await ledgerWithAFailedRead();
    // a second download of the same bytes: the browser named it apart
    const renamed: ImportInput = { name: `${PREFIX}2026-03 (1).txt`, buffer: STATEMENT.buffer };

    expect((await importInto(ledger, realArchive, renamed)).status).toBe("parsed");

    const named = rowOf(ledger).storagePath;
    expect(fs.readFileSync(named)).toEqual(STATEMENT.buffer);
    // the original the failed read archived was moved, not left behind beside a second copy
    expect(Object.keys(listing(realArchive))).toEqual([path.relative(realArchive, named)]);
  });
});
