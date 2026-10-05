import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, updatedAt } from "./common";

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
  /**
   * JSON: the witnesses seen when the mark was set, each an array of its
   * identity's fields, its account's ID first — never its name, which a rename
   * changes while every count holds and nothing rewrites this row
   */
  witnesses: text("witnesses", { mode: "json" }).$type<string[][]>().notNull(),
  /** JSON: id → name of every account those witnesses are on, when the mark was set — how a drop names a removed account */
  accountNames: text("account_names", { mode: "json" }).$type<Record<string, string>>().notNull(),
  updatedAt: updatedAt(),
});

/**
 * A line left out that a session ACKNOWLEDGED after reading it on the statement (`src/lib/left-out-acknowledgement.ts`),
 * one row per line — two lines alike are two rows.
 *
 * ⚖️ Owner, 2026-10-02 (§6A 30): a line a re-read leaves out fails `pnpm ledger-check`, so the hook blocked every commit
 * until a parser fix or a re-upload; an acknowledged one is still named, with the day, and fails nothing.
 *
 * Kept HERE for the witness marks' reasons (above): a restore brings back the acknowledgements its snapshot was taken
 * with, and a rehearsal copy acknowledges in the copy, never in the ledger.
 *
 * ⛔ Keyed by what the line IS — its account, day, money, printed words and the printing file's bytes — never by a row
 * id, which a later re-read replaces. Written only by `pnpm ledger-check --acknowledge-left-out=<mark> --confirm`.
 */
export const leftOutAcknowledgements = sqliteTable("left_out_acknowledgements", {
  id: id(),
  accountId: text("account_id").notNull(),
  /** the day the printing file prints */
  printedOn: text("printed_on").notNull(),
  amountCents: integer("amount_cents").notNull(),
  /** the words the printing file prints, as `printed_lines` keeps them (normalized) */
  printedWords: text("printed_words").notNull(),
  /** the sha256 of the file the session read it on — a re-read of that file gives it a new id, never new bytes */
  printerSha256: text("printer_sha256").notNull(),
  /** the words the line was named with when acknowledged — how an acknowledgement matching no line is named */
  description: text("description").notNull(),
  /** the day it was acknowledged, as the ledger's surfaces say it */
  acknowledgedOn: text("acknowledged_on").notNull(),
  /** the moment it was recorded: it covers a leaving whose row was written before it, never a later one */
  createdAt: createdAt(),
});
