/**
 * REAL-DB WRITE — the owner's answer to §6A 55 of 2026-10-08: his pay keeps a DATED rate. "It America LLC (weekly
 * pay)" stays $1,141.92 now, and its cash weeks — every payday through Wed Aug 26 — are priced at $1,047.00:
 *
 *   recurring_series.user_amount_history = '[{"throughOn":"2026-08-26","amountCents":104700}]'
 *
 * The measurement, every guard and why are in `scripts/pay-rate-history.ts`. This file is the command line.
 *
 * ## The runbook — from the main checkout, with the dev server stopped, once the branch carrying 0025 has landed
 *
 *   pnpm tsx scripts/set-pay-rate-history-2026-10-08.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *   pnpm tsx scripts/set-pay-rate-history-2026-10-08.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *   pnpm tsx scripts/set-pay-rate-history-2026-10-08.ts --db=data/moneyapp.db             # ALREADY APPLIED
 *   pnpm ledger-check                                                    # "rate histories: 1 stored · 0 the app …"
 *
 * ⚠️ Opening the ledger applies migration 0025 (the column), as the app's own boot would; the dry run writes nothing
 * else.
 *
 * ⛔ Only his series' `user_amount_history` and `updated_at` may change. Every transaction, every daily balance, the
 * status counts and every other series are compared before and after, on the rehearsal copy and on the ledger, and the
 * figures he reads must move exactly as measured: Earned vs banked's implied pay and its "never reached a bank" each
 * fall by $1,139.04, and the monthly basis the runway reads stays $4,948.32. Any state but the measured one or the
 * written one is refused.
 *
 * ## Rehearsed on copies of his ledger (moneyapp-copy-2026-10-08.db, migrations through 0024), 2026-10-08
 *
 * Dry run: PLAN — his series income · weekly · confirmed · $1,141.92 now · history NULL; his four deposits active and
 * linked; the schedule's paydays Aug 20 and Aug 27. Rehearsal: implied $20,554.56 → $19,415.52, never reached a bank
 * $12,256.04 → $11,117.00, monthly basis $4,948.32 → $4,948.32; every guard holds; the copy left unwritten (0025
 * applied, history still NULL). `--confirm` on a second copy: APPLIED with the same figures, a `pre-*-set-pay-rate-
 * history.db` restore point; the re-run ALREADY APPLIED; `ledger-check` "rate histories: 1 stored · 0 the app cannot
 * read" and "ledger matches the recorded baseline".
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (in `--scratch=<dir>`, default the OS
 * temp directory; removed afterwards). `--confirm` rehearses again, takes the restore point beside the ledger, writes,
 * and re-checks every guard on the ledger itself.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { onRehearsalCopy, parseGuardedArgs } from "./guarded-write-harness";
import {
  HISTORY_TEXT,
  PAY,
  ROWS,
  SNAPSHOT_LABEL,
  applyHistory,
  captureState,
  classify,
  compareStates,
  loadFacts,
  rehearse,
  type WriteState,
} from "./pay-rate-history";

function print(bundle: DbBundle): void {
  const facts = loadFacts(bundle);
  const s = facts.series;
  if (s === undefined) return void console.log(`  ${PAY.id}  not in this ledger`);
  const now = s.userAmountCents === null ? "no amount of his own" : formatCents(s.userAmountCents);
  const cadence = s.userCadence ?? s.cadence;
  console.log(`  ${s.name} · ${s.kind} · ${cadence} · ${s.status} · ${now} now · history ${s.historyText ?? "NULL"}`);
  const deposit = (on: string, cents: number): string => `${on}  +${formatCents(cents).padStart(9)}`;
  for (const want of ROWS) {
    const f = facts.rows.get(want.id);
    const shown =
      f === undefined
        ? "not in this ledger"
        : `${deposit(f.postedOn, f.amountCents)}  ${f.status} · ${f.seriesName ?? "no series"}`;
    console.log(`  ${want.id}  ${shown}`);
  }
  for (const o of facts.others) console.log(`  ${o.id}  ${deposit(o.postedOn, o.amountCents)}  also linked`);
  console.log(`  paydays Aug 20 – Aug 27: ${facts.boundary.join(", ") || "none"}`);
}

const money = (cents: number | null): string => (cents === null ? "—" : formatCents(cents));
const moved = (before: number | null, after: number | null): string => `${money(before)} → ${money(after)}`;

function report(label: string, before: WriteState, after: WriteState): void {
  const b = before.figures;
  const a = after.figures;
  console.log(
    `  ${label}: implied ${moved(b.impliedCents, a.impliedCents)} · never reached a bank ` +
      `${moved(b.checkedGapCents, a.checkedGapCents)} · monthly basis ${moved(b.basisCents, a.basisCents)}`,
  );
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const today = todayIso();
  const real = createDatabase(args.db);
  try {
    const verdict = classify(loadFacts(real));
    console.log(`\n── plan on ${args.db} (today ${today}): ${verdict.kind.toUpperCase()}`);
    print(real);
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") {
      return void console.log(`ALREADY APPLIED — nothing to do: ${PAY.name} stores ${HISTORY_TEXT}`);
    }
    console.log(`  writes ${HISTORY_TEXT} — his cash weeks through Aug 26 at $1,047.00; $1,141.92 stays his rate now`);

    const rehearsal = await onRehearsalCopy(real, args.scratch, SNAPSHOT_LABEL, (copy) => rehearse(copy, today));
    report("rehearsal", rehearsal.before, rehearsal.after);
    if (rehearsal.failures.length > 0) {
      for (const failure of rehearsal.failures) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "  ✓ rehearsed on a copy: one series row moves in two columns, nothing else moves, and a second run is ALREADY APPLIED",
    );
    if (!args.confirm) {
      return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");
    }

    const before = captureState(real, today);
    withPreMutationSnapshot(real.db, SNAPSHOT_LABEL, () => applyHistory(real));
    const after = captureState(real, today);
    const failures = compareStates(before, after);
    if (failures.length > 0) {
      const restore = `restore from the pre-*-${SNAPSHOT_LABEL}.db restore point`;
      throw new Error(`WRITTEN, and a guard failed — ${restore}:\n${failures.join("\n")}`);
    }
    report("written", before, after);
    const again = classify(loadFacts(real));
    const replan = again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`;
    console.log(`APPLIED — every guard holds; ${replan}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
