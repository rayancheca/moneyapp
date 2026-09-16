import { and, eq } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { accountNumbers } from "@/db/schema/account-numbers";
import { accounts } from "@/db/schema/accounts";
import { statementCopies, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recordFormerNumber } from "../account-numbers";
import type { AccountHint } from "../types";
import { rereadImported } from "./reread";

/**
 * The card numbers an account's filed statements print besides its current one (`account_numbers`), read from the
 * statements themselves — scripts/record-account-numbers.ts says why, and `recordImportedFiles` when.
 */

export interface PlannedNumber {
  accountId: string;
  accountName: string;
  currentLast4: string;
  last4: string;
  /** the statements that print it, with the hint each carries */
  evidence: { fileName: string; period: string; hint: AccountHint }[];
}

export interface NumberScan {
  planned: PlannedNumber[];
  alreadyRecorded: number;
  skipped: string[];
  read: number;
}

/** The account holding a file's statement for these dates: the file's own period, or the one it prints as a copy. */
function holderOf(bundle: DbBundle, fileId: string, start: string, end: string): string[] {
  const { db } = bundle;
  const own = db
    .select({ accountId: statementPeriods.accountId })
    .from(statementPeriods)
    .where(and(eq(statementPeriods.importFileId, fileId), eq(statementPeriods.periodStart, start), eq(statementPeriods.periodEnd, end)))
    .all();
  const copied = db
    .select({ accountId: statementCopies.accountId })
    .from(statementCopies)
    .where(and(eq(statementCopies.importFileId, fileId), eq(statementCopies.periodStart, start), eq(statementCopies.periodEnd, end)))
    .all();
  return [...new Set([...own, ...copied].map((r) => r.accountId))];
}

export async function scanNumbers(bundle: DbBundle, offset: number, limit: number): Promise<NumberScan> {
  const { db } = bundle;
  const { reads, skipped } = await rereadImported(bundle, offset, limit);
  const scan: NumberScan = { planned: [], alreadyRecorded: 0, skipped, read: reads.length };
  const byKey = new Map<string, PlannedNumber>();
  for (const { file, statements } of reads) {
    for (const statement of statements) {
      const { period, accountHint: hint } = statement;
      if (!period || hint.last4 === undefined) continue;
      const holders = holderOf(bundle, file.id, period.start, period.end);
      if (holders.length !== 1) continue;
      const account = db
        .select({ id: accounts.id, name: accounts.name, last4: accounts.last4, institution: institutions.name })
        .from(accounts)
        .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
        .where(eq(accounts.id, holders[0]!))
        .get()!;
      if (account.last4 === null || account.last4 === hint.last4 || account.institution !== hint.institution) continue;
      const where = `${file.fileName} (${file.id}) prints ····${hint.last4} for ${account.name} ····${account.last4}`;
      const rival = db
        .select({ name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.institutionId, db.select({ id: institutions.id }).from(institutions).where(eq(institutions.name, hint.institution))), eq(accounts.last4, hint.last4)))
        .get();
      if (rival) {
        scan.skipped.push(`${where}: ${rival.name} carries that number`);
        continue;
      }
      const recorded = db
        .select()
        .from(accountNumbers)
        .where(and(eq(accountNumbers.accountId, account.id), eq(accountNumbers.last4, hint.last4)))
        .get();
      if (recorded) {
        scan.alreadyRecorded += 1;
        continue;
      }
      const key = `${account.id}\x1f${hint.last4}`;
      const planned = byKey.get(key) ?? { accountId: account.id, accountName: account.name, currentLast4: account.last4, last4: hint.last4, evidence: [] };
      planned.evidence.push({ fileName: file.fileName, period: `${period.start} → ${period.end}`, hint });
      byKey.set(key, planned);
    }
  }
  // a number two accounts would take is nobody's
  const takers = new Map<string, string[]>();
  for (const p of byKey.values()) takers.set(p.last4, [...(takers.get(p.last4) ?? []), p.accountName]);
  for (const p of byKey.values()) {
    const names = takers.get(p.last4)!;
    if (names.length > 1) scan.skipped.push(`····${p.last4} is printed by statements of ${names.join(" and ")} — recorded for neither`);
    else scan.planned.push(p);
  }
  return scan;
}

export function writeNumbers(bundle: DbBundle, planned: readonly PlannedNumber[]): void {
  bundle.db.transaction((tx) => {
    for (const p of planned) recordFormerNumber(tx, p.accountId, p.last4);
  });
}
