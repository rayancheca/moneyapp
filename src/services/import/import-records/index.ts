import { inArray, sql } from "drizzle-orm";
import type { AppDatabase, DbBundle } from "@/db/client";
import { LIVE_FILE, importFiles } from "@/db/schema/imports";
import { PROFILES } from "../profiles";
import { scanNumbers, writeNumbers } from "./account-numbers";
import { scanPrintedLines, writePrintedLines } from "./printed-lines";
import { scanCopies, writeCopies } from "./statement-copies";

/**
 * The three records an import keeps of what a file prints — the numbers a card's statements carried
 * (`account_numbers`), the statements a file prints as a second download (`statement_copies`), and every line it
 * prints (`printed_lines`) — for a ledger that has the files and not the records.
 *
 * 🔴 The records are written by the import, and for files imported before it wrote them, by three one-time backfills
 * (scripts/record-*.ts). A migration only creates the tables, so restoring any snapshot taken before the backfills —
 * every one of the 104 in data/backups on 2026-09-16 — emptied all three, and nothing noticed: the next un-import of the
 * first of several downloads deleted the rows and the period the others print, and re-importing a pre-reissue Venture
 * X statement created a second account. Measured on a copy of the real ledger (the review of uc/final-integrate):
 * un-importing 20230810-statements-3522-.pdf after such a restore took Chase Checking from 2,650 rows to 2,565
 * (−$1,636.84), 48 periods to 47, and 0 gap days to 27; `pnpm ledger-check` exited 0.
 */

export interface UnrecordedFile {
  id: string;
  fileName: string;
  /**
   * Whether the three backfills can still read it. They read a file only at the version that imported it
   * (`reread.ts`), and a profile carries ONE implementation — its current one — so a file read at an older version is
   * beyond them: what it prints is recorded by a re-read of the file itself, at the version the profile has now, and
   * by nothing else (`scripts/reread-unrecorded-files.ts`). Re-reading it at today's version and calling that a record
   * of what it printed would be a record of lines the file never printed here.
   */
  backfillCanRead: boolean;
}

/**
 * Parsed files with no record of what they print, each saying whether a backfill can still read it. The import records
 * every statement it reads — a file whose every line another row absorbed included, which is the file an un-import
 * must not forget — so on a ledger whose records are whole this is empty. Left out: a file that wrote nothing and
 * withheld a section (it may have read no statement at all).
 *
 * 🔴 This named only files at their profile's CURRENT version, so a file the profile had moved past was not named at
 * all — and the backfills skip it too, which is the pair that made the silence: no record, no way to make one, and
 * nothing said. On a copy of the real ledger, 2026-09-22, 34 live files sat there (the Discover CSV at v1, 30
 * Robinhood brokerage statements at v3 and 3 at v4, against profiles at v2 and v5) while `pnpm ledger-check` printed
 * 0 and exited 0. Un-importing any file whose rows one of those 34 also prints loses them, because the hand-over
 * (`printerHandOvers`) knows a printer only by its record. Measured with the backfills applied, 2026-09-16: 238
 * current files recorded, none missing; before the backfills, 238 missing.
 */
export function filesWithoutPrintedLines(db: AppDatabase): UnrecordedFile[] {
  const current = new Map(PROFILES.map((p) => [p.id, p.version] as const));
  return db
    .select({ id: importFiles.id, fileName: importFiles.fileName, profile: importFiles.parserProfile, version: importFiles.parserVersion })
    .from(importFiles)
    .where(
      sql`${inArray(importFiles.status, [...LIVE_FILE])}
        AND NOT EXISTS (SELECT 1 FROM printed_lines l WHERE l.import_file_id = ${importFiles.id})
        AND (${importFiles.error} IS NULL
          OR EXISTS (SELECT 1 FROM transactions t WHERE t.import_file_id = ${importFiles.id})
          OR EXISTS (SELECT 1 FROM statement_periods p WHERE p.import_file_id = ${importFiles.id})
          OR EXISTS (SELECT 1 FROM balance_anchors a WHERE a.import_file_id = ${importFiles.id})
          OR EXISTS (SELECT 1 FROM statement_copies c WHERE c.import_file_id = ${importFiles.id}))`,
    )
    .orderBy(importFiles.importedAt, importFiles.id)
    .all()
    .map(({ id, fileName, profile, version }) => ({
      id,
      fileName,
      backfillCanRead: profile !== null && current.get(profile) === version,
    }));
}

export interface RecordedFiles {
  numbers: number;
  copies: number;
  printedLines: number;
  /** what could not be recorded, and why — the backfills print the same */
  skipped: string[];
}

/**
 * Records, insert-only, what the files in the ledger print and no record says yet — in the backfills' order: the card
 * numbers first (a pre-reissue statement resolves to its account through them), then the copies, then the lines. What a
 * record already says is left as it is. Nothing but the three record tables is written.
 */
export async function recordImportedFiles(bundle: DbBundle): Promise<RecordedFiles> {
  const all = Number.MAX_SAFE_INTEGER;
  const numbers = await scanNumbers(bundle, 0, all);
  writeNumbers(bundle, numbers.planned);
  const copies = await scanCopies(bundle, 0, all);
  writeCopies(bundle, copies.planned);
  const lines = await scanPrintedLines(bundle, 0, all);
  writePrintedLines(bundle, lines.planned);
  return {
    numbers: numbers.planned.length,
    copies: copies.planned.length,
    printedLines: lines.planned.length,
    skipped: [...new Set([...numbers.skipped, ...copies.skipped, ...lines.skipped])],
  };
}
