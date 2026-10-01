import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The /imports upload against a real (temporary) database and archive.
 *
 * 🔴 The upload hands the import each file under the name the browser gives it. A statement picked from the archive —
 * data/statements/<account>/, where every original is kept as `<sha>-<name>` — was read as an original: recorded under
 * that sha-prefixed name and archived again as `<sha>-<sha>-<name>`, and an archived activity CSV, which no profile
 * matches by that name, became a FAILED row on /imports. The commands refuse such a file (scripts/statement-folders.ts);
 * the upload took it (the review of uc/import-refuses-archive, 2026-10-01).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-imports-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
// the upload ARCHIVES what it reads — into this temp dir, never the owner's data/statements
const ARCHIVE = path.join(dir, "originals");
process.env.MONEYAPP_ORIGINALS_DIR = ARCHIVE;
// the connection is cached on globalThis — drop any inherited handle so this file can never write another file's (or
// the owner's real) database
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDb, getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { importFiles } = await import("@/db/schema/imports");
const { fileSha256 } = await import("@/lib/hash");
const { archivedName } = await import("@/services/import/service");
const { uploadStatementsAction, uploadStatementsResultAction } = await import("./actions");

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "synthetic", "chase", "Chase1111_Activity_2026-07-01_2026-07-05.CSV");
const ORIGINAL = path.basename(FIXTURE);
const bytes = (): Buffer => fs.readFileSync(FIXTURE);
const ARCHIVED = archivedName(fileSha256(fs.readFileSync(FIXTURE)), ORIGINAL);

beforeAll(() => {
  seedDatabase(getDbBundle().db);
});

// one ledger for the file, in declaration order: the refusals first, while nothing is recorded or archived
afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

function upload(...files: { name: string; buffer: Buffer }[]): FormData {
  const form = new FormData();
  for (const f of files) form.append("files", new File([new Uint8Array(f.buffer)], f.name));
  return form;
}

/** Every file in the archive, by path — a refused upload must leave it exactly as it was. */
function archived(): string[] {
  if (!fs.existsSync(ARCHIVE)) return [];
  return fs.readdirSync(ARCHIVE, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
}

describe("uploadStatementsResultAction — a statement picked from the archive is its copy, not an original", () => {
  test("⛔ refused with the whole upload: nothing recorded, nothing archived, and it says which file and what to upload", async () => {
    const other = { name: "Chase1111_Activity_2026-07-06_2026-07-10.CSV", buffer: Buffer.from("not read") };

    const result = await uploadStatementsResultAction(upload(other, { name: ARCHIVED, buffer: bytes() }));

    // the damage first: no row under the sha-prefixed name, no <sha>-<sha>- copy in the archive
    expect(getDb().select({ name: importFiles.fileName }).from(importFiles).all()).toEqual([]);
    expect(archived()).toEqual([]);
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain(`${ARCHIVED} is the statement archive's copy of ${ORIGINAL}`);
    expect(error).toContain("Nothing was imported");
    expect(error).toContain(`upload ${ORIGINAL}`);
  });

  test("the form's own action shows the refusal on /imports", async () => {
    await expect(uploadStatementsAction(upload({ name: ARCHIVED, buffer: bytes() }))).rejects.toThrow(
      `NEXT_REDIRECT:/imports?error=${encodeURIComponent(`${ARCHIVED} is the statement archive's copy of ${ORIGINAL}`)}`,
    );
  });

  test("the original, under the name it was downloaded with, is imported", async () => {
    const result = await uploadStatementsResultAction(upload({ name: ORIGINAL, buffer: bytes() }));

    expect(result.ok && result.data.outcomes.map((o) => [o.fileName, o.status])).toEqual([[ORIGINAL, "parsed"]]);
    expect(archived()).toEqual([ARCHIVED]);
  });

  test("the name is checked against the file's OWN bytes: another file's sixteen hex and a dash is no copy", async () => {
    const lookalike = `${"0".repeat(16)}-${ORIGINAL}`;

    const result = await uploadStatementsResultAction(upload({ name: lookalike, buffer: bytes() }));

    expect(result.ok && result.data.outcomes.map((o) => o.fileName)).toEqual([lookalike]);
  });
});
