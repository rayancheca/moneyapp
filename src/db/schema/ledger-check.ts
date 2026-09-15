import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { updatedAt } from "./common";

/**
 * The high-water mark under each kind of witness `pnpm ledger-check` counts
 * (`src/lib/witness-floor.ts`), one row per kind.
 *
 * ⛔ It lives HERE, in the ledger it describes, and not in a committed file or a
 * sidecar beside the database:
 *
 *  - a committed file would need a commit after every import, and the owner
 *    never edits a baseline by hand;
 *  - a sidecar does not travel with a backup. Every snapshot this app takes is
 *    `VACUUM INTO` or the online backup API, and a restore replaces the file, so
 *    a sidecar would keep the mark of a ledger that no longer exists — restore
 *    an older snapshot with fewer statements and the check fails forever;
 *  - in the file, a restore brings back the mark that snapshot was taken with,
 *    a snapshot from before this table exists migrates to no mark (the next run
 *    records one), and a rehearsal copy raises its OWN mark, never the ledger's.
 *
 * Written only by ledger-check: when a kind is first recorded, when its count
 * rises, and by `--lower-marks=<kind> --confirm`.
 */
export const ledgerWitnessMarks = sqliteTable("ledger_witness_marks", {
  kind: text("kind").primaryKey(),
  mark: integer("mark").notNull(),
  /** JSON: the witnesses seen when the mark was set, each an array of its identity's fields */
  witnesses: text("witnesses", { mode: "json" }).$type<string[][]>().notNull(),
  updatedAt: updatedAt(),
});
