/**
 * REAL-DB WRITE (dry-run by default). ONE column on ONE row: the COKE split
 * event's `event_kind`, `trade` → `split`.
 *
 * ## What is wrong
 *
 * `rebuildInvestmentHistory` values a position as cumulative-sum(holding_events)
 * × the cached daily close, and the two halves disagree about when Coca-Cola
 * Consolidated's 10-for-1 happened.
 *
 *   - the QUANTITY is as-traded. The split is stored as a delta:
 *       2025-05-27  COKE  +9.013095  "split 10.01455/1.001455 — export printed 9.0131"
 *     so the running count is ~1.0 before that day and ~10.0 after.
 *   - the PRICE is split-ADJUSTED all the way back, because Yahoo returns it
 *     that way. The cache proves it rather than assuming it: COKE closes
 *     $114.36 on 2025-05-23 and $112.93 on 2025-05-27 — CONTINUOUS across a
 *     10-for-1, where a raw series would have fallen off a cliff.
 *
 * So every day before the split multiplied one pre-split share by a tenth of
 * what that share cost. 60 trading days, 2025-02-28 → 2025-05-23, COKE
 * contributing $3,835.95 where the truth is $38,359.50.
 *
 * ⛔ **The code that fixes this already shipped and is INERT.** Migration 0015
 * added `event_kind` with a default of `trade`, so nothing changed. This script
 * is the other half: it marks the one row that is not a trade.
 *
 * ## What must NOT move
 *
 * Today's position, and therefore today's net worth. A split restates the share
 * count; it does not create or destroy shares, and the adjusted deltas sum to
 * exactly the as-traded total by construction (lib/split-adjust.ts). The guards
 * below assert that the stored `holdings.quantity_e8` still equals the event
 * sum, that the split day and every day after it carry the same NAV, and that
 * the ledger's income and spending totals are untouched — this script writes no
 * transaction at all.
 *
 * ⚠️ It DOES rewrite `daily_balances` for Robinhood Brokerage, because that is
 * derived data and correcting it is the entire point. `rebuildAccount` is the
 * same call an import makes; nothing here reaches for the table directly.
 *
 * ## How to run it
 *
 *     npx tsx scripts/mark-coke-split-2026-08-31.ts            # DRY RUN (default)
 *     npx tsx scripts/mark-coke-split-2026-08-31.ts --apply    # writes
 *
 * ⚠️ `--apply` needs the dev server stopped — it holds the real DB open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { withPreMutationSnapshot } from "../src/db/backup";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { formatCents } from "@/lib/money";
import { rebuildAccount } from "@/services/derivation";

const APPLY = process.argv.includes("--apply");

const SYMBOL = "COKE";
const ACCOUNT = "Robinhood Brokerage";
/** the day this project treats as "now" — the rebuild's horizon */
const TODAY = "2026-08-31";
/** days the NAV must NOT move on: the split day itself and everything after */
const UNCHANGED_DAYS = ["2025-05-27", "2025-05-28", "2025-06-30", "2026-08-24"] as const;
/** days the NAV SHOULD rise, because they were a tenth of the truth */
const CORRECTED_DAYS = ["2025-03-31", "2025-04-30", "2025-05-23"] as const;

const num = (db: AppDatabase, q: string): number =>
  ((db.get(sql.raw(q)) as { v: number | null } | undefined)?.v ?? 0) as number;

const kindTotal = (db: AppDatabase, kind: string): number =>
  num(
    db,
    `SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
     JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
     WHERE t.status='active' AND COALESCE(p.kind,c.kind)='${kind}'`,
  );

const navOn = (db: AppDatabase, day: string): number | null => {
  const row = db.get(
    sql.raw(`SELECT b.balance_cents v FROM daily_balances b JOIN accounts a ON a.id=b.account_id
             WHERE a.name='${ACCOUNT}' AND b.day='${day}'`),
  ) as { v: number } | undefined;
  return row?.v ?? null;
};

interface Snapshot {
  navByDay: Map<string, number | null>;
  storedQty: number;
  eventSum: number;
  events: number;
  income: number;
  expense: number;
  txnRows: number;
}

function snapshot(db: AppDatabase): Snapshot {
  const days = [...CORRECTED_DAYS, ...UNCHANGED_DAYS];
  return {
    navByDay: new Map(days.map((d) => [d, navOn(db, d)])),
    storedQty: num(db, `SELECT quantity_e8 v FROM holdings WHERE symbol='${SYMBOL}'`),
    eventSum: num(db, `SELECT COALESCE(SUM(quantity_delta_e8),0) v FROM holding_events WHERE symbol='${SYMBOL}'`),
    events: num(db, "SELECT COUNT(*) v FROM holding_events"),
    income: kindTotal(db, "income"),
    expense: kindTotal(db, "expense"),
    txnRows: num(db, "SELECT COUNT(*) v FROM transactions WHERE status='active'"),
  };
}

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(42)} ${detail}`);
  if (!ok) failures.push(name);
};

/**
 * The one row, found by EVIDENCE rather than by id: the only COKE event with no
 * cost whose note says it is a split. A split moves no money, so a cost on it
 * would mean this is not the row we think it is.
 */
function targetRow(db: AppDatabase) {
  const rows = db
    .select()
    .from(holdingEvents)
    .where(and(eq(holdingEvents.symbol, SYMBOL), sql`${holdingEvents.note} LIKE 'split %'`))
    .all();
  if (rows.length !== 1) throw new Error(`expected exactly one ${SYMBOL} split row, found ${rows.length}`);
  const row = rows[0]!;
  if (row.costCents !== null) throw new Error(`a split moves no money; this row costs ${row.costCents}`);
  if (row.eventKind !== "trade") throw new Error(`already marked "${row.eventKind}" — nothing to do`);
  if (row.quantityDeltaE8 <= 0) throw new Error(`expected a positive split delta, got ${row.quantityDeltaE8}`);
  return row;
}

function run(db: AppDatabase, label: string): void {
  const row = targetRow(db);
  const before = snapshot(db);

  console.log(`\n${label}`);
  console.log(`  ${row.occurredOn}  ${row.symbol}  Δ${row.quantityDeltaE8 / 1e8}`);
  console.log(`  note: "${row.note}"`);
  console.log(`  event_kind: "trade"  →  "split"`);

  db.update(holdingEvents).set({ eventKind: "split" }).where(eq(holdingEvents.id, row.id)).run();

  const account = db.select().from(accounts).where(eq(accounts.name, ACCOUNT)).get();
  if (!account) throw new Error(`no account named ${ACCOUNT}`);
  rebuildAccount(db, account.id, TODAY);

  const after = snapshot(db);

  console.log(`\n  ${ACCOUNT} NAV`);
  for (const day of [...CORRECTED_DAYS, ...UNCHANGED_DAYS].sort()) {
    const b = before.navByDay.get(day) ?? 0;
    const a = after.navByDay.get(day) ?? 0;
    console.log(
      `    ${day}  ${formatCents(b).padStart(12)} → ${formatCents(a).padStart(12)}   ${
        a === b ? "unchanged" : `+${formatCents(a - b)}`
      }`,
    );
  }

  console.log(`\n  guards`);
  guard(
    "the row is marked",
    (db.get(sql.raw(`SELECT event_kind v FROM holding_events WHERE id='${row.id}'`)) as { v: string }).v === "split",
    "split",
  );
  guard("no holding event created or deleted", before.events === after.events, `${after.events}`);
  guard(
    "today's COKE position is unmoved",
    before.storedQty === after.storedQty && after.storedQty === after.eventSum,
    `${after.storedQty / 1e8} shares`,
  );
  guard("the as-traded event sum is untouched", before.eventSum === after.eventSum, `${after.eventSum / 1e8}`);
  for (const day of UNCHANGED_DAYS) {
    guard(
      `NAV unchanged on ${day}`,
      before.navByDay.get(day) === after.navByDay.get(day),
      formatCents(after.navByDay.get(day) ?? 0),
    );
  }
  for (const day of CORRECTED_DAYS) {
    const b = before.navByDay.get(day) ?? 0;
    const a = after.navByDay.get(day) ?? 0;
    guard(`NAV corrected upward on ${day}`, a > b, `+${formatCents(a - b)}`);
  }
  guard("no transaction touched", before.txnRows === after.txnRows, `${after.txnRows} active rows`);
  guard("INCOME unchanged", before.income === after.income, formatCents(after.income));
  guard("SPENDING unchanged", before.expense === after.expense, formatCents(-after.expense));
}

if (APPLY) {
  const db = getDb();
  withPreMutationSnapshot(db, "mark-coke-split", () => {
    run(db, "APPLYING to data/moneyapp.db");
  });
} else {
  // a rehearsal on a real copy. `.backup`, never `cp` — copying a live SQLite
  // file drops the `-wal` and yields a torn database.
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
