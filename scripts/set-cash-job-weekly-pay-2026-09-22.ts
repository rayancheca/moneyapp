/**
 * REAL-DB WRITE. The cash job's weekly pay goes from $1,047.00 to $1,141.92.
 *
 * Owner, 2026-09-22: *"turns out they shouldnt have been withholding fica so now that they dont this is my
 * weekly pay: 1141.92"*. The job did not change and the rate did not rise — the deduction stopped, so what
 * reaches him each week is larger. He also said a payment of **five weeks at once lands Thursday 2026-09-24**;
 * that is a deposit the statements will show, not a schedule change, and this script does not touch it.
 *
 * ## What holds the figure (measured read-only on the live ledger, 2026-09-22)
 *
 *  - ONE row: `recurring_series` `019f72da-1fbc-7000-a434-6840bae2d231` — "Cash job (weekly pay)", `kind`
 *    income, `cadence` weekly, `status` confirmed, `user_amount_cents` **104700**, no account, no merchant.
 *    `seriesView` publishes `userAmountCents ?? nextExpectedAmountCents` (services/recurring), so the user's
 *    figure is the one every surface reads.
 *  - Nothing else stores it: no `budgets` row, no `app_settings` key, no constant in `src/` holds 104700.
 *    (`$1,046` appears only in prose and test fixtures describing older measurements.)
 *  - `levelledMonthlyCents(amount, "weekly")` = round(amount × 52 ÷ 12) — the annualised rate behind the
 *    income card, the runway, /budgets' income and `incomeBasis`. 104700 → **453700** ($4,537.00), which is the
 *    monthly income figure his eleven budgets were sized from (`lib/income-budget`). 114192 → **494832**
 *    ($4,948.32), so after this write income exceeds the sum of those budgets by $411.32 and /budgets will
 *    report more unallocated. ⛔ Re-sizing the budgets is HIS call — this script does not touch them.
 *
 * ## What is written, in one transaction, behind a restore point
 *
 * `user_amount_cents` 104700 → 114192 and `updated_at` on that one row. Nothing else: no transaction, no
 * balance, no anchor, no period, no other series, no budget. Past deposits are history and stay exactly as they
 * are; the figure is forward-looking, which is why the five-week payment on Thursday needs no special handling.
 *
 * ## Guards — refuse before, throw after
 *
 * Before: the row exists, is that series by name AND id, income, weekly, confirmed, and holds 104700 (114192
 * already → "nothing to do", so a re-run is a no-op).
 * After: exactly one `recurring_series` row differs, and only in `user_amount_cents` + `updated_at`; every
 * other row of that table byte-identical; `transactions`, `daily_balances`, `balance_anchors`,
 * `statement_periods`, `budgets`, `accounts` digests identical; net worth identical; the levelled monthly rate
 * moved 453700 → 494832 and equals round(114192 × 52 ÷ 12).
 *
 * ## How to run it
 *
 *     pnpm exec tsx scripts/set-cash-job-weekly-pay-2026-09-22.ts --db=<copy>     # rehearse on a copy
 *     pnpm exec tsx scripts/set-cash-job-weekly-pay-2026-09-22.ts                 # dry run on a .backup of the live ledger
 *     pnpm exec tsx scripts/set-cash-job-weekly-pay-2026-09-22.ts --confirm       # write, with the dev server stopped
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { withPreMutationSnapshot } from "../src/db/backup";
import { formatCents } from "@/lib/money";
import { levelledMonthlyCents } from "@/lib/income-basis";

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
const SERIES_NAME = "Cash job (weekly pay)";
const OLD_CENTS = 104700;
const NEW_CENTS = 114192;

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

/** Every table that must not move, as one digest per table. */
const UNTOUCHED = [
  "transactions",
  "daily_balances",
  "balance_anchors",
  "statement_periods",
  "budgets",
  "accounts",
  "holdings",
  "holding_events",
] as const;

interface Shot {
  readonly series: Record<string, unknown> | undefined;
  readonly otherSeries: string;
  readonly tables: Record<string, string>;
  readonly netWorth: number;
}

function digest(db: AppDatabase, query: string): string {
  const rows = db.all(sql.raw(query)) as unknown[];
  const json = JSON.stringify(rows);
  return `${rows.length}:${json.length}:${hash(json)}`;
}

function hash(s: string): string {
  // a small, dependency-free digest: enough to catch any row or column that moved
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

function shoot(db: AppDatabase): Shot {
  const series = (db.all(sql.raw(`select * from recurring_series where id = '${SERIES_ID}'`)) as Record<string, unknown>[])[0];
  const otherSeries = digest(db, `select * from recurring_series where id != '${SERIES_ID}' order by id`);
  const tables: Record<string, string> = {};
  for (const t of UNTOUCHED) tables[t] = digest(db, `select * from "${t}" order by rowid`);
  const nw = db.all(
    sql.raw(
      `select sum(d.balance_cents) as n from daily_balances d
         join (select account_id, max(day) m from daily_balances group by account_id) x
           on x.account_id = d.account_id and x.m = d.day`,
    ),
  ) as { n: number | null }[];
  return { series, otherSeries, tables, netWorth: nw[0]?.n ?? 0 };
}

function run(db: AppDatabase, how: string): void {
  console.log(`\n${how}\n`);
  const before = shoot(db);
  const row = before.series;
  if (row === undefined) {
    console.error(`  ✗ series ${SERIES_ID} is not in this database`);
    failures.push("series present");
    return;
  }
  const held = Number(row["user_amount_cents"]);
  console.log(
    `  "${row["name"]}" — ${row["kind"]}, ${row["cadence"]}, ${row["status"]}, user amount ${formatCents(held)}` +
      ` (levelled ${formatCents(levelledMonthlyCents(held, "weekly"))} a month)\n`,
  );
  guard("the series is the cash job", row["name"] === SERIES_NAME, String(row["name"]));
  guard("it is weekly income he confirmed", row["kind"] === "income" && row["cadence"] === "weekly" && row["status"] === "confirmed", `${row["kind"]} · ${row["cadence"]} · ${row["status"]}`);
  guard("it holds the old figure", held === OLD_CENTS, formatCents(held));
  if (failures.length > 0) return;

  db.run(
    sql.raw(
      `update recurring_series set user_amount_cents = ${NEW_CENTS}, updated_at = '${new Date().toISOString()}' where id = '${SERIES_ID}'`,
    ),
  );

  const after = shoot(db);
  const now = after.series as Record<string, unknown>;
  const moved = Object.keys(row).filter((k) => String(row[k]) !== String(now[k]));
  console.log("");
  guard("the weekly figure is his new one", Number(now["user_amount_cents"]) === NEW_CENTS, formatCents(Number(now["user_amount_cents"])));
  guard("only the amount and its timestamp moved", moved.length === 2 && moved.includes("user_amount_cents") && moved.includes("updated_at"), moved.join(", "));
  guard("every other series untouched", before.otherSeries === after.otherSeries, "same");
  for (const t of UNTOUCHED) guard(`${t} untouched`, before.tables[t] === after.tables[t], "same");
  guard("net worth unchanged", before.netWorth === after.netWorth, formatCents(after.netWorth));
  const levelled = levelledMonthlyCents(NEW_CENTS, "weekly");
  guard(
    "the levelled monthly rate follows the week",
    levelled === Math.round((NEW_CENTS * 52) / 12) && levelled === 494832,
    `${formatCents(levelledMonthlyCents(OLD_CENTS, "weekly"))} → ${formatCents(levelled)} a month`,
  );
}

const NOTHING_TO_DO = `\n  "${SERIES_NAME}" already pays ${formatCents(NEW_CENTS)} a week — nothing to do.`;

function alreadyApplied(db: AppDatabase): boolean {
  const rows = db.all(sql.raw(`select user_amount_cents as a from recurring_series where id = '${SERIES_ID}'`)) as { a: number | null }[];
  return Number(rows[0]?.a) === NEW_CENTS;
}

if (CONFIRM) {
  const db = DB_ARG === undefined ? getDb() : createDatabase(path.resolve(DB_ARG)).db;
  if (alreadyApplied(db)) console.log(NOTHING_TO_DO);
  else {
    withPreMutationSnapshot(db, "set-cash-job-weekly-pay", () => {
      run(db, `APPLYING to ${DB_ARG ?? "data/moneyapp.db"}`);
    });
  }
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-weekly-pay-"));
  const copy = path.join(dir, "rehearsal.db");
  const live = new Database(DB_ARG ?? process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db", { readonly: true });
  await live.backup(copy);
  live.close();
  const bundle = createDatabase(copy);
  if (alreadyApplied(bundle.db)) console.log(NOTHING_TO_DO);
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
