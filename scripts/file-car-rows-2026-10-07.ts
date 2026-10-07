/**
 * REAL-DB WRITE — the owner's answer to §6A 47 of 2026-10-07: file the two car payments he attached by hand and that
 * stayed Uncategorized under the categories he set on their series.
 *
 *   2026-09-02  −$695.04    "Mbfs Web Pay 260901 …"            Wells Fargo  → Car lease's category (Car › Car Payment)
 *   2026-09-03  −$1,000.00  "Prog American Ins Prem 260902 …"  Wells Fargo  → Car insurance's (Car › Car Insurance)
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-07: both rows are linked to their series (`series_link_source` user,
 * `scripts/link-car-payments-2026-09.ts`) and carry NO category — /spending's September read $1,695.04 Uncategorized and
 * no Car at all, and the Car budget missed both. They were the only rows of a live series left unfiled. The code half
 * (attaching an unfiled row files it by its series' category) is its own change; this is the ledger's half.
 *
 * ## The runbook — from the main checkout, with the dev server stopped
 *
 *   pnpm tsx scripts/file-car-rows-2026-10-07.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *   pnpm tsx scripts/file-car-rows-2026-10-07.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *   pnpm tsx scripts/file-car-rows-2026-10-07.ts --db=data/moneyapp.db             # ALREADY APPLIED
 *   pnpm ledger-check
 *
 * ⛔ Only the two rows' `category_id`, `categorization_source` (→ `user`: he set the series' category) and `updated_at`
 * may change. Every other transaction column, every other row, every daily balance and every series is compared before
 * and after, on the rehearsal copy and on the ledger. Any state but the measured one or the filed one is refused.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { formatCents } from "@/lib/money";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, sha256Json, statusCounts } from "./guarded-write-harness";

const LABEL = "file-car-rows";
const ACCOUNT = "Wells Fargo Everyday Checking";

const ROWS = [
  { id: "01a0e898-c5ca-7000-9013-21195be732a9", postedOn: "2026-09-02", amountCents: -69_504, series: "Car lease" },
  { id: "01a0e898-c5ca-7002-9bc2-911e48fb1706", postedOn: "2026-09-03", amountCents: -100_000, series: "Car insurance" },
] as const;

interface RowFact {
  id: string;
  status: string;
  postedOn: string;
  amountCents: number;
  accountName: string;
  categoryId: string | null;
  source: string | null;
  seriesName: string | null;
  seriesCategoryId: string | null;
  seriesCategoryPath: string | null;
}

type Verdict =
  | { kind: "plan"; writes: { id: string; categoryId: string }[] }
  | { kind: "applied" }
  | { kind: "refuse"; reasons: string[] };

function loadFacts(bundle: DbBundle): Map<string, RowFact> {
  const stmt = bundle.sqlite.prepare(`
    SELECT t.id, t.status, t.posted_on AS postedOn, t.amount_cents AS amountCents, a.name AS accountName,
           t.category_id AS categoryId, t.categorization_source AS source, s.name AS seriesName,
           s.user_category_id AS seriesCategoryId,
           (SELECT coalesce(p.name || ' › ', '') || c.name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
             WHERE c.id = s.user_category_id) AS seriesCategoryPath
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      LEFT JOIN recurring_series s ON s.id = t.recurring_series_id
     WHERE t.id = ?`);
  const facts = new Map<string, RowFact>();
  for (const r of ROWS) {
    const fact = stmt.get(r.id) as RowFact | undefined;
    if (fact !== undefined) facts.set(r.id, fact);
  }
  return facts;
}

function classify(facts: Map<string, RowFact>): Verdict {
  const reasons: string[] = [];
  const writes: { id: string; categoryId: string }[] = [];
  let filed = 0;
  for (const want of ROWS) {
    const f = facts.get(want.id);
    if (f === undefined) {
      reasons.push(`${want.id}: not in this ledger`);
      continue;
    }
    if (f.status !== "active") reasons.push(`${want.id}: status ${f.status}, not active`);
    if (f.postedOn !== want.postedOn || f.amountCents !== want.amountCents) {
      reasons.push(`${want.id}: ${f.postedOn} ${formatCents(f.amountCents)}, not ${want.postedOn} ${formatCents(want.amountCents)}`);
    }
    if (f.accountName !== ACCOUNT) reasons.push(`${want.id}: on ${f.accountName}, not ${ACCOUNT}`);
    if (f.seriesName !== want.series) reasons.push(`${want.id}: attached to ${f.seriesName ?? "no series"}, not ${want.series}`);
    if (f.seriesCategoryId === null) reasons.push(`${want.id}: ${want.series} carries no category`);
    if (reasons.length > 0) continue;
    if (f.categoryId === f.seriesCategoryId && f.source === "user") filed += 1;
    else if (f.categoryId === null) writes.push({ id: f.id, categoryId: f.seriesCategoryId! });
    else reasons.push(`${want.id}: filed under another category (${f.categoryId}, ${f.source}) — never overwritten`);
  }
  if (reasons.length > 0) return { kind: "refuse", reasons };
  if (filed === ROWS.length) return { kind: "applied" };
  return { kind: "plan", writes };
}

function apply(bundle: DbBundle, writes: readonly { id: string; categoryId: string }[]): void {
  const now = new Date().toISOString();
  const stmt = bundle.sqlite.prepare(
    "UPDATE transactions SET category_id = ?, categorization_source = 'user', updated_at = ? WHERE id = ? AND category_id IS NULL AND status = 'active'",
  );
  bundle.sqlite.transaction(() => {
    for (const w of writes) {
      if (stmt.run(w.categoryId, now, w.id).changes !== 1) throw new Error(`${w.id}: not written`);
    }
  })();
}

/** Every transaction as it stands — the two rows without the three columns this write may change. */
function snapshot(bundle: DbBundle): { rows: Map<string, string>; balances: string; series: string; statuses: string } {
  const rows = new Map<string, string>();
  const targets = new Set<string>(ROWS.map((r) => r.id));
  for (const row of bundle.sqlite.prepare("SELECT * FROM transactions").all() as Record<string, unknown>[]) {
    const id = row.id as string;
    if (targets.has(id)) {
      const { category_id: _c, categorization_source: _s, updated_at: _u, ...rest } = row;
      rows.set(id, JSON.stringify(rest));
    } else rows.set(id, JSON.stringify(row));
  }
  return {
    rows,
    balances: balancesHash(bundle),
    series: sha256Json(bundle.sqlite.prepare("SELECT * FROM recurring_series ORDER BY id").all()),
    statuses: statusCounts(bundle),
  };
}

function compare(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>): string[] {
  const failures: string[] = [];
  const moved = changedKeys(before.rows, after.rows);
  if (moved.length > 0) failures.push(`${moved.length} transaction(s) changed beyond the two rows' category: ${moved.slice(0, 5).join(", ")}`);
  if (before.balances !== after.balances) failures.push("daily balances moved");
  if (before.series !== after.series) failures.push("a recurring series moved");
  if (before.statuses !== after.statuses) failures.push("transaction status counts moved");
  return failures;
}

function print(facts: Map<string, RowFact>): void {
  for (const want of ROWS) {
    const f = facts.get(want.id);
    if (f === undefined) continue;
    const now = f.categoryId === null ? "Uncategorized" : f.categoryId === f.seriesCategoryId ? f.seriesCategoryPath : f.categoryId;
    console.log(`  ${f.postedOn}  ${formatCents(f.amountCents).padStart(10)}  ${f.seriesName} → ${f.seriesCategoryPath} · now ${now} (${f.source ?? "no source"})`);
  }
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const verdict = classify(loadFacts(real));
    console.log(`\n── plan on ${args.db}: ${verdict.kind.toUpperCase()}`);
    print(loadFacts(real));
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do: both are filed under their series' categories");

    const rehearsal = await onRehearsalCopy(real, args.scratch, LABEL, (copy) => {
      const before = snapshot(copy);
      apply(copy, verdict.writes);
      const failures = compare(before, snapshot(copy));
      if (classify(loadFacts(copy)).kind !== "applied") failures.push("a second run would not be ALREADY APPLIED");
      return failures;
    });
    if (rehearsal.length > 0) {
      for (const failure of rehearsal) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ rehearsed on a copy: files ${verdict.writes.length}, nothing else moves, and a second run is ALREADY APPLIED`);
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");

    const before = snapshot(real);
    withPreMutationSnapshot(real.db, LABEL, () => apply(real, verdict.writes));
    const failures = compare(before, snapshot(real));
    if (failures.length > 0) throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${LABEL}.db restore point:\n${failures.join("\n")}`);
    const again = classify(loadFacts(real));
    print(loadFacts(real));
    console.log(`APPLIED — every guard holds; ${again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
