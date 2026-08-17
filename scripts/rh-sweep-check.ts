import fs from "node:fs";
import Database from "better-sqlite3";
import { extractLines } from "@/services/import/profiles/pdf-profile";
import { parseSweepActivity } from "@/services/import/profiles/robinhood-brokerage-statement-profile";
import { dropSettlementLag } from "./settlement-lag";

/**
 * WHICH DAY did the Robinhood cash ledger part company with the bank?
 *
 * `Robinhood Cash` grades `broken`: 323 gap days and $1,911.24 spread across ten
 * monthly periods. That number comes from the only arbiter the account has —
 * the month's printed opening and closing cash — so it can say a month is wrong
 * and nothing more. Ten months of "somewhere in here" is not a lead.
 *
 * Robinhood also prints a `Deposit Sweep Activity` table: every movement of
 * uninvested cash to and from the program banks, each with a running balance
 * beside it. 309 such rows sit across 18 of the 32 archived statements, and
 * until `parseSweepActivity` nothing read them. This script walks the printed
 * table beside the replayed ledger and reports every day on which the two
 * disagree, with the amount.
 *
 * ⚠️ It compares DAILY DELTAS, not balances. The printed table tracks the SWEEP
 * only, while the account models sweep + brokerage-held cash, so the two levels
 * are legitimately offset by whatever is sitting un-swept. Deltas are immune to
 * that offset while still pinning a missing movement to its day — the whole
 * point. Cash that moves in or out of brokerage-held cash WITHOUT being swept
 * (a dividend that lands and stays, the $35.11 on 2025-10-31) is therefore an
 * expected disagreement, not a defect, and is reported rather than hidden.
 *
 * Read-only. It never writes to the database.
 *
 *   pnpm rh-sweep-check            # every archived statement
 *   pnpm rh-sweep-check 2025-10    # one period
 */

const CASH_ACCOUNT = "019f4c92-3250-7cd2-b24a-ba39058990d2";
const PROFILE = "robinhood-brokerage-statement-pdf";
const onlyPeriod = process.argv.slice(2).find((a) => !a.startsWith("--"));

const money = (c: number): string => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

const db = new Database("data/moneyapp.db", { readonly: true });

const files = db
  .prepare(`SELECT file_name, storage_path FROM import_files WHERE parser_profile = ? ORDER BY file_name`)
  .all(PROFILE) as { file_name: string; storage_path: string }[];

const txnsByDay = db.prepare(
  `SELECT posted_on AS day, SUM(amount_cents) AS cents FROM transactions
    WHERE account_id = ? AND posted_on BETWEEN ? AND ? GROUP BY day ORDER BY day`,
);

interface Finding {
  period: string;
  day: string;
  cents: number;
}

const findings: Finding[] = [];
let checked = 0;
let skippedNoTable = 0;
let skippedMissingFile = 0;

for (const f of files) {
  if (!fs.existsSync(f.storage_path)) {
    skippedMissingFile += 1;
    continue;
  }
  const lines = await extractLines(fs.readFileSync(f.storage_path));
  const sweep = parseSweepActivity(lines.map((l) => l.text));
  if (sweep === null) {
    skippedNoTable += 1;
    continue;
  }
  const period = sweep.openingOn.slice(0, 7);
  if (onlyPeriod && period !== onlyPeriod) continue;
  checked += 1;

  const printedByDay = new Map<string, number>();
  for (const m of sweep.movements) {
    printedByDay.set(m.day, (printedByDay.get(m.day) ?? 0) + m.amountCents);
  }
  const ledgerByDay = new Map<string, number>();
  for (const r of txnsByDay.all(CASH_ACCOUNT, sweep.openingOn, sweep.closingOn) as {
    day: string;
    cents: number;
  }[]) {
    ledgerByDay.set(r.day, r.cents);
  }

  const days = [...new Set([...printedByDay.keys(), ...ledgerByDay.keys()])].sort();
  const disagreements = days
    .map((day) => ({ day, cents: (ledgerByDay.get(day) ?? 0) - (printedByDay.get(day) ?? 0) }))
    .filter((d) => d.cents !== 0);

  const unpaired = dropSettlementLag(disagreements);
  const lagPairs = (disagreements.length - unpaired.length) / 2;
  const net = unpaired.reduce((n, d) => n + d.cents, 0);
  const verdict = unpaired.length === 0 ? "clean" : `${unpaired.length} days unexplained, net ${money(net)}`;
  console.log(
    `${period}  ${String(sweep.movements.length).padStart(3)} printed rows  ` +
      `${String(lagPairs).padStart(2)} lag pairs  ${verdict}`,
  );
  for (const d of unpaired) {
    console.log(`         ${d.day}  ledger ${d.cents > 0 ? "over" : "under"} by ${money(Math.abs(d.cents))}`);
    findings.push({ period, day: d.day, cents: d.cents });
  }
}

console.log(`\nstatements checked          ${checked}`);
console.log(`skipped (no sweep table)    ${skippedNoTable}`);
console.log(`skipped (file not on disk)  ${skippedMissingFile}`);
console.log(`days that disagree          ${findings.length}`);
console.log(`net across all of them      ${money(findings.reduce((n, f) => n + f.cents, 0))}`);
db.close();
