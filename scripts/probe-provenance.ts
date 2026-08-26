/** READ-ONLY. Exercises provenanceFor against the real ledger, every shape. */
import { getDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { provenanceFor, type Provenance } from "@/services/provenance";

const db = getDb();
const show = (title: string, p: Provenance | null): void => {
  console.log(`\n── ${title}`);
  if (!p) { console.log("   (no such figure)"); return; }
  console.log(`   verdict: ${p.verdict}${p.checkedThrough ? `  · checked through ${p.checkedThrough}` : ""}`);
  console.log(`   ${p.headline}`);
  for (const s of p.sources) console.log(`     · [${s.kind}] ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
  for (const i of p.inputs.slice(0, 14)) console.log(`     → ${i.label.padEnd(32)} ${i.verdict.padEnd(13)} ${i.detail ?? ""}`);
  if (p.inputs.length > 14) console.log(`     → …${p.inputs.length - 14} more`);
};

show("NET WORTH, today", provenanceFor(db, { kind: "netWorth" }));

const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
for (const [label, q] of [
  ["a RECONCILED account", "SELECT id v FROM accounts WHERE name='Chase Checking'"],
  ["an UNVERIFIED account", "SELECT id v FROM accounts WHERE last4='5481'"],
  ["an INVESTMENT account", "SELECT id v FROM accounts WHERE name='Robinhood Brokerage'"],
  ["a MANUAL account", "SELECT id v FROM accounts WHERE name='Cash on Hand'"],
] as const) {
  const row = one<{ v: string } | undefined>(q);
  if (row) show(`ACCOUNT BALANCE — ${label}`, provenanceFor(db, { kind: "accountBalance", accountId: row.v }));
}

for (const [label, q] of [
  ["reconciled", "SELECT id v FROM statement_periods WHERE reconciliation='reconciled' LIMIT 1"],
  ["value_anchor", "SELECT id v FROM statement_periods WHERE reconciliation='value_anchor' LIMIT 1"],
  ["not_applicable", "SELECT id v FROM statement_periods WHERE reconciliation='not_applicable' ORDER BY period_start DESC LIMIT 1"],
] as const) {
  const row = one<{ v: string } | undefined>(q);
  if (row) show(`STATEMENT PERIOD — ${label}`, provenanceFor(db, { kind: "statementPeriod", id: row.v }));
}

for (const [label, q] of [
  ["from a reconciled statement", "SELECT t.id v FROM transactions t JOIN import_files f ON f.id=t.import_file_id WHERE f.format='pdf' AND t.status='active' LIMIT 1"],
  ["hand-entered", "SELECT id v FROM transactions WHERE import_file_id IS NULL AND status='active' LIMIT 1"],
  ["from the Rocket Money export", "SELECT t.id v FROM transactions t JOIN import_files f ON f.id=t.import_file_id WHERE f.parser_profile='rocket-money-csv' LIMIT 1"],
] as const) {
  const row = one<{ v: string } | undefined>(q);
  if (row) show(`TRANSACTION — ${label}`, provenanceFor(db, { kind: "transaction", id: row.v }));
}

show("a figure that does not exist", provenanceFor(db, { kind: "transaction", id: "nope" }));

// ── the spread across the real ledger: what fraction of rows read as proven? ──
console.log("\n── VERDICT SPREAD over 400 sampled active rows");
const sample = db.all(sql.raw(
  "SELECT id FROM transactions WHERE status='active' ORDER BY posted_on DESC LIMIT 400",
)) as { id: string }[];
const spread = new Map<string, number>();
for (const r of sample) {
  const p = provenanceFor(db, { kind: "transaction", id: r.id });
  if (p) spread.set(p.verdict, (spread.get(p.verdict) ?? 0) + 1);
}
for (const [v, n] of [...spread.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${v.padEnd(14)} ${String(n).padStart(4)}  ${"█".repeat(Math.round((n / sample.length) * 40))}`);
}
