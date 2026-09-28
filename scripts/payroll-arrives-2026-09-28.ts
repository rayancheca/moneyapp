/**
 * REAL-DB WRITE. The cash job pays by PAYROLL now, into Wells Fargo.
 *
 * The Wells Fargo statement for 2026-08-26 → 09-24 (imported 2026-09-28) prints his pay for the first time:
 *
 *   2026-09-23  +$4,567.68  "It America LLC Payroll 260923 Rayancheca Rayan Checa"          = 4 × $1,141.92
 *   2026-09-24  +$1,141.92  "It America LLC Payroll 260924 9357426222928Qj Karim Checa,Ra"  = 1 × $1,141.92
 *
 * Together $5,709.60 — exactly the five weeks he said would land on Thursday 2026-09-24, at exactly the rate he
 * gave on 09-22 when FICA stopped being withheld. Until now the series had TWO matched rows ever (2026-06-04 and
 * 06-05, ATM cash into Chase) and the income card said his pay never reached a bank. It does now, by ACH, into an
 * account that did not exist when the series was made.
 *
 * Owner, 2026-09-28, asked as a concrete either/or: **rename the series to name the payer, point it at Wells
 * Fargo, and attach both deposits.** (He also chose "settle backwards" — a deposit clears the OLDEST unmet
 * paydays it covers. That is a behaviour change in the arrears rule, NOT this script.)
 *
 * And: *"+$468.20 'Instant Pmt From It America LLC' this was them paying them back for claude subscription"* —
 * his employer reimbursing an expense he paid, so it is `Income › Refunds & Reimbursements`, not Salary. The note
 * records whose word that is.
 *
 * ## What is written, in one transaction, behind a restore point
 *
 *  1. the series `019f72da-1fbc…`: name "Cash job (weekly pay)" → "It America LLC (weekly pay)", `account_id`
 *     NULL → Wells Fargo. Its cadence (weekly), amount ($1,141.92), kind and confirmed status do not move.
 *  2. `attachTransactions(series, [the two payroll rows])` — the app's own path, so the series' stats re-settle.
 *  3. those two rows: `Income › Salary`, source `user`, review cleared.
 *  4. the $468.20 row: `Income › Refunds & Reimbursements`, source `user`, review cleared, note added.
 *
 * ⛔ NOT touched: the two "Zelle From Rayan Karim Checa" rows (2026-08-31 $1,529.73, 09-01 $700.00). They are his
 * own money arriving from Chase, and Chase's side is not imported past 2026-08-12 — the transfer detector pairs
 * them when that statement lands. Guessing a category now would be a category the next import argues with.
 *
 * ## Guards — refuse before, throw after
 *
 * Before: the series is that series, income, weekly, confirmed, $1,141.92, and still named "Cash job (weekly
 * pay)"; each row exists, is active, sits on Wells Fargo, carries the printed amount, and is unlinked.
 * After: exactly those 3 rows and 1 series row differ; every other transaction, account, balance, anchor, period
 * and series byte-identical; net worth unchanged; the series now names Wells Fargo and holds both deposits.
 *
 *     pnpm exec tsx scripts/payroll-arrives-2026-09-28.ts --db=<copy>   # rehearse
 *     pnpm exec tsx scripts/payroll-arrives-2026-09-28.ts               # dry run on a .backup of the live ledger
 *     pnpm exec tsx scripts/payroll-arrives-2026-09-28.ts --confirm     # write
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { withPreMutationSnapshot } from "../src/db/backup";
import { formatCents } from "@/lib/money";
import { attachTransactions } from "@/services/recurring-links";

const KNOWN = new Set(["--confirm"]);
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--db=")) continue;
  if (!KNOWN.has(arg)) {
    console.error(`Unknown argument ${arg} — this script takes --db=<path> and --confirm only.`);
    process.exit(2);
  }
}
const CONFIRM = process.argv.includes("--confirm");
const DB_ARG = process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length);

const SERIES_ID = "019f72da-1fbc-7000-a434-6840bae2d231";
const OLD_NAME = "Cash job (weekly pay)";
const NEW_NAME = "It America LLC (weekly pay)";
const WF_ACCOUNT = "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8";
const SALARY = "019f4c7d-cc89-78ca-a88a-79daad01e20a";
const REIMBURSEMENTS = "019f4c7d-cc89-7df8-b1a6-9e609566dff7";
const PAY_ROWS = [
  { id: "01a0e898-c5ca-7004-864c-da99c173b10d", on: "2026-09-23", cents: 456768 },
  { id: "01a0e898-c5ca-7005-aece-a262e0465a27", on: "2026-09-24", cents: 114192 },
] as const;
const REIMBURSEMENT = { id: "01a0e898-c5ca-7003-b1e6-e166f40b933c", on: "2026-09-04", cents: 46820 } as const;
const NOTE = "His employer paying back the Claude subscription — his word, 2026-09-28.";

const failures: string[] = [];
let guardsRan = false;
function guard(what: string, ok: boolean, saw: string): void {
  guardsRan = true;
  if (ok) console.log(`  ✓ ${what} — ${saw}`);
  else {
    console.error(`  ✗ ${what} — ${saw}`);
    failures.push(what);
  }
}

const UNTOUCHED = ["accounts", "daily_balances", "balance_anchors", "statement_periods", "budgets", "holdings", "holding_events", "categories"] as const;

function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}
function digest(db: AppDatabase, query: string): string {
  const rows = db.all(sql.raw(query)) as unknown[];
  const json = JSON.stringify(rows);
  return `${rows.length}:${json.length}:${hash(json)}`;
}
const TOUCHED_IDS = [...PAY_ROWS.map((r) => r.id), REIMBURSEMENT.id];

interface Shot {
  series: Record<string, unknown> | undefined;
  rows: Record<string, Record<string, unknown>>;
  otherRows: string;
  otherSeries: string;
  tables: Record<string, string>;
  netWorth: number;
}
function shoot(db: AppDatabase): Shot {
  const series = (db.all(sql.raw(`select * from recurring_series where id = '${SERIES_ID}'`)) as Record<string, unknown>[])[0];
  const ids = TOUCHED_IDS.map((i) => `'${i}'`).join(",");
  const rows: Record<string, Record<string, unknown>> = {};
  for (const r of db.all(sql.raw(`select * from transactions where id in (${ids})`)) as Record<string, unknown>[]) {
    rows[String(r["id"])] = r;
  }
  const tables: Record<string, string> = {};
  for (const t of UNTOUCHED) tables[t] = digest(db, `select * from "${t}" order by rowid`);
  const nw = db.all(
    sql.raw(
      `select sum(d.balance_cents) as n from daily_balances d
         join (select account_id, max(day) m from daily_balances group by account_id) x
           on x.account_id = d.account_id and x.m = d.day`,
    ),
  ) as { n: number | null }[];
  return {
    series,
    rows,
    otherRows: digest(db, `select * from transactions where id not in (${ids}) order by id`),
    otherSeries: digest(db, `select * from recurring_series where id != '${SERIES_ID}' order by id`),
    tables,
    netWorth: nw[0]?.n ?? 0,
  };
}

function alreadyApplied(db: AppDatabase): boolean {
  const s = (db.all(sql.raw(`select name from recurring_series where id = '${SERIES_ID}'`)) as { name: string }[])[0];
  return s?.name === NEW_NAME;
}

function run(db: AppDatabase, how: string): void {
  console.log(`\n${how}\n`);
  const before = shoot(db);
  const s = before.series;
  if (s === undefined) {
    failures.push("series present");
    console.error(`  ✗ series ${SERIES_ID} is not in this database`);
    return;
  }
  guard("the series is the pay schedule he confirmed", s["name"] === OLD_NAME && s["kind"] === "income" && s["cadence"] === "weekly" && s["status"] === "confirmed", `${s["name"]} · ${s["kind"]} · ${s["cadence"]} · ${s["status"]}`);
  guard("it still holds his weekly figure", Number(s["user_amount_cents"]) === 114192, formatCents(Number(s["user_amount_cents"])));
  for (const r of [...PAY_ROWS, REIMBURSEMENT]) {
    const row = before.rows[r.id];
    guard(
      `the ${r.on} row is on Wells Fargo, active, unlinked, ${formatCents(r.cents)}`,
      row !== undefined && row["account_id"] === WF_ACCOUNT && row["status"] === "active" && Number(row["amount_cents"]) === r.cents && row["recurring_series_id"] === null,
      row === undefined ? "missing" : `${formatCents(Number(row["amount_cents"]))} ${row["status"]} series=${row["recurring_series_id"] ?? "-"}`,
    );
  }
  if (failures.length > 0) return;

  db.run(sql.raw(`update recurring_series set name = '${NEW_NAME}', account_id = '${WF_ACCOUNT}', updated_at = '${new Date().toISOString()}' where id = '${SERIES_ID}'`));
  const attached = attachTransactions(db, SERIES_ID, PAY_ROWS.map((r) => r.id));
  for (const r of PAY_ROWS) {
    db.run(sql.raw(`update transactions set category_id = '${SALARY}', categorization_source = 'user', needs_review = 0, updated_at = '${new Date().toISOString()}' where id = '${r.id}'`));
  }
  db.run(
    sql.raw(
      `update transactions set category_id = '${REIMBURSEMENTS}', categorization_source = 'user', needs_review = 0, notes = '${NOTE.replaceAll("'", "''")}', updated_at = '${new Date().toISOString()}' where id = '${REIMBURSEMENT.id}'`,
    ),
  );

  const after = shoot(db);
  const now = after.series as Record<string, unknown>;
  console.log("");
  guard("the schedule names the payer", now["name"] === NEW_NAME, String(now["name"]));
  guard("and lands in Wells Fargo", now["account_id"] === WF_ACCOUNT, String(now["account_id"]));
  guard("its amount and cadence did not move", Number(now["user_amount_cents"]) === 114192 && now["cadence"] === s["cadence"] && now["kind"] === s["kind"] && now["status"] === s["status"], `${formatCents(Number(now["user_amount_cents"]))} · ${now["cadence"]}`);
  guard("both payroll deposits are attached", attached.attached === 2 && PAY_ROWS.every((r) => after.rows[r.id]?.["recurring_series_id"] === SERIES_ID), `${attached.attached} attached`);
  guard("they read as salary, by his word", PAY_ROWS.every((r) => after.rows[r.id]?.["category_id"] === SALARY && after.rows[r.id]?.["categorization_source"] === "user" && Number(after.rows[r.id]?.["needs_review"]) === 0), "Income › Salary");
  guard("the $468.20 is a reimbursement, not pay", after.rows[REIMBURSEMENT.id]?.["category_id"] === REIMBURSEMENTS && after.rows[REIMBURSEMENT.id]?.["recurring_series_id"] === null, "Income › Refunds & Reimbursements, unattached");
  guard("and says whose word that is", String(after.rows[REIMBURSEMENT.id]?.["notes"] ?? "").includes("Claude subscription"), NOTE);
  guard("no amount, day or description moved", [...PAY_ROWS, REIMBURSEMENT].every((r) => {
    const b = before.rows[r.id];
    const a = after.rows[r.id];
    if (a === undefined || b === undefined) return false;
    return a["amount_cents"] === b["amount_cents"] && a["posted_on"] === b["posted_on"] && a["raw_description"] === b["raw_description"];
  }), "unchanged");
  guard("every other transaction untouched", before.otherRows === after.otherRows, "same");
  guard("every other series untouched", before.otherSeries === after.otherSeries, "same");
  for (const t of UNTOUCHED) guard(`${t} untouched`, before.tables[t] === after.tables[t], "same");
  guard("net worth unchanged", before.netWorth === after.netWorth, formatCents(after.netWorth));
}

const NOTHING = `\n  "${NEW_NAME}" already names the payer and holds its deposits — nothing to do.`;

if (CONFIRM) {
  const db = DB_ARG === undefined ? getDb() : createDatabase(path.resolve(DB_ARG)).db;
  if (alreadyApplied(db)) console.log(NOTHING);
  else withPreMutationSnapshot(db, "payroll-arrives", () => run(db, `APPLYING to ${DB_ARG ?? "data/moneyapp.db"}`));
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-payroll-"));
  const copy = path.join(dir, "rehearsal.db");
  const live = new Database(DB_ARG ?? process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db", { readonly: true });
  await live.backup(copy);
  live.close();
  const bundle = createDatabase(copy);
  if (alreadyApplied(bundle.db)) console.log(NOTHING);
  else run(bundle.db, "DRY RUN on a .backup copy — the live database is untouched");
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (guardsRan) console.log(`\n  (dry run — re-run with --confirm to write, with the dev server stopped)`);
}

if (!guardsRan) process.exit(0);
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} guard(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ all guards passed`);
