/**
 * Reads imported files again, read-only, with the profile and the version that imported them — for a script that
 * must record something only the original bytes say (scripts/record-statement-copies.ts,
 * scripts/record-account-numbers.ts). A file is skipped, and said, when its bytes are missing or not the imported
 * ones, when its profile is gone or now at another version (its re-read will record for itself), or when the profile
 * cannot read it.
 */
import fs from "node:fs";
import { asc, inArray } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { importFiles } from "@/db/schema/imports";
import { fileSha256 } from "@/lib/hash";
import { PROFILES } from "@/services/import/profiles";
import { asParsedFile, parseContextFor } from "@/services/import/service";
import { sniffFile } from "@/services/import/sniff";
import type { ParsedStatement } from "@/services/import/types";

export interface ReadAgain {
  file: typeof importFiles.$inferSelect;
  statements: ParsedStatement[];
}

export interface RereadResult {
  reads: ReadAgain[];
  skipped: string[];
}

/** The parsed files in import order, `offset`/`limit` of them, each read again. */
export async function rereadImported(bundle: DbBundle, offset: number, limit: number): Promise<RereadResult> {
  const { db } = bundle;
  const files = db
    .select()
    .from(importFiles)
    .where(inArray(importFiles.status, ["parsed", "parsed_with_claude"]))
    .orderBy(asc(importFiles.importedAt), asc(importFiles.id))
    .all()
    .slice(offset, offset + limit);
  const result: RereadResult = { reads: [], skipped: [] };
  const context = parseContextFor(db);
  for (const file of files) {
    const skip = (why: string) => result.skipped.push(`${file.fileName} (${file.id}): ${why}`);
    const profile = PROFILES.find((p) => p.id === file.parserProfile);
    if (profile === undefined) {
      skip(`no profile ${file.parserProfile}`);
      continue;
    }
    if (profile.version !== file.parserVersion) {
      skip(`imported at ${profile.id} v${file.parserVersion}, the profile is v${profile.version} — its re-read records it`);
      continue;
    }
    if (!fs.existsSync(file.storagePath)) {
      skip(`no original at ${file.storagePath}`);
      continue;
    }
    const buffer = fs.readFileSync(file.storagePath);
    if (fileSha256(buffer) !== file.fileSha256) {
      skip(`${file.storagePath} is not the imported bytes`);
      continue;
    }
    try {
      const { statements } = asParsedFile(await profile.parse(sniffFile(file.fileName, buffer), context));
      result.reads.push({ file, statements });
    } catch (error: unknown) {
      skip(`the profile cannot read it now: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** `--name=<whole number>`, or `fallback` when absent. */
export function wholeNumberFlag(argv: readonly string[], name: string, fallback: number): number {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} must be a whole number, got ${raw}`);
  return n;
}

/** Every table a record-only write must leave alone, hashed row by row. */
export const LEDGER_TABLES = [
  "transactions",
  "statement_periods",
  "balance_anchors",
  "daily_balances",
  "import_files",
  "accounts",
  "transaction_splits",
  "duplicate_candidates",
] as const;
