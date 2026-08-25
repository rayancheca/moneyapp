/**
 * REAL-DB WRITE, one-off. Retires three series on the owner's instruction,
 * 2026-08-25.
 *
 *   UBER *ONE                       → ENDED
 *   PURA VIDA BAY ROAD MIAMI BEACH  → DISMISSED
 *   YA-FIT Smoothie Bar             → DISMISSED
 *
 * The two statuses are NOT interchangeable and the difference is the whole
 * reason this pass built them apart:
 *
 *   ENDED means "this was real and it stopped". Owner: "clearly i dont pay for
 *   uber one anymore ... its been more than a year". It had charged $4.99 three
 *   times at an identical amount; the subscription existed. So it keeps its
 *   history on the calendar — those days really were paid — and loses its
 *   forecast.
 *
 *   DISMISSED means "this was never a series". Owner: "the smoothie bat and
 *   pura vida are not recurring i just go eat there often ... you cant say
 *   doordash is recurring . its not a fixed subsription its just me getting
 *   food." Their rows are real charges that are not a pattern, so they leave the
 *   calendar entirely rather than being drawn as paid subscriptions.
 *
 * Dismissed also acts as a SINK: detection resolves a group to an existing
 * series whatever its status, so these patterns cannot be re-detected under a
 * new identity on the next run.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { setSeriesStatus } from "@/services/recurring";
import { formatCents } from "@/lib/money";

const PLAN = [
  { name: "UBER *ONE", status: "ended" as const },
  { name: "PURA VIDA BAY ROAD MIAMI BEACH", status: "dismissed" as const },
  { name: "YA-FIT Smoothie Bar", status: "dismissed" as const },
];

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const netCents = (): number =>
  one<{ v: number }>("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'").v;
const rowCount = (): number =>
  one<{ v: number }>("SELECT COUNT(*) v FROM transactions WHERE status='active'").v;
const links = (): string =>
  one<{ v: string }>(
    "SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(recurring_series_id,'-') x FROM transactions ORDER BY id)",
  ).v;
const categories = (): string =>
  one<{ v: string }>(
    "SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(category_id,'-') x FROM transactions ORDER BY id)",
  ).v;

const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-retire-series.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

const before = { net: netCents(), rows: rowCount(), links: links(), cats: categories() };

for (const item of PLAN) {
  const found = db
    .select({ id: recurringSeries.id, status: recurringSeries.status })
    .from(recurringSeries)
    .where(eq(recurringSeries.name, item.name))
    .all();
  // Exactly one, asserted: two series sharing a name would mean retiring the
  // wrong one silently, and this ledger has already produced duplicate
  // identities (two FPL merchants, two Ya-Fit, two YouTube Premium series).
  if (found.length !== 1) throw new Error(`expected 1 series named "${item.name}", found ${found.length}`);
  setSeriesStatus(db, found[0]!.id, item.status);
  console.log(`  ${item.name} — ${found[0]!.status} → ${item.status}`);
}

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(24)} ${detail}`);
  if (!ok) failures.push(name);
};

console.log("");
guard("net worth", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("no row re-linked", before.links === links(), "every series link unchanged");
guard("no row recategorized", before.cats === categories(), "every category unchanged");
guard(
  "none left projecting",
  one<{ v: number }>(
    `SELECT COUNT(*) v FROM recurring_series WHERE status IN ('detected','confirmed') AND name IN (${PLAN.map((p) => `'${p.name.replace(/'/g, "''")}'`).join(",")})`,
  ).v === 0,
  "0 of 3 still live",
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
