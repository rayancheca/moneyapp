import { asc } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { leftOutAcknowledgements } from "@/db/schema/ledger-check";
import type { LeftOutAcknowledgement, LeftOutAcknowledgementWrite } from "@/lib/left-out-acknowledgement";

/** The acknowledgements this ledger holds, the oldest first. */
export function readLeftOutAcknowledgements(db: AppDatabase): LeftOutAcknowledgement[] {
  return db.select().from(leftOutAcknowledgements).orderBy(asc(leftOutAcknowledgements.createdAt), asc(leftOutAcknowledgements.id)).all();
}

/**
 * Records each acknowledgement given — one row each, two lines alike two rows (`acknowledgementWrites`).
 *
 * Nothing given, nothing written — not even an empty transaction, as `writeWitnessMarks`: only
 * `pnpm ledger-check --acknowledge-left-out=<mark> --reason='<…>' --confirm` writes here, and a plan with nothing to
 * write is a no-op.
 *
 * ⛔ One whose reason says nothing refuses them ALL, before anything is written: "an entry without a reason is a check
 * that has been quieted rather than passed" (ledger-check's BASELINE). The command line refuses it first
 * (`ledgerCheckMode`); this is the table's one writer, so it is refused here too, whoever calls.
 */
export function writeLeftOutAcknowledgements(db: AppDatabase, writes: readonly LeftOutAcknowledgementWrite[]): void {
  if (writes.length === 0) return;
  const blank = writes.find((write) => write.reason.trim() === "");
  if (blank !== undefined) {
    throw new Error(
      `refused: an acknowledgement says what the session read on the statement, and the one for ${blank.description} on ` +
        `${blank.printedOn} says nothing — nothing was written`,
    );
  }
  db.transaction((tx) => {
    for (const write of writes) tx.insert(leftOutAcknowledgements).values({ ...write }).run();
  });
}
