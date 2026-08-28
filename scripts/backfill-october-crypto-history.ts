/**
 * REAL-DB WRITE (dry-run by default). The month of crypto the ledger could not
 * see, and why it could not see it.
 *
 * ## What is wrong
 *
 * `pnpm ledger-check`'s new value-anchor arbiter (pass 73) reported:
 *
 *     Robinhood Crypto 2025-10-31  off by -$1,505.00
 *
 * The October statement prints **$1,505.00** of crypto and the ledger values the
 * account at **$0.00** — because its holdings book does not start until
 * 2025-11-01. Every day from the first purchase to the end of October is
 * missing from the value chart, from net worth on those days, and from the only
 * check that could have noticed.
 *
 * ## The cause is written down in the data
 *
 * The first `holding_events` row carries its own explanation:
 *
 *     ETH  2025-11-01  +0.39130100  cost $1,505.00
 *     "opening balance per Nov 2025 statement (pre-Nov history unknown)"
 *
 * It is a placeholder, honestly labelled, written on 2026-07-10 when the
 * November statement was the earliest one imported. **The pre-November history
 * is no longer unknown**: the October crypto statement has since been imported
 * and the ledger holds all ten of its trades.
 *
 * ⛔ And they close, exactly. The ten October rows sum to
 *
 *     +0.025771 +0.026331 +0.051282 -0.052102 +0.132771 +0.129870
 *     -0.262641 -0.051282 +0.259740 +0.131561  =  0.391301 ETH
 *
 * — the placeholder's quantity, to the eighth decimal. That is what makes this
 * a backfill rather than a guess: the position the placeholder asserts is the
 * position the trades produce, so replacing one with the other cannot change
 * where the book stands on 2025-11-01 or on any day after it.
 *
 * ## What changes, and what must not
 *
 * The book starts on 2025-10-16 instead of 2025-11-01, so sixteen days of
 * October gain a crypto value they always had in reality. Net worth TODAY is
 * untouched — the quantity on every day from 2025-11-01 onwards is identical —
 * and no transaction, category or balance anchor is written at all.
 *
 * ⚠️ The COST of each event is the cash the trade actually moved, from the
 * transaction's own `amount_cents`, not apportioned from the placeholder's
 * $1,505.00. $1,505.00 was the MARKET VALUE on 2025-10-31; using it as a cost
 * basis would put a fabricated P&L into the holding page.
 *
 *   npx tsx scripts/backfill-october-crypto-history.ts            # DRY RUN
 *   npx tsx scripts/backfill-october-crypto-history.ts --apply    # writes
 *
 * ⚠️ `--apply` needs the dev server stopped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { formatCents } from "@/lib/money";
import { portfolioSeries } from "@/services/portfolio";
import { rebuildAccount } from "@/services/derivation";
import { withPreMutationSnapshot } from "../src/db/backup";

const APPLY = process.argv.includes("--apply");

const ACCOUNT_NAME = "Robinhood Crypto";
const PLACEHOLDER_DAY = "2025-11-01";
const PLACEHOLDER_NOTE = "opening balance per Nov 2025 statement (pre-Nov history unknown)";
/** `Crypto Purchase 0.025771 ETH` / `Crypto Sale 0.052102 ETH` */
const TRADE_RE = /^Crypto (Purchase|Sale) ([\d.]+) ([A-Z]+)$/;

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(46)} ${detail}`);
  if (!ok) failures.push(name);
};

const num = (db: AppDatabase, q: string): number =>
  ((db.get(sql.raw(q)) as { v: number | null } | undefined)?.v ?? 0) as number;

function accountId(db: AppDatabase): string {
  const row = db.get(sql.raw(`SELECT id v FROM accounts WHERE name='${ACCOUNT_NAME}'`)) as { v: string } | undefined;
  if (!row) throw new Error(`no account named ${ACCOUNT_NAME}`);
  return row.v;
}

interface Trade { id: string; day: string; deltaE8: number; costCents: number; symbol: string }

function octoberTrades(db: AppDatabase, id: string): Trade[] {
  const rows = db.all(
    sql.raw(`SELECT id, posted_on d, amount_cents a, raw_description r FROM transactions
             WHERE account_id='${id}' AND posted_on < '${PLACEHOLDER_DAY}' AND status='active'
             ORDER BY posted_on, id`),
  ) as { id: string; d: string; a: number; r: string }[];
  return rows.map((r) => {
    const m = TRADE_RE.exec(r.r);
    if (!m) throw new Error(`unparsed crypto row: ${JSON.stringify(r.r)}`);
    const units = Math.round(Number(m[2]) * 1e8);
    return {
      id: r.id,
      day: r.d,
      symbol: m[3]!,
      // a Purchase adds crypto, a Sale removes it; the CASH sign is the mirror
      deltaE8: m[1] === "Purchase" ? units : -units,
      costCents: Math.abs(r.a),
    };
  });
}

function run(db: AppDatabase, label: string): void {
  const id = accountId(db);
  const placeholder = db.get(
    sql.raw(`SELECT id v, quantity_delta_e8 q, cost_cents c FROM holding_events
             WHERE account_id='${id}' AND occurred_on='${PLACEHOLDER_DAY}' AND note='${PLACEHOLDER_NOTE}'`),
  ) as { v: string; q: number; c: number } | undefined;
  if (!placeholder) throw new Error("the placeholder event is not there — already backfilled?");

  const trades = octoberTrades(db, id);
  const summed = trades.reduce((s, t) => s + t.deltaE8, 0);

  console.log(`\n${label}`);
  console.log(`  placeholder  ${PLACEHOLDER_DAY}  ${(placeholder.q / 1e8).toFixed(8)} ETH  cost ${formatCents(placeholder.c)}`);
  console.log(`  replaced by ${trades.length} October trades:`);
  for (const t of trades) {
    console.log(`    ${t.day}  ${(t.deltaE8 / 1e8).toFixed(8).padStart(14)} ${t.symbol}  cost ${formatCents(t.costCents)}`);
  }

  const eventsBefore = num(db, `SELECT COUNT(*) v FROM holding_events WHERE account_id='${id}'`);
  const txnsBefore = num(db, "SELECT COUNT(*) v FROM transactions WHERE status='active'");
  const rowSumBefore = num(db, "SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
  const seriesBefore = new Map(portfolioSeries(db, [id]).map((p) => [p.day, p.valueCents]));

  /*
   * ⛔ The whole point, checked BEFORE anything is written: the trades must
   * produce exactly the position the placeholder asserts. If they do not, this
   * is not a backfill of known history — it is a rewrite of a balance, and it
   * stops here.
   */
  if (summed !== placeholder.q) {
    throw new Error(
      `the October trades sum to ${(summed / 1e8).toFixed(8)} ETH but the placeholder asserts ` +
        `${(placeholder.q / 1e8).toFixed(8)} — refusing to replace a balance with a different one`,
    );
  }

  db.transaction((tx) => {
    tx.run(sql.raw(`DELETE FROM holding_events WHERE id='${placeholder.v}'`));
    for (const t of trades) {
      tx.run(
        sql.raw(
          `INSERT INTO holding_events (id, account_id, symbol, asset_type, occurred_on, quantity_delta_e8, cost_cents, note, created_at, updated_at)
           VALUES (lower(hex(randomblob(16))), '${id}', '${t.symbol}', 'crypto', '${t.day}', ${t.deltaE8}, ${t.costCents},
                   'backfilled from the October 2025 statement (txn ${t.id})', datetime('now'), datetime('now'))`,
        ),
      );
    }
  });
  rebuildAccount(db, id);

  const seriesAfter = new Map(portfolioSeries(db, [id]).map((p) => [p.day, p.valueCents]));
  const days = [...seriesAfter.keys()].sort();

  console.log(`\n  guards`);
  guard("the trades produce the asserted position", summed === placeholder.q, `${(summed / 1e8).toFixed(8)} ETH`);
  guard("one placeholder out, ten trades in", num(db, `SELECT COUNT(*) v FROM holding_events WHERE account_id='${id}'`) === eventsBefore - 1 + trades.length, `${eventsBefore} → ${eventsBefore - 1 + trades.length}`);
  guard("no transaction was written", num(db, "SELECT COUNT(*) v FROM transactions WHERE status='active'") === txnsBefore, `${txnsBefore}`);
  guard("ledger row sum (not net worth)", num(db, "SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'") === rowSumBefore, formatCents(rowSumBefore));
  guard("the book now starts in October", days[0] === "2025-10-16", `${days[0]}`);
  /*
   * ⛔ Every day the book ALREADY covered must be worth exactly what it was
   * worth. This is what separates a backfill from a revaluation.
   */
  const moved = [...seriesBefore.entries()].filter(([d, v]) => seriesAfter.get(d) !== v);
  guard("no day the book already covered changed", moved.length === 0, moved.length === 0 ? "0 days" : moved.slice(0, 3).map(([d]) => d).join(", "));
  const oct31 = seriesAfter.get("2025-10-31") ?? null;
  guard("2025-10-31 is valued at last", oct31 !== null, oct31 === null ? "still nothing" : formatCents(oct31));
  /*
   * ⚠️ NOT "to a cent", which is what this guard demanded on its first run and
   * what the arbiter demands of a statement anchor. Crypto has no closing
   * auction: the app marks a daily close from its own source and Robinhood marks
   * its own venue at its own instant, so 0.391301 ETH lands 14¢ apart. That is
   * the same class as the eight other crypto entries in `ledger-check`'s
   * baseline, and it is the answer this backfill can honestly reach.
   *
   * What IS asserted is the thing that matters: a hole the size of the WHOLE
   * POSITION becomes a price mark. A dollar is two orders of magnitude below
   * the $1,505.00 it started at and still far too tight to hide a missing trade
   * — the smallest October trade is $100.01.
   */
  const printed = num(db, `SELECT ending_balance_cents v FROM statement_periods WHERE account_id='${id}' AND period_end='2025-10-31'`);
  const off = oct31 === null ? printed : Math.abs(oct31 - printed);
  guard(
    "…and the hole is now a price mark, not a position",
    oct31 !== null && off < 100,
    `printed ${formatCents(printed)} · ledger ${oct31 === null ? "—" : formatCents(oct31)} · off by ${formatCents(off)} (was ${formatCents(printed)})`,
  );
}

if (APPLY) {
  const db = getDb();
  withPreMutationSnapshot(db, "backfill-october-crypto-history", () => {
    run(db, "APPLYING to data/moneyapp.db");
  });
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rehearse-"));
  const copy = path.join(dir, "rehearsal.db");
  const live = new Database(process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db", { readonly: true });
  await live.backup(copy);
  live.close();
  const bundle = createDatabase(copy);
  run(bundle.db, "DRY RUN on a .backup copy — the live database is untouched");
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  (dry run — re-run with --apply to write, with the dev server stopped)`);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} guard(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ all guards passed`);
