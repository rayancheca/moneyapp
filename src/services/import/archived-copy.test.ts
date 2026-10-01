import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { fileSha256 } from "@/lib/hash";
import { archivedName, importStatementFiles, originalOfArchivedCopy } from "./service";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "synthetic", "chase", "Chase1111_Activity_2026-07-01_2026-07-05.CSV");
const ORIGINAL = path.basename(FIXTURE);
const bytes = fs.readFileSync(FIXTURE);
const sha = fileSha256(bytes);

describe("originalOfArchivedCopy — the original a file is the archive's copy of", () => {
  test("named as the archive names its original, after its own bytes: the name it had", () => {
    expect(originalOfArchivedCopy({ name: archivedName(sha, ORIGINAL), buffer: bytes })).toBe(ORIGINAL);
  });

  test("the archive's copy of a file once imported under the archive's name, <sha>-<sha>-<name>: the name before both", () => {
    // 33 Robinhood statements on the real ledger were recorded that way (2026-08-28), and archived so
    expect(originalOfArchivedCopy({ name: archivedName(sha, archivedName(sha, ORIGINAL)), buffer: bytes })).toBe(ORIGINAL);
  });

  test("an original, another file's sixteen hex, and its own sha anywhere but the front are no copy", () => {
    expect(originalOfArchivedCopy({ name: ORIGINAL, buffer: bytes })).toBeUndefined();
    expect(originalOfArchivedCopy({ name: `${"0".repeat(16)}-${ORIGINAL}`, buffer: bytes })).toBeUndefined();
    expect(originalOfArchivedCopy({ name: `copy of ${archivedName(sha, ORIGINAL)}`, buffer: bytes })).toBeUndefined();
  });
});

describe("the import itself reads a file under such a name", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-archived-copy-"));
    process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MONEYAPP_ORIGINALS_DIR;
  });

  /**
   * ⛔ The rule is kept where files come IN (the commands' folders, the /imports upload), not in the import: a re-read
   * hands it the name a file was recorded under, and scripts/reread-unrecorded-files.ts re-reads the 33 statements the
   * real ledger recorded under the archive's name by that name. Refused here, that write would refuse 33 of its 34.
   */
  test("a re-read hands it the name the file was recorded under — the archive's, for 33 on the real ledger", async () => {
    const [outcome] = await importStatementFiles(bundle.db, [{ name: archivedName(sha, ORIGINAL), buffer: bytes }]);

    expect(outcome).toMatchObject({ fileName: archivedName(sha, ORIGINAL), status: "parsed" });
  });
});
