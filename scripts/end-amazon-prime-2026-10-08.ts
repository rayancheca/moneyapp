/**
 * REAL-DB WRITE — the owner's answer of 2026-10-08: he CANCELLED Amazon Prime. End its series.
 *
 *   Amazon Prime (019f4cd2-ea17-7ca2-a265-66db87397b3a) · detected · monthly · -$4.99 · last charged 2026-07-05
 *
 * 🔴 Why now: §6A 57 made a bill lapse only on days its account's statements have covered. Prime's last charge (Jul 5)
 * is on Chase Sapphire, read only through Sep 2 — one missed charge on read days, not three — so the rule put it back
 * into the forecast as "running late" ($4.99 a month; the runway's arrears $2,291.21 → $2,296.20). Asked, he answered
 * "I cancelled it: end it". A fact he states that no statement shows is written and stays sourced to his words.
 *
 * ⛔ ENDED, never dismissed: dismissed erases the series' history and is a re-detection sink (memory
 * moneyapp-ended-vs-dismissed). Ended keeps its three charges on the series and stops every forecast.
 *
 * ## The runbook — from the main checkout, with the dev server stopped
 *
 *   pnpm tsx scripts/end-amazon-prime-2026-10-08.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *   pnpm tsx scripts/end-amazon-prime-2026-10-08.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *   pnpm tsx scripts/end-amazon-prime-2026-10-08.ts --db=data/moneyapp.db             # ALREADY APPLIED
 *   pnpm ledger-check
 *
 * ⛔ Only the series' `status` (and `updated_at`) may change. Every transaction, every daily balance and every other
 * series is compared before and after, on the rehearsal copy and on the ledger.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, sha256Json, statusCounts } from "./guarded-write-harness";

const LABEL = "end-amazon-prime";
const SERIES = {
  id: "019f4cd2-ea17-7ca2-a265-66db87397b3a",
  name: "Amazon Prime",
  kind: "subscription",
  lastMatchedOn: "2026-07-05",
  rows: 3,
} as const;

interface SeriesFact {
  name: string;
  status: string;
  kind: string;
  lastMatchedOn: string | null;
  mergedIntoId: string | null;
  rows: number;
}

type Verdict = { kind: "plan" } | { kind: "applied" } | { kind: "refuse"; reasons: string[] };

function loadFact(bundle: DbBundle): SeriesFact | undefined {
  return bundle.sqlite
    .prepare(
      `SELECT s.name, s.status, s.kind, s.last_matched_on AS lastMatchedOn, s.merged_into_id AS mergedIntoId,
              (SELECT count(*) FROM transactions t WHERE t.recurring_series_id = s.id AND t.status = 'active') AS rows
         FROM recurring_series s WHERE s.id = ?`,
    )
    .get(SERIES.id) as SeriesFact | undefined;
}

function classify(f: SeriesFact | undefined): Verdict {
  if (f === undefined) return { kind: "refuse", reasons: [`${SERIES.id}: not in this ledger`] };
  const reasons: string[] = [];
  if (f.name !== SERIES.name) reasons.push(`named ${f.name}, not ${SERIES.name}`);
  if (f.kind !== SERIES.kind) reasons.push(`kind ${f.kind}, not ${SERIES.kind}`);
  if (f.mergedIntoId !== null) reasons.push(`merged into ${f.mergedIntoId}`);
  if (f.lastMatchedOn !== SERIES.lastMatchedOn) reasons.push(`last charged ${f.lastMatchedOn ?? "never"}, not ${SERIES.lastMatchedOn}`);
  if (f.rows !== SERIES.rows) reasons.push(`${f.rows} active rows, not ${SERIES.rows}`);
  if (reasons.length > 0) return { kind: "refuse", reasons };
  if (f.status === "ended") return { kind: "applied" };
  if (f.status !== "detected" && f.status !== "confirmed") return { kind: "refuse", reasons: [`status ${f.status} — never overwritten`] };
  return { kind: "plan" };
}

function apply(bundle: DbBundle): void {
  const changes = bundle.sqlite
    .prepare("UPDATE recurring_series SET status = 'ended', updated_at = ? WHERE id = ? AND status IN ('detected', 'confirmed')")
    .run(new Date().toISOString(), SERIES.id).changes;
  if (changes !== 1) throw new Error(`${SERIES.id}: not written`);
}

/** Everything this write must not move — the series row without the two columns it may change. */
function snapshot(bundle: DbBundle): { series: Map<string, string>; transactions: string; balances: string; statuses: string } {
  const series = new Map<string, string>();
  for (const row of bundle.sqlite.prepare("SELECT * FROM recurring_series").all() as Record<string, unknown>[]) {
    const id = row.id as string;
    if (id === SERIES.id) {
      const { status: _s, updated_at: _u, ...rest } = row;
      series.set(id, JSON.stringify(rest));
    } else series.set(id, JSON.stringify(row));
  }
  return {
    series,
    transactions: sha256Json(bundle.sqlite.prepare("SELECT * FROM transactions ORDER BY id").all()),
    balances: balancesHash(bundle),
    statuses: statusCounts(bundle),
  };
}

function compare(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>): string[] {
  const failures: string[] = [];
  const moved = changedKeys(before.series, after.series);
  if (moved.length > 0) failures.push(`${moved.length} series changed beyond Amazon Prime's status: ${moved.slice(0, 5).join(", ")}`);
  if (before.transactions !== after.transactions) failures.push("a transaction moved");
  if (before.balances !== after.balances) failures.push("daily balances moved");
  if (before.statuses !== after.statuses) failures.push("transaction status counts moved");
  return failures;
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const fact = loadFact(real);
    const verdict = classify(fact);
    console.log(`\n── plan on ${args.db}: ${verdict.kind.toUpperCase()}`);
    if (fact !== undefined) console.log(`  ${fact.name} · ${fact.status} · ${fact.kind} · last ${fact.lastMatchedOn} · ${fact.rows} rows`);
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do: Amazon Prime is ended");

    const rehearsal = await onRehearsalCopy(real, args.scratch, LABEL, (copy) => {
      const before = snapshot(copy);
      apply(copy);
      const failures = compare(before, snapshot(copy));
      if (classify(loadFact(copy)).kind !== "applied") failures.push("a second run would not be ALREADY APPLIED");
      return failures;
    });
    if (rehearsal.length > 0) {
      for (const failure of rehearsal) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ rehearsed on a copy: ends Amazon Prime, nothing else moves, and a second run is ALREADY APPLIED");
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");

    const before = snapshot(real);
    withPreMutationSnapshot(real.db, LABEL, () => apply(real));
    const failures = compare(before, snapshot(real));
    if (failures.length > 0) throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${LABEL}.db restore point:\n${failures.join("\n")}`);
    const again = classify(loadFact(real));
    console.log(`APPLIED — every guard holds; ${again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
