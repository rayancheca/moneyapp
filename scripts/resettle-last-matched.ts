import path from "node:path";
import { and, eq, lte } from "drizzle-orm";
import { createDatabase } from "@/db/client";
import { recurringSeries, transactions } from "@/db/schema";
import { todayIso } from "@/lib/dates";
import { latestBalances } from "@/services/derivation";
import { loadRecomputeCtx, recomputeSeriesStats } from "@/services/recurring";

/**
 * Re-settles every series' `last_matched_on` against the rows actually linked
 * to it.
 *
 * WHY THERE IS ANYTHING TO FIX. `recomputeSeriesStats` used to decline to write
 * ANY column once a series fell below `MIN_OCCURRENCES = 3` linked rows. For the
 * statistics that is right — a cadence measured over two points is a guess. But
 * `last_matched_on` is not a statistic: it is `max(posted_on)` of the linked
 * rows, exact for one row and exact for none. Bundled into the same early
 * return, it froze, and a series went on asserting that money arrived on a day
 * with nothing linked to it.
 *
 * The code fix landed with this script (`services/recurring.ts` now settles that
 * one column unconditionally). This backfills the databases that already drifted
 * — the fix alone only takes effect the next time something recomputes.
 *
 * MEASURED on the live DB 2026-08-21, five series disagree with their evidence:
 *
 *   Cash job (weekly pay)   confirmed   2026-07-06 -> 2026-06-05   (2 rows)
 *   Hoffman LL              ended       2026-01-08 -> 2025-06-02   (1 row)
 *   WALMART … DIVIDEND      dismissed   2026-05-13 -> 2026-05-14   (4 rows)
 *   Rocket Money Premium    ended       2026-01-15 -> null         (0 rows)
 *   ZELLE … ENRIQUE RODRI   dismissed   2026-05-12 -> null         (0 rows)
 *
 * Only the first is live, and it is the one that matters: `seriesStaleness`
 * reads this column, so the app believed the cash job last paid 46 days ago
 * while the evidence said 77.
 *
 * ⛔ WHAT THIS MUST NOT DO. `last_matched_on` is a cache with no money
 * semantics, so net worth, every account's latest balance and the active row
 * count must all come out byte-identical. The script asserts that rather than
 * claiming it, and throws instead of leaving a changed database behind.
 *
 *   pnpm tsx scripts/resettle-last-matched.ts            # dry run
 *   pnpm tsx scripts/resettle-last-matched.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

interface Snapshot {
  netWorthCents: number;
  balances: string;
  activeTxns: number;
}

function snapshot(db: ReturnType<typeof createDatabase>["db"]): Snapshot {
  const balances = latestBalances(db);
  const rows = [...balances.entries()]
    .map(([id, b]) => `${id}:${b.balanceCents ?? "null"}`)
    .sort()
    .join("|");
  const netWorthCents = [...balances.values()].reduce((sum, b) => sum + (b.balanceCents ?? 0), 0);
  const activeTxns = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all().length;
  return { netWorthCents, balances: rows, activeTxns };
}

function money(c: number): string {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const today = todayIso();
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));
  console.log(`db=${DB_PATH}  today=${today}`);

  const series = db
    .select({ id: recurringSeries.id, name: recurringSeries.name, status: recurringSeries.status, stored: recurringSeries.lastMatchedOn })
    .from(recurringSeries)
    .all();

  // The same row set `recomputeSeriesStats` reads — active and not future-dated.
  // Comparing against an unfiltered max would manufacture a difference for any
  // series carrying a scheduled charge, which is not drift at all.
  const evidenceFor = (seriesId: string): string | null =>
    db
      .select({ postedOn: transactions.postedOn })
      .from(transactions)
      .where(
        and(
          eq(transactions.recurringSeriesId, seriesId),
          eq(transactions.status, "active"),
          lte(transactions.postedOn, today),
        ),
      )
      .all()
      .reduce<string | null>((latest, r) => (latest === null || r.postedOn > latest ? r.postedOn : latest), null);

  const drifted = series
    .map((s) => ({ ...s, evidence: evidenceFor(s.id) }))
    .filter((s) => s.stored !== s.evidence);

  if (drifted.length === 0) {
    console.log("every series already agrees with its evidence — nothing to do.");
    sqlite.close();
    return;
  }

  console.log(`\n${drifted.length} series disagree with their linked rows:`);
  for (const s of drifted) {
    console.log(`  ${s.name.slice(0, 34).padEnd(34)} ${s.status.padEnd(10)} ${s.stored ?? "null"} -> ${s.evidence ?? "null"}`);
  }

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backup = path.join("data", "backups", `pre-${stamp}-resettle-last-matched.db`);
  // `.backup()` is async and must never be a `cp` of a live WAL database (pass 44)
  await sqlite.backup(path.resolve(process.cwd(), backup));
  console.log(`\nrestore point: ${backup}`);

  const before = snapshot(db);
  const ctx = loadRecomputeCtx(db);
  db.transaction((tx) => {
    for (const s of series) recomputeSeriesStats(tx, s.id, today, ctx);
  });
  const after = snapshot(db);

  const still = series
    .map((s) => ({
      name: s.name,
      stored: db.select({ v: recurringSeries.lastMatchedOn }).from(recurringSeries).where(eq(recurringSeries.id, s.id)).get()?.v ?? null,
      evidence: evidenceFor(s.id),
    }))
    .filter((s) => s.stored !== s.evidence);

  console.log(`net worth  ${money(before.netWorthCents)} -> ${money(after.netWorthCents)}`);
  console.log(`active txns ${before.activeTxns} -> ${after.activeTxns}`);
  console.log(`series still disagreeing: ${still.length}`);

  if (before.netWorthCents !== after.netWorthCents) {
    throw new Error(`net worth moved: ${before.netWorthCents} -> ${after.netWorthCents}`);
  }
  if (before.balances !== after.balances) {
    throw new Error("an account's latest balance moved");
  }
  if (before.activeTxns !== after.activeTxns) {
    throw new Error(`active transaction count moved: ${before.activeTxns} -> ${after.activeTxns}`);
  }
  if (still.length > 0) {
    throw new Error(`${still.length} series still disagree after the resettle: ${still.map((s) => s.name).join(", ")}`);
  }

  console.log("\nok — every series agrees with its evidence, and no money moved.");
  sqlite.close();
}

void main();
