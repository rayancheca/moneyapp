import type { AppDatabase } from "@/db/client";
import { ledgerWitnessMarks } from "@/db/schema/ledger-check";
import { WITNESS_KINDS, marksFromRows, type WitnessMarks } from "@/lib/witness-floor";

/** The marks this ledger holds. Throws on a row it cannot read — see `marksFromRows`. */
export function readWitnessMarks(db: AppDatabase): WitnessMarks {
  return marksFromRows(db.select().from(ledgerWitnessMarks).all());
}

/**
 * Stores each given kind's mark, replacing that kind's row and no other.
 *
 * Nothing given, nothing written — not even an empty transaction: this runs on
 * the pre-commit hook against the owner's ledger, and a steady ledger should
 * see no write from it at all.
 */
export function writeWitnessMarks(db: AppDatabase, writes: WitnessMarks): void {
  const rows = WITNESS_KINDS.flatMap((kind) => {
    const mark = writes[kind];
    return mark === undefined
      ? []
      : [
          {
            kind,
            mark: mark.count,
            witnesses: mark.witnesses.map((w) => [...w]),
            accountNames: { ...mark.accountNames },
          },
        ];
  });
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(ledgerWitnessMarks)
        .values(row)
        .onConflictDoUpdate({
          target: ledgerWitnessMarks.kind,
          set: {
            mark: row.mark,
            witnesses: row.witnesses,
            accountNames: row.accountNames,
            updatedAt: new Date().toISOString(),
          },
        })
        .run();
    }
  });
}
