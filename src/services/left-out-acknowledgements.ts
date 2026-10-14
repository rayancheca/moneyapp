import { asc } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { leftOutAcknowledgements } from "@/db/schema/ledger-check";
import {
  reasonCarriesControl,
  reasonSaysNothing,
  type LeftOutAcknowledgement,
  type LeftOutAcknowledgementWrite,
} from "@/lib/left-out-acknowledgement";

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
 * (`ledgerCheckMode`); this is the table's one writer, so it is refused here too, whoever calls — by name, before the
 * table's own CHECK (`left_out_acknowledgements_reason_says_something`) would refuse it with no line named.
 *
 * ⛔ And by more than that CHECK covers: it trims ASCII whitespace only (char 9–13 and 32), and migration 0024 is
 * applied to the real ledger, never edited. Here a reason says nothing when only Unicode whitespace and invisible
 * characters are in it — a no-break, ideographic or zero-width space, a joiner, a BOM, a format or control character,
 * the braille blank (`reasonSaysNothing`).
 *
 * ⛔ Nor one carrying a control character, a line or paragraph separator (U+2028, U+2029) or a bidi control anywhere,
 * words beside it or not — it would be stored, and printed raw with the line wherever it is printed: a stored reason is
 * on one line, its words in the order given. Refused by name, ALL of them, before anything is written
 * (`reasonCarriesControl`). ⛔ But for a reason the ledger stores already, from before that guard: ⚖️ §6A 30, an open
 * line takes the reason its lines alike carry, exactly — taken as stored. 🔴 Review of 3872004: refused here, a mark
 * partly acknowledged with such a reason failed ledger-check for good. The command line lets one through only for the
 * lines alike that carry it (`reasonCarriedAlready`).
 */
export function writeLeftOutAcknowledgements(db: AppDatabase, writes: readonly LeftOutAcknowledgementWrite[]): void {
  if (writes.length === 0) return;
  const blank = writes.find((write) => reasonSaysNothing(write.reason));
  if (blank !== undefined) {
    throw new Error(
      `refused: an acknowledgement says what the session read on the statement, and the one for ${blank.description} on ` +
        `${blank.printedOn} says nothing — nothing was written`,
    );
  }
  const stored = new Set(
    db.select({ reason: leftOutAcknowledgements.reason }).from(leftOutAcknowledgements).all().map((r) => r.reason),
  );
  for (const write of writes) {
    if (stored.has(write.reason)) continue;
    const carries = reasonCarriesControl(write.reason);
    if (carries !== null) {
      throw new Error(`refused: the reason for ${write.description} on ${write.printedOn} ${carries} — nothing was written`);
    }
  }
  db.transaction((tx) => {
    for (const write of writes) tx.insert(leftOutAcknowledgements).values({ ...write }).run();
  });
}
