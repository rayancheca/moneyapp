import { and, eq, inArray } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { printedLines } from "@/db/schema/imports";
import { LIVE_ROW, transactions } from "@/db/schema/transactions";
import { appendPrintedLines, printedLineOf, type PrintedLine } from "../printed-lines";
import { findAccountId, storedLines } from "../service";
import { rereadImported } from "./reread";

/**
 * What each file prints (`printed_lines`), read from the files themselves — scripts/record-printed-lines.ts says why,
 * and `recordImportedFiles` when.
 */

export interface PlannedLines {
  importFileId: string;
  fileName: string;
  accountId: string;
  accountName: string;
  lines: PrintedLine[];
  /** how many of the lines some live row on the account records by money and day */
  recordedByARow: number;
}

export interface LinesScan {
  planned: PlannedLines[];
  alreadyRecorded: number;
  skipped: string[];
  read: number;
}

/** Whether a live row on the account has the line's money on one of its days. */
function rowRecords(db: DbBundle["db"], accountId: string): (line: PrintedLine) => boolean {
  const keys = new Set<string>();
  for (const r of db
    .select({ postedOn: transactions.postedOn, transactedOn: transactions.transactedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), inArray(transactions.status, [...LIVE_ROW])))
    .all()) {
    keys.add(`${r.amountCents}|${r.postedOn}`);
    if (r.transactedOn !== null) keys.add(`${r.amountCents}|${r.transactedOn}`);
  }
  return (line) =>
    [line.printedOn, line.postedOn, line.transactedOn].some((day) => day !== null && keys.has(`${line.amountCents}|${day}`));
}

/** Reads each file again with the profile and version that imported it, and names the lines it prints on each account. */
export async function scanPrintedLines(bundle: DbBundle, offset: number, limit: number): Promise<LinesScan> {
  const { db } = bundle;
  const { reads, skipped } = await rereadImported(bundle, offset, limit);
  const scan: LinesScan = { planned: [], alreadyRecorded: 0, skipped, read: reads.length };
  const records = new Map<string, (line: PrintedLine) => boolean>();
  for (const { file, statements } of reads) {
    const byAccount = new Map<string, PrintedLine[]>();
    for (const statement of statements) {
      const accountId = findAccountId(db, statement.accountHint);
      if (accountId === null) {
        scan.skipped.push(`${file.fileName} (${file.id}): no account for ${statement.accountHint.institution} ····${statement.accountHint.last4 ?? "?"}`);
        continue;
      }
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
      const lines = storedLines(accountId, account, statement).map(({ printed, stored }) => printedLineOf(printed, stored));
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), ...lines]);
    }
    for (const [accountId, lines] of byAccount) {
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
      const recorded = db
        .select()
        .from(printedLines)
        .where(and(eq(printedLines.importFileId, file.id), eq(printedLines.accountId, accountId)))
        .get();
      if (recorded?.lines === JSON.stringify(lines)) {
        scan.alreadyRecorded += 1;
        continue;
      }
      if (recorded !== undefined) {
        scan.skipped.push(`${file.fileName} (${file.id}) / ${account.name}: recorded already, with other lines`);
        continue;
      }
      if (!records.has(accountId)) records.set(accountId, rowRecords(db, accountId));
      const recordedByARow = lines.filter(records.get(accountId)!).length;
      if (lines.length > 0 && recordedByARow === 0) {
        scan.skipped.push(`${file.fileName} (${file.id}) / ${account.name}: no row on the account records any of its ${lines.length} lines`);
        continue;
      }
      scan.planned.push({ importFileId: file.id, fileName: file.fileName, accountId, accountName: account.name, lines, recordedByARow });
    }
  }
  return scan;
}

export function writePrintedLines(bundle: DbBundle, planned: readonly PlannedLines[]): void {
  bundle.db.transaction((tx) => {
    for (const p of planned) appendPrintedLines(tx, p.importFileId, p.accountId, p.lines);
  });
}
