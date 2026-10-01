/**
 * Reads imported files again, read-only, with the profile and the version that imported them — for a record that
 * only the original bytes say (`import-records`: the three record backfills, and a restore of an older snapshot). A file is skipped, and said, when its bytes are missing or not the imported
 * ones, when its profile is gone or now at another version (its re-read will record for itself), or when the profile
 * cannot read it.
 */
import fs from "node:fs";
import { asc, inArray } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { LIVE_FILE, importFiles } from "@/db/schema/imports";
import { fileSha256 } from "@/lib/hash";
import { PROFILES } from "../profiles";
import { asParsedFile, parseContextFor } from "../service";
import { sniffFile } from "../sniff";
import type { ParsedStatement } from "../types";

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
    .where(inArray(importFiles.status, [...LIVE_FILE]))
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
