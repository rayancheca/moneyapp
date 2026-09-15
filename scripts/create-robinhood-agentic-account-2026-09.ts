/**
 * WRITE (dry run by default). Tracks Robinhood account #655929651 as an account
 * of its own: "Robinhood Agentic", checking, ····9651.
 *
 * The owner, 2026-09-14: "i gave claude agentic in robinhood 25$ to trade so yes
 * i guess it a new acocunt". The statements print $26.64, and $26.64 is what
 * moved: June's Account Activity on #655929651 shows `Transfer from Brokerage to
 * Brokerage Cash ITRF 06/05/2026 $26.64` in the Credit column, and #487513525's
 * section of the same file prints it as a Debit. July and August print
 * `Total Funds Paid and Received $0.00 $0.00`; every month prints
 * `Brokerage Cash Balance $26.64 100.00%` and `Total Securities $0.00`.
 *
 * It writes ONE account row and nothing else — see `createAgenticAccount` in
 * ./robinhood-agentic-account.ts for the guards, the refusals and why the type
 * is `checking`. The account's June observation, July and August periods and
 * its +$26.64 come from importing the three two-account brokerage statements
 * (parser v4) AFTERWARDS, in one batch:
 *
 *   pnpm tsx scripts/create-robinhood-agentic-account-2026-09.ts --db=<path>              # dry run, opened read-only
 *   pnpm tsx scripts/create-robinhood-agentic-account-2026-09.ts --db=<path> --confirm    # writes, behind a restore point
 *
 * ⛔ The ORDER is the write: the account BEFORE the statements. Imported first,
 * the v4 parser skips #655929651's section and records each file at v4, so a
 * later import skips them as duplicates and the account stays empty for good.
 * This script refuses once that has happened (`statementsReadWithout`).
 *
 * `--db` is required, including for the real ledger (`--db=data/moneyapp.db`):
 * this script never guesses which database to open. Re-running it once the
 * account exists changes nothing. Against the real ledger, stop the dev server
 * first, and keep it stopped until the import is done.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createDatabase, type AppDatabase } from "@/db/client";
import * as schema from "@/db/schema";
import { DbTargetRefusal } from "./db-target";
import {
  AGENTIC_ACCOUNT,
  GuardFailure,
  Refusal,
  SNAPSHOT_LABEL,
  createAgenticAccount,
  parseAgenticCli,
  planAgenticAccount,
} from "./robinhood-agentic-account";

function main(): void {
  const cli = parseAgenticCli(process.argv.slice(2), { cwd: process.cwd(), exists: fs.existsSync });
  const a = AGENTIC_ACCOUNT;
  console.log(`database  ${cli.dbPath}`);
  console.log(`account   ${a.institution} · "${a.name}" · ${a.type} · ····${a.last4}\n`);

  if (!cli.confirm) {
    const sqlite = new Database(cli.dbPath, { readonly: true, fileMustExist: true });
    try {
      const plan = planAgenticAccount(drizzle(sqlite, { schema }) as unknown as AppDatabase);
      console.log(
        plan.kind === "already-tracked"
          ? `already tracked (${plan.accountId}) — --confirm would change nothing`
          : "would create it. Dry run — nothing written. Re-run with --confirm.",
      );
    } finally {
      sqlite.close();
    }
    return;
  }

  const bundle = createDatabase(cli.dbPath);
  try {
    const outcome = createAgenticAccount(bundle);
    if (outcome.kind === "already-tracked") {
      console.log(`already tracked (${outcome.accountId}) — nothing to do, nothing written`);
      return;
    }
    for (const g of outcome.guards) console.log(`  ✓ ${g.label}`);
    const backups = process.env.MONEYAPP_BACKUPS_DIR || path.join(path.dirname(cli.dbPath), "backups");
    console.log(`\ncreated ${outcome.accountId}. Restore point: the newest pre-*-${SNAPSHOT_LABEL}.db in ${backups}`);
  } catch (error: unknown) {
    if (error instanceof GuardFailure) for (const g of error.guards) console.log(`  ${g.ok ? "✓" : "✗"} ${g.label}`);
    throw error;
  } finally {
    bundle.sqlite.close();
  }
}

try {
  main();
} catch (error: unknown) {
  if (error instanceof Refusal || error instanceof DbTargetRefusal) {
    console.error(`REFUSED: ${error.message}`);
    process.exit(2);
  }
  if (error instanceof GuardFailure) {
    console.error(`${error.message} — rolled back, nothing written`);
    process.exit(1);
  }
  throw error;
}
