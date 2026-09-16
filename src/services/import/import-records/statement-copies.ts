import { and, eq } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { statementCopies, statementPeriods } from "@/db/schema/imports";
import type { DuplicatePairSide } from "@/lib/hash";
import { findAccountId, statementCopyLines, storedLines } from "../service";
import { recordStatementCopy } from "../statement-copies";
import { rereadImported } from "./reread";

/**
 * The statements each file prints as a second download (`statement_copies`), read from the files themselves —
 * scripts/record-statement-copies.ts says why, and `recordImportedFiles` when.
 */

export interface PlannedCopy {
  importFileId: string;
  fileName: string;
  accountId: string;
  accountName: string;
  periodStart: string;
  periodEnd: string;
  ownerFileId: string;
  lines: DuplicatePairSide[];
}

export interface CopyScan {
  planned: PlannedCopy[];
  alreadyRecorded: number;
  skipped: string[];
  read: number;
}

/** Reads each file again with the profile and version that imported it, and names the periods it prints as a copy. */
export async function scanCopies(bundle: DbBundle, offset: number, limit: number): Promise<CopyScan> {
  const { db } = bundle;
  const { reads, skipped } = await rereadImported(bundle, offset, limit);
  const scan: CopyScan = { planned: [], alreadyRecorded: 0, skipped, read: reads.length };
  for (const { file, statements } of reads) {
    const skip = (why: string) => scan.skipped.push(`${file.fileName} (${file.id}): ${why}`);
    const owned = new Set(
      db
        .select({ accountId: statementPeriods.accountId })
        .from(statementPeriods)
        .where(eq(statementPeriods.importFileId, file.id))
        .all()
        .map((p) => p.accountId),
    );
    for (const statement of statements) {
      const { period } = statement;
      if (!period) continue;
      const accountId = findAccountId(db, statement.accountHint);
      if (accountId === null) {
        skip(`no account for ${statement.accountHint.institution} ····${statement.accountHint.last4 ?? "?"}`);
        continue;
      }
      if (owned.has(accountId)) continue;
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
      const held = db
        .select()
        .from(statementPeriods)
        .where(
          and(
            eq(statementPeriods.accountId, accountId),
            eq(statementPeriods.periodStart, period.start),
            eq(statementPeriods.periodEnd, period.end),
          ),
        )
        .get();
      if (!held) {
        skip(`${account.name} ${period.start} → ${period.end}: no statement period holds it`);
        continue;
      }
      const lines = statementCopyLines(storedLines(accountId, account, statement));
      const recorded = db
        .select()
        .from(statementCopies)
        .where(and(eq(statementCopies.importFileId, file.id), eq(statementCopies.accountId, accountId)))
        .get();
      if (
        recorded &&
        recorded.periodStart === period.start &&
        recorded.periodEnd === period.end &&
        recorded.lines === JSON.stringify(lines)
      ) {
        scan.alreadyRecorded += 1;
        continue;
      }
      scan.planned.push({
        importFileId: file.id,
        fileName: file.fileName,
        accountId,
        accountName: account.name,
        periodStart: period.start,
        periodEnd: period.end,
        ownerFileId: held.importFileId,
        lines,
      });
    }
  }
  return scan;
}

export function writeCopies(bundle: DbBundle, planned: readonly PlannedCopy[]): void {
  bundle.db.transaction((tx) => {
    for (const copy of planned) {
      recordStatementCopy(tx, {
        importFileId: copy.importFileId,
        accountId: copy.accountId,
        periodStart: copy.periodStart,
        periodEnd: copy.periodEnd,
        lines: copy.lines,
      });
    }
  });
}
