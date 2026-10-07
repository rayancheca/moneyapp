import { asc, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { importFiles, type ImportStatus } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { banksReadByEvery } from "./service";

/**
 * A read whose accounts are at two banks (`banksReadBy`, asked of every read at once: `banksReadByEvery`).
 * `import_files.institution_id` holds one bank, so the import cannot record the bank it resolved (`institutionReadBy` is
 * null) and the importer's guess from the file's name and first lines (`guessInstitution`) stands — Chase, for a file
 * that names none.
 *
 * 🔴 It stood silently: nothing compared it with the accounts, and the column states it as the read's bank. No such read
 * is on his ledger (2026-10-07); `pnpm ledger-check` names one if it arrives, and never picks a bank for it.
 */
export interface ReadAcrossBanks {
  readonly id: string;
  readonly fileName: string;
  readonly status: ImportStatus;
  /** the banks of its accounts, by name, alphabetical */
  readonly banks: readonly string[];
  /** the bank `import_files.institution_id` names — the importer's guess */
  readonly recorded: string;
}

/** Every read, of any status, whose accounts are at two banks or more — in the order the reads were recorded. */
export function readsAcrossBanks(db: AppDatabase): ReadAcrossBanks[] {
  const reads = db
    .select({ id: importFiles.id, fileName: importFiles.fileName, status: importFiles.status, institutionId: importFiles.institutionId })
    .from(importFiles)
    .orderBy(asc(importFiles.importedAt), asc(importFiles.id))
    .all();
  const banksOf = banksReadByEvery(db);
  const found = reads.map((read) => ({ read, banks: banksOf.get(read.id) ?? [] })).filter(({ banks }) => banks.length > 1);
  if (found.length === 0) return [];
  const ids = [...new Set(found.flatMap(({ read, banks }) => [read.institutionId, ...banks]))];
  const nameOf = new Map(
    db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions)
      .where(inArray(institutions.id, ids))
      .all()
      .map((i) => [i.id, i.name] as const),
  );
  const named = (id: string) => nameOf.get(id) ?? id;
  return found.map(({ read, banks }) => ({
    id: read.id,
    fileName: read.fileName,
    status: read.status,
    banks: banks.map(named).sort((a, b) => a.localeCompare(b)),
    recorded: named(read.institutionId),
  }));
}

const listed = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** What `pnpm ledger-check` says of one: its file, its banks, and that the bank it records is the guess. */
export function readAcrossBanksNotice(read: Pick<ReadAcrossBanks, "fileName" | "status" | "banks" | "recorded">): string {
  const retired = read.status === "superseded" ? " (retired)" : "";
  return (
    `${read.fileName}${retired} reads accounts at ${listed(read.banks)} — ` +
    `one column names one bank, so the ${read.recorded} it records is the importer's guess`
  );
}
