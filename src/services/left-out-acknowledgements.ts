import { asc } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { leftOutAcknowledgements } from "@/db/schema/ledger-check";
import {
  reasonCarriedAlready,
  reasonCarriesControl,
  reasonSaysNothing,
  tokenOfKey,
  type LeftOutAcknowledgement,
  type LeftOutAcknowledgementWrite,
} from "@/lib/left-out-acknowledgement";
import { linesLeftOut } from "@/services/import/lines-left-out";

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
 * lines alike that carry it (`reasonCarriedAlready`), and so does this, asking ledger-check's gate's very question of
 * each write's own mark (`tokenOfKey`) and the lines left out it reads from the ledger itself (`linesLeftOut`) — never
 * a caller's word for which lines carry what. 🔴 Review of 7601578 (2026-10-13): any reason the table held was let
 * through, whichever line carried it. 🔴 Review of 3bc3002 (2026-10-22): then only for a write keyed as a stored row
 * carrying it — and a line alike acknowledged under ANOTHER of its printers' keys (`acknowledgementsOf` matches by any
 * printer) carries it under a key no write has: the gate let it through, the dry run named the run with it, and this
 * refused it, so that mark failed ledger-check for good. None is stored on his ledger (0 acknowledgements, his copy of
 * 2026-10-29).
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
  // the lines left out decide only a reason carrying what the guard refuses: read only when one does
  const leftOut = writes.some((write) => reasonCarriesControl(write.reason) !== null) ? linesLeftOut(db) : [];
  for (const write of writes) {
    if (reasonCarriedAlready(leftOut, [tokenOfKey(write)], write.reason)) continue;
    const carries = reasonCarriesControl(write.reason);
    if (carries !== null) {
      throw new Error(`refused: the reason for ${write.description} on ${write.printedOn} ${carries} — nothing was written`);
    }
  }
  db.transaction((tx) => {
    for (const write of writes) tx.insert(leftOutAcknowledgements).values({ ...write }).run();
  });
}
