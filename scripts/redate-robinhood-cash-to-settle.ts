import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { accounts, importFiles, transactions } from "@/db/schema";
import { todayIso } from "@/lib/dates";
import { assignOccurrenceIndexes, dedupeHash } from "@/lib/hash";
import { rebuildAccount } from "@/services/derivation";
import { flagDuplicateCandidates } from "@/services/duplicate-flags";
import { reconcileAccounts } from "@/services/import/service";
import { robinhoodActivityCsv } from "@/services/import/profiles/csv-profiles";
import type { CanonicalTxn, ParsedStatement, SniffedFile } from "@/services/import/types";

/**
 * Re-dates the Robinhood Cash ledger from the ACTIVITY date to the SETTLE date.
 *
 * Pass 41 moved the SHARE leg to the settle date and left the CASH leg on the
 * activity date, so the ledger currently believes the money left before the
 * shares arrived. The statements say plainly which date the cash moves on:
 *
 *   July 2026, page 13 — "Executed Trades Pending Settlement — These
 *   transactions may not be reflected in the other summaries" — quarantines the
 *   7/31 AAPL buy (settles 8/3) and leaves its $1,566.50 inside the closing
 *   Brokerage Cash Balance. February 2025 does the same to a 2/28 ACH deposit
 *   settling 3/3: the amount appears NOWHERE in that statement.
 *
 * So the rule is not "trade legs settle" — it is "this ledger is settle-dated".
 * Only Buy/Sell/ACH ever lag (1–4 days); the other ten codes settle same-day,
 * which is why the parser applies it unconditionally and 168 of 2,256 rows do
 * not move at all.
 *
 * ⚠ The handoff scoped this to "trade legs" (Buy+Sell). That is measurably the
 * WRONG scope: trades-only closes 2 periods and BREAKS 2025-04, which reconciles
 * today. Buy+Sell+ACH closes 5 and breaks none. The legs must move together.
 *
 * ⛔ Do NOT implement this by re-importing the CSV at v4. That path looks
 * healthy and silently destroys ~27 real rows: importOneFile supersedes one
 * file's contribution at a time while the other files' activity-dated rows are
 * still live in the IdentityPool, and consumeIdentity matches on (day, amount)
 * with no description check. This script rewrites in place and never touches a
 * row id, so categories, notes, transfer links and exclusions survive.
 *
 *   pnpm tsx scripts/redate-robinhood-cash-to-settle.ts                    # dry run
 *   pnpm tsx scripts/redate-robinhood-cash-to-settle.ts --db=/tmp/copy.db --confirm
 *   pnpm tsx scripts/redate-robinhood-cash-to-settle.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");

/** `--db=<path>` rehearses the whole run on a throwaway copy (trial-import doctrine). */
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

const CSV_PATH = "data/statements/robinhood-cash/83a11db54353af64-3ab6c2a8-5f00-5de8-b339-c3e514d5b7a7.csv";
const ACCOUNT_NAME = "Robinhood Cash";
const PARSER_PROFILE = "robinhood-activity-csv";
const PARSER_VERSION = 4;

interface Rewrite {
  readonly postedOn: string;
  readonly transactedOn: string;
  readonly occurrenceIndex: number;
  readonly newHash: string;
}

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const account = db.select().from(accounts).where(eq(accounts.name, ACCOUNT_NAME)).get();
  if (!account) throw new Error(`No "${ACCOUNT_NAME}" account`);

  const text = fs.readFileSync(CSV_PATH, "utf8");
  const file: SniffedFile = {
    name: path.basename(CSV_PATH),
    buffer: Buffer.from(text),
    format: "csv",
    text,
  };

  /*
   * Parse with the profile itself rather than re-deriving the fields by hand.
   * rawDescription is part of the dedupe identity and is built by the parser
   * ("<description> (<instrument>)"), so any hand-rolled copy of that rule is a
   * chance to reproduce a hash that never existed. v4 returns BOTH dates, which
   * is what makes each row's old and new identity computable from one parse:
   * the OLD identity is keyed on transactedOn (the activity date), the NEW one
   * on postedOn (the settle date).
   */
  const [statement] = robinhoodActivityCsv.parse(file) as ParsedStatement[];
  const txns: CanonicalTxn[] = statement?.txns ?? [];
  if (txns.length === 0) throw new Error("Parsed 0 transactions — wrong file?");

  const oldIndexed = assignOccurrenceIndexes(txns, (t) => ({
    accountId: account.id,
    postedOn: t.transactedOn ?? t.postedOn,
    amountCents: t.amountCents,
    rawDescription: t.rawDescription,
  }));
  const newIndexed = assignOccurrenceIndexes(txns, (t) => ({
    accountId: account.id,
    postedOn: t.postedOn,
    amountCents: t.amountCents,
    rawDescription: t.rawDescription,
  }));

  /*
   * occurrence_index MUST be recomputed, not carried. Settle-dating collapses
   * 14 pairs onto a shared day (e.g. two recurring AMZN buys from 11/10 and
   * 11/11 both settle 11/12), and both members carry occurrence_index 0 today.
   * Preserving it would make their new hashes identical and violate
   * ux_transactions_account_dedupe. Re-keying on the new date renumbers them.
   */
  const byOldHash = new Map<string, Rewrite>();
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i]!;
    const oldHash = dedupeHash({
      accountId: account.id,
      postedOn: t.transactedOn ?? t.postedOn,
      amountCents: t.amountCents,
      rawDescription: t.rawDescription,
      occurrenceIndex: oldIndexed[i]!.occurrenceIndex,
    });
    const occurrenceIndex = newIndexed[i]!.occurrenceIndex;
    byOldHash.set(oldHash, {
      postedOn: t.postedOn,
      transactedOn: t.transactedOn ?? t.postedOn,
      occurrenceIndex,
      newHash: dedupeHash({
        accountId: account.id,
        postedOn: t.postedOn,
        amountCents: t.amountCents,
        rawDescription: t.rawDescription,
        occurrenceIndex,
      }),
    });
  }

  const rows = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      dedupeHash: transactions.dedupeHash,
      status: transactions.status,
    })
    .from(transactions)
    .where(eq(transactions.accountId, account.id))
    .all();

  const matched = rows.filter((r) => byOldHash.has(r.dedupeHash));
  const untouched = rows.filter((r) => !byOldHash.has(r.dedupeHash));
  const moving = matched.filter((r) => byOldHash.get(r.dedupeHash)!.postedOn !== r.postedOn);

  console.log(`db=${DB_PATH}`);
  console.log(`account rows ${rows.length} | parsed ${txns.length}`);
  console.log(`  matched by dedupe_hash : ${matched.length}`);
  console.log(`  untouched (not in CSV) : ${untouched.length}`);
  console.log(`  dates changing         : ${moving.length}`);
  console.log(`  dates unchanged        : ${matched.length - moving.length}`);

  /*
   * GATE 1 — every parsed row must find its stored row. This is the shape
   * sanity check: if the identity reconstruction were wrong in any way
   * (description rule, occurrence numbering, amount sign) the hashes would not
   * reproduce and this count would fall short. Nothing is written if it does.
   */
  const unmapped = txns.length - matched.length;
  if (unmapped !== 0) {
    throw new Error(
      `${unmapped} parsed rows did not match a stored dedupe_hash — the identity reconstruction is wrong, refusing to write`,
    );
  }

  /* GATE 2 — the new hashes must be unique among themselves... */
  const newHashes = matched.map((r) => byOldHash.get(r.dedupeHash)!.newHash);
  const distinct = new Set(newHashes);
  if (distinct.size !== newHashes.length) {
    throw new Error(
      `${newHashes.length - distinct.size} duplicate new dedupe_hashes — occurrence_index recomputation failed`,
    );
  }

  /* ...and must not collide with a row this script is NOT rewriting. */
  const untouchedHashes = new Set(untouched.map((r) => r.dedupeHash));
  const collisions = newHashes.filter((h) => untouchedHashes.has(h));
  if (collisions.length > 0) {
    throw new Error(`${collisions.length} new hashes collide with untouched rows — refusing to write`);
  }

  /*
   * GATE 3 — the script is not self-idempotent: run twice, the second run finds
   * no old hashes and GATE 1 fails, but say so in the language of the cause.
   */
  const files = db
    .select({ id: importFiles.id, version: importFiles.parserVersion })
    .from(importFiles)
    .where(eq(importFiles.parserProfile, PARSER_PROFILE))
    .all();
  if (files.some((f) => f.version >= PARSER_VERSION)) {
    throw new Error(`An import_file is already at parser_version ${PARSER_VERSION} — already migrated?`);
  }

  console.log(`  import_files to bump   : ${files.length} (${files.map((f) => f.version).join(", ")} → ${PARSER_VERSION})`);
  console.log("all gates passed");

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  // the snapshot must wrap the transaction, never sit inside it —
  // withPreMutationSnapshot throws when called within one (durable gotcha).
  withPreMutationSnapshot(db, "robinhood-cash-settle-redate", () => {
    db.transaction((tx) => {
      /*
       * PHASE 1 — park every affected hash on a value that cannot collide.
       * ux_transactions_account_dedupe is enforced per statement, so rewriting
       * row A to a hash row B still holds aborts the whole transaction even
       * though B is about to move off it.
       */
      for (const r of matched) {
        tx.update(transactions)
          .set({ dedupeHash: `migrating:${r.id}` })
          .where(eq(transactions.id, r.id))
          .run();
      }

      // PHASE 2 — the real write. Row ids are never touched, so category,
      // notes, transfer_group_id, recurring_series_id and status all survive.
      for (const r of matched) {
        const w = byOldHash.get(r.dedupeHash)!;
        tx.update(transactions)
          .set({
            postedOn: w.postedOn,
            transactedOn: w.transactedOn,
            occurrenceIndex: w.occurrenceIndex,
            dedupeHash: w.newHash,
          })
          .where(eq(transactions.id, r.id))
          .run();
      }

      // A file left at v2/v3 would be re-parsed by a future import and every
      // row re-inserted under its new identity. Bump all of them, in the same
      // transaction as the rows they produced.
      tx.update(importFiles)
        .set({ parserVersion: PARSER_VERSION })
        .where(
          inArray(
            importFiles.id,
            files.map((f) => f.id),
          ),
        )
        .run();
    });
  });

  console.log(`rewrote ${matched.length} rows (${moving.length} moved)`);

  reconcileAccounts(db, [account.id]);
  rebuildAccount(db, account.id, todayIso());
  flagDuplicateCandidates(db, [account.id]);
  console.log("reconciled, rebuilt, duplicate-flagged");

  sqlite.close();
}

main();
