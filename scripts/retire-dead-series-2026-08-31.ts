/**
 * REAL-DB WRITE (dry-run by default). FOUR recurring series, `detected` →
 * `ended`. Nothing else: no transaction, no category, no link.
 *
 * ## What is wrong
 *
 * Four commitments stopped charging and the app still lists them as live:
 *
 *   DIRECT PAYMENT HOFFMAN LL HOFFMAN LL   $1,779.49/mo   last 2026-01-08
 *   TMOBILE*PREPD AUTOPY 877-778-2106         $55.64/mo   last 2024-07-10
 *   CHATGPT SUBSCRIPTION                      $24.20/mo   last 2024-05-07
 *   YOUTUBEPREMIUM                             $7.99/mo   last 2024-06-21
 *
 * The first is a PREVIOUS LANDLORD. The other three have not charged in over
 * two years. The forecast already ignores all four — `seriesHasLapsed` sees
 * them — but `/recurring` still lists them among the live series, so the app
 * disagrees with itself about which of his commitments exist.
 *
 * ## ⛔ ENDED, never DISMISSED
 *
 * The two are not interchangeable. `ended` keeps a series' calendar history —
 * `recurringCalendar` deliberately includes `ended` in its status filter, so
 * every charge these four really made still appears on the day it happened.
 * `dismissed` erases that, AND it is a re-detection SINK: a dismissed series
 * swallows future matches, so if T-Mobile ever charged again the app would
 * quietly file it against a series nobody can see.
 *
 * ## ⛔ Selected by name AND live status AND proven lapse
 *
 * There are TWO series called `YOUTUBEPREMIUM`: one already `ended` (last
 * matched 2025-08-22, 7 rows) and one still `detected` (last matched
 * 2024-06-21, 4 rows). Name alone is ambiguous and would either fail or touch
 * the wrong one.
 *
 * And lapse is asserted with `seriesHasLapsed`, the same function the forecast
 * uses — not with a date this script picks. That matters because of the five
 * series it must NOT touch: `Car lease`, `Car insurance`, `Rent utilities &
 * fees`, `Parking` and `Gym` have never posted at all, which `isSeriesActive`
 * calls inactive and `seriesHasLapsed` correctly does not call lapsed. They are
 * real commitments the owner registered whose first statement has not arrived.
 * Sweeping "everything with no recent charge" would retire his car lease.
 *
 * ## How to run it
 *
 *     npx tsx scripts/retire-dead-series-2026-08-31.ts            # DRY RUN (default)
 *     npx tsx scripts/retire-dead-series-2026-08-31.ts --apply    # writes
 *
 * ⚠️ `--apply` needs the dev server stopped — it holds the real DB open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { inArray, sql } from "drizzle-orm";
import { createDatabase, getDb, type AppDatabase } from "@/db/client";
import { withPreMutationSnapshot } from "../src/db/backup";
import { recurringSeries } from "@/db/schema/recurring";
import { formatCents } from "@/lib/money";
import { forecastForMonth } from "@/services/forecast";
import { withBillingCarriers } from "@/services/billing-carriers";
import { seriesHasLapsed, setSeriesStatus } from "@/services/recurring";

const APPLY = process.argv.includes("--apply");
const TODAY = "2026-08-31";

const DEAD = [
  "DIRECT PAYMENT HOFFMAN LL HOFFMAN LL",
  "TMOBILE*PREPD AUTOPY 877-778-2106",
  "CHATGPT SUBSCRIPTION",
  "YOUTUBEPREMIUM",
] as const;

/** Registered commitments with no postings yet — must survive untouched. */
const NEVER_POSTED = ["Car lease", "Car insurance", "Rent utilities & fees", "Parking", "Gym"] as const;

const num = (db: AppDatabase, q: string): number =>
  ((db.get(sql.raw(q)) as { v: number | null } | undefined)?.v ?? 0) as number;

const kindTotal = (db: AppDatabase, kind: string): number =>
  num(
    db,
    `SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
     JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
     WHERE t.status='active' AND COALESCE(p.kind,c.kind)='${kind}'`,
  );

interface Snapshot {
  live: number;
  ended: number;
  dismissed: number;
  total: number;
  linkedByName: Map<string, number>;
  neverPostedStatuses: Map<string, string>;
  septIncome: number;
  septSpend: number;
  income: number;
  expense: number;
}

function snapshot(db: AppDatabase): Snapshot {
  const f = forecastForMonth(db, "2026-09", TODAY)!;
  const linked = db.all(
    sql.raw(`SELECT rs.name n, COUNT(t.id) c FROM recurring_series rs
             LEFT JOIN transactions t ON t.recurring_series_id=rs.id AND t.status='active'
             GROUP BY rs.id`),
  ) as { n: string; c: number }[];
  const surviving = db.all(
    sql.raw(`SELECT name n, status s FROM recurring_series
             WHERE name IN (${NEVER_POSTED.map((x) => `'${x}'`).join(",")})`),
  ) as { n: string; s: string }[];
  return {
    live: num(db, "SELECT COUNT(*) v FROM recurring_series WHERE status IN ('detected','confirmed')"),
    ended: num(db, "SELECT COUNT(*) v FROM recurring_series WHERE status='ended'"),
    dismissed: num(db, "SELECT COUNT(*) v FROM recurring_series WHERE status='dismissed'"),
    total: num(db, "SELECT COUNT(*) v FROM recurring_series"),
    // one series per name is not guaranteed (there are two YOUTUBEPREMIUM), so
    // this sums the linked rows per NAME — which is what must not change
    linkedByName: linked.reduce((m, r) => m.set(r.n, (m.get(r.n) ?? 0) + r.c), new Map<string, number>()),
    neverPostedStatuses: new Map(surviving.map((r) => [r.n, r.s])),
    septIncome: f.projectedIncomeCents,
    septSpend: f.projectedSpendCents,
    income: kindTotal(db, "income"),
    expense: kindTotal(db, "expense"),
  };
}

const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(46)} ${detail}`);
  if (!ok) failures.push(name);
};

function targets(db: AppDatabase) {
  const rows = db
    .select()
    .from(recurringSeries)
    .where(
      sql`${recurringSeries.name} IN (${sql.join(DEAD.map((d) => sql`${d}`), sql`, `)})
          AND ${inArray(recurringSeries.status, ["detected", "confirmed"])}`,
    )
    .all();
  if (rows.length !== DEAD.length) {
    throw new Error(`expected ${DEAD.length} live dead series, found ${rows.length}`);
  }
  for (const r of withBillingCarriers(db, rows)) {
    if (!seriesHasLapsed(r, TODAY)) throw new Error(`${r.name} has NOT lapsed — refusing`);
    if (r.lastMatchedOn === null) throw new Error(`${r.name} never posted — that is not "dead"`);
    if (r.kind === "income") throw new Error(`${r.name} is INCOME — the lapse rule is money-out`);
  }
  return rows;
}

function run(db: AppDatabase, label: string): void {
  const rows = targets(db);
  const before = snapshot(db);

  console.log(`\n${label}`);
  for (const r of rows) {
    const linkedRows = num(db, `SELECT COUNT(*) v FROM transactions WHERE recurring_series_id='${r.id}' AND status='active'`);
    console.log(
      `  ${r.name.padEnd(38)} ${formatCents(r.amountCentsAvg ?? 0).padStart(11)}` +
        `  last ${r.lastMatchedOn}  ${linkedRows} rows  ${r.status} → ended`,
    );
  }

  for (const r of rows) setSeriesStatus(db, r.id, "ended");
  const after = snapshot(db);

  console.log(`\n  guards`);
  guard("four series retired", before.live - after.live === 4, `live ${before.live} → ${after.live}`);
  guard("they are ENDED, not dismissed", after.ended - before.ended === 4, `ended ${before.ended} → ${after.ended}`);
  guard("nothing was dismissed", before.dismissed === after.dismissed, `${after.dismissed}`);
  guard("no series created or deleted", before.total === after.total, `${after.total}`);
  guard(
    "every charge keeps its series link",
    DEAD.every((n) => before.linkedByName.get(n) === after.linkedByName.get(n)),
    DEAD.map((n) => `${after.linkedByName.get(n) ?? 0}`).join("/"),
  );
  guard(
    "the never-posted commitments survive",
    NEVER_POSTED.every((n) => after.neverPostedStatuses.get(n) === before.neverPostedStatuses.get(n)),
    NEVER_POSTED.map((n) => after.neverPostedStatuses.get(n)).join(", "),
  );
  /*
   * The point of the whole change: the forecast ALREADY ignored these four, so
   * retiring them must move no projected figure. A change here would mean the
   * lapse rule and this script disagree about which series are dead.
   */
  guard("September projected income unchanged", before.septIncome === after.septIncome, formatCents(after.septIncome));
  guard("September projected spending unchanged", before.septSpend === after.septSpend, formatCents(after.septSpend));
  guard("INCOME unchanged", before.income === after.income, formatCents(after.income));
  guard("SPENDING unchanged", before.expense === after.expense, formatCents(-after.expense));
}

if (APPLY) {
  const db = getDb();
  withPreMutationSnapshot(db, "retire-dead-series", () => {
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
