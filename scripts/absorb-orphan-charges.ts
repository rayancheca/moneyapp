/**
 * REAL-DB WRITE. Runs detection once so live series absorb the charges that
 * were already, unambiguously, theirs.
 *
 * `detectRecurringSeries` is a shipped user action ("Detect now" on /recurring),
 * so this script exists only to put the pass-24 guarded-write playbook around
 * the first run after the absorption path landed: a `.backup` restore point, a
 * set of Δ-guards asserted before and after, and a post-condition that THROWS
 * rather than reporting.
 *
 * ## What may change, and what may not
 *
 * Tagging moves no money, so the guards are unusually clean. The only column
 * this run is allowed to touch is `transactions.recurring_series_id`, and only
 * from NULL — never from one series to another, which is the shape that would
 * silently re-attribute history.
 *
 *   net worth              unchanged
 *   active row count       unchanged
 *   every category_id      unchanged
 *   recurring series count unchanged (absorption never CREATES one)
 *   existing links         unchanged (NULL → value only)
 *   daily_balances         untouched
 *
 * Trial-run first against a `.backup` copy: +8 rows, every guard held, and no
 * existing link moved.
 *
 * ⚠️ `.backup`, not `cp`. Copying a live SQLite file leaves its `-wal` behind
 * and the copy can be missing the most recent writes (pass 44).
 *
 * Run: pnpm absorb-orphans
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { detectRecurringSeries } from "@/services/recurring";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;

interface Snapshot {
  activeRows: number;
  netCents: number;
  seriesCount: number;
  taggedRows: number;
  categoryFingerprint: string;
  linkFingerprint: string;
  dailyBalanceFingerprint: string;
}

function snapshot(): Snapshot {
  return {
    activeRows: one<{ v: number }>("SELECT COUNT(*) v FROM transactions WHERE status='active'").v,
    netCents: one<{ v: number }>("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'").v,
    seriesCount: one<{ v: number }>("SELECT COUNT(*) v FROM recurring_series").v,
    taggedRows: one<{ v: number }>(
      "SELECT COUNT(*) v FROM transactions WHERE status='active' AND recurring_series_id IS NOT NULL",
    ).v,
    categoryFingerprint: one<{ v: string }>(
      "SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(category_id,'-') x FROM transactions ORDER BY id)",
    ).v,
    // Only rows that ALREADY had a link. A row moving from NULL to a series is
    // the point of the run; a row moving from one series to another is not.
    linkFingerprint: one<{ v: string }>(
      "SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||recurring_series_id x FROM transactions WHERE recurring_series_id IS NOT NULL ORDER BY id)",
    ).v,
    dailyBalanceFingerprint: one<{ v: string }>(
      "SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)",
    ).v,
  };
}

const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restorePoint = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-absorb-orphans.db`);
fs.mkdirSync(path.dirname(restorePoint), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restorePoint);
console.log(`restore point: ${path.relative(process.cwd(), restorePoint)}`);

const before = snapshot();
const summary = detectRecurringSeries(db, todayIso());
const after = snapshot();

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(28)} ${detail}`);
  if (!ok) failures.push(name);
};

console.log(`\ndetection: ${JSON.stringify(summary)}`);
console.log(`tagged rows: ${before.taggedRows} → ${after.taggedRows} (+${after.taggedRows - before.taggedRows})\n`);

guard("net worth", before.netCents === after.netCents, formatCents(after.netCents));
guard("active row count", before.activeRows === after.activeRows, String(after.activeRows));
guard("recurring series count", before.seriesCount === after.seriesCount, String(after.seriesCount));
guard("every category_id", before.categoryFingerprint === after.categoryFingerprint, "unchanged");
/*
 * The load-bearing guard, and the one worth writing carefully: pass 35's lesson
 * is that the riskiest code in a pass is its safety mechanism. The first draft
 * of this was `after.startsWith("") && before.split(",").every(p =>
 * after.includes(p))` — the first clause is true for every string, and a
 * substring test would happily accept a moved link whose new pair happened to
 * appear elsewhere in the joined text. It could not fail.
 *
 * Parsed into maps, it asks the exact question: did any row that ALREADY had a
 * series keep a DIFFERENT one?
 */
const linkMap = (fingerprint: string): Map<string, string> =>
  new Map(
    fingerprint
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const cut = pair.lastIndexOf(":");
        return [pair.slice(0, cut), pair.slice(cut + 1)] as const;
      }),
  );
const beforeLinks = linkMap(before.linkFingerprint);
const afterLinks = linkMap(after.linkFingerprint);
const moved = [...beforeLinks].filter(([id, series]) => afterLinks.get(id) !== series);
guard(
  "existing links (NULL→value only)",
  moved.length === 0 && beforeLinks.size > 0,
  moved.length === 0 ? `${beforeLinks.size} kept, none moved` : `${moved.length} MOVED`,
);
guard("daily_balances", before.dailyBalanceFingerprint === after.dailyBalanceFingerprint, "untouched");
guard("rows only gained a link", after.taggedRows >= before.taggedRows, "monotonic");

if (failures.length > 0) {
  throw new Error(
    `GUARD FAILED: ${failures.join(", ")}. Restore with:\n  cp "${restorePoint}" "${dbPath}"`,
  );
}
console.log("\nall guards held.");
