import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { balanceAnchors } from "@/db/schema/balances";
import { statementPeriods } from "@/db/schema/imports";
import { addDays } from "@/lib/dates";

/**
 * Which statement each recorded balance cites is part of what the ledger says: the provenance sheet of the day names it.
 * A day two statements print — one closes on it, the next opens the day after — holds ONE anchor, and it cites whichever
 * wrote the day last (`upsertAnchor`). So a re-read at a newer parser version, which renews reads and nothing else, must
 * leave each citation where it was: with the new read of the statement it cited, or with that statement when the re-read
 * does not read it.
 *
 * 🔴 A re-read retires its files' reads — each anchor they cite handed to another printer of the day, or let go
 * (`handOverPrintedAnchors`) — and then writes the new reads, oldest first where the order matters
 * (`oldestFirstWhereItMatters`), each taking every day it prints. On a copy of the real ledger (2026-09-28) the re-read
 * of 33 Robinhood brokerage statements moved 26 month-ends from the statement that closes on them to the next one's
 * opening: same day, same balance, the other statement named — a change ⚖️ his rule for that re-read refuses (§6A 26).
 * A re-read of one month took a day from the next month's statement, which it did not read, the same way.
 */

/** A statement balance as the ledger records it before a re-read: the file it cites, and the side of its period. */
export interface Citation {
  readonly accountId: string;
  readonly day: string;
  readonly importFileId: string;
  /** the period closes on the day, or opens the day after it */
  readonly side: "closes" | "opens";
}

/** Every statement balance and what it cites — read before a re-read retires anything. */
export function citationsBefore(tx: AppDatabase): Citation[] {
  const rows = tx
    .select({
      accountId: balanceAnchors.accountId,
      day: balanceAnchors.anchoredOn,
      importFileId: balanceAnchors.importFileId,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
    })
    .from(balanceAnchors)
    .innerJoin(statementPeriods, eq(statementPeriods.id, balanceAnchors.statementPeriodId))
    .where(and(eq(balanceAnchors.source, "statement"), isNotNull(balanceAnchors.importFileId)))
    .all();
  return rows.flatMap(({ accountId, day, importFileId, periodStart, periodEnd }): Citation[] => {
    const side = periodEnd === day ? "closes" : addDays(periodStart, -1) === day ? "opens" : null;
    return side === null || importFileId === null ? [] : [{ accountId, day, importFileId, side }];
  });
}

/**
 * Once a re-read's new reads are written: each balance cites again the statement it cited — `successorOf` maps a retired
 * read to its new read — wherever that read still prints the day on the same side of a period. The balance, the file and
 * the period move together, as `upsertAnchor` moves them. A day that read no longer prints keeps what the re-read gave
 * it (another printer, or nothing): the re-read changed what is printed, and says so elsewhere.
 */
export function keepCitations(tx: AppDatabase, before: readonly Citation[], successorOf: ReadonlyMap<string, string>): void {
  for (const citation of before) {
    const importFileId = successorOf.get(citation.importFileId) ?? citation.importFileId;
    const period = printingPeriod(tx, citation, importFileId);
    if (period === undefined) continue;
    const at = and(
      eq(balanceAnchors.accountId, citation.accountId),
      eq(balanceAnchors.anchoredOn, citation.day),
      eq(balanceAnchors.source, "statement"),
    );
    const now = tx.select().from(balanceAnchors).where(at).get();
    const balanceCents = citation.side === "closes" ? period.endingBalanceCents : period.beginningBalanceCents;
    if (now === undefined || balanceCents === null) continue;
    if (now.importFileId === importFileId && now.statementPeriodId === period.id && now.balanceCents === balanceCents) continue;
    tx.update(balanceAnchors).set({ balanceCents, importFileId, statementPeriodId: period.id }).where(eq(balanceAnchors.id, now.id)).run();
  }
}

/** The file's printed-balance period on the account that prints the day on the citation's side, if it has one. */
function printingPeriod(tx: AppDatabase, citation: Citation, importFileId: string) {
  return tx
    .select({
      id: statementPeriods.id,
      beginningBalanceCents: statementPeriods.beginningBalanceCents,
      endingBalanceCents: statementPeriods.endingBalanceCents,
    })
    .from(statementPeriods)
    .where(
      and(
        eq(statementPeriods.importFileId, importFileId),
        eq(statementPeriods.accountId, citation.accountId),
        isNotNull(statementPeriods.beginningBalanceCents),
        isNotNull(statementPeriods.endingBalanceCents),
        citation.side === "closes"
          ? eq(statementPeriods.periodEnd, citation.day)
          : sql`date(${statementPeriods.periodStart}, '-1 day') = ${citation.day}`,
      ),
    )
    .orderBy(statementPeriods.id)
    .get();
}
