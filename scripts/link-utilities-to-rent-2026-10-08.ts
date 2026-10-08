/**
 * REAL-DB WRITE — the owner's answer to §6A 59 of 2026-10-08: `Rent utilities & fees` ($182.21) is paid INSIDE the
 * rent payment each month (Sep 2 $2,291.21 = rent $2,109.00 + $182.21), so it is billed with the rent:
 *
 *   recurring_series.user_billed_with_series_id = '019f72f5-055f-7000-a3ef-2ac408a6044b'   (Flamingo South Beach (rent))
 *
 * The measurement, every guard and why are in `scripts/link-utilities-to-rent.ts`. This file is the command line.
 *
 * ## The runbook — from the main checkout, with the dev server stopped, once the branch carrying 0026 has landed
 *
 *   pnpm tsx scripts/link-utilities-to-rent-2026-10-08.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *   pnpm tsx scripts/link-utilities-to-rent-2026-10-08.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *   pnpm tsx scripts/link-utilities-to-rent-2026-10-08.ts --db=data/moneyapp.db             # ALREADY APPLIED
 *
 * ⚠️ Opening the ledger applies migration 0026 (the column), as the app's own boot would; the dry run writes nothing
 * else.
 *
 * ⛔ Only the utilities' `user_billed_with_series_id` and `updated_at` may change. Every transaction, every daily
 * balance, the status counts and every other series are compared before and after, on the rehearsal copy and on the
 * ledger; the utilities must read the rent's evidence ("billed with the rent, last seen Sep 2"), the Subscriptions
 * card's never-billed figure must fall by exactly $182.21, and the forecast, its occurrences, the arrears and the
 * committed book's money must not move by a cent. Any state but the measured one or the written one is refused.
 *
 * ## Rehearsed on copies of his ledger (moneyapp-copy-2026-10-08.db, migrations through 0024), 2026-10-08
 *
 * Dry run: PLAN — the utilities a confirmed monthly bill at -$182.21, never matched, billed with nothing; the rent a
 * confirmed monthly bill at -$2,109.00, last matched 2026-09-02; the five payments active and linked to it. Rehearsal:
 * the card's never billed $477.90 → $295.69 (12.5% → 7.7% of $3,816.92, which holds), its line "never billed" →
 * "billed with the rent, last seen Sep 2", evidence never-billed → active (the rent: active); every guard holds; the
 * copy left unwritten. `--confirm` on a second copy: APPLIED with the same figures, a `pre-*-link-utilities-to-rent.db`
 * restore point; the re-run ALREADY APPLIED. On the written copy /recurring's money-out band reads "$64.87 of it running
 * late · $468.86 never billed" (was $651.07), its footers "2 have never been billed" (were 3), and the forecast's
 * $4,718.29 of spending is unchanged.
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (in `--scratch=<dir>`, default the OS
 * temp directory; removed afterwards). `--confirm` rehearses again, takes the restore point beside the ledger, writes,
 * and re-checks every guard on the ledger itself.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { onRehearsalCopy, parseGuardedArgs } from "./guarded-write-harness";
import {
  PAYMENTS,
  RENT,
  SNAPSHOT_LABEL,
  UTILITIES,
  applyLink,
  captureState,
  classify,
  compareStates,
  describeSeries,
  loadFacts,
  rehearse,
  type WriteState,
} from "./link-utilities-to-rent";

const money = (cents: number | null): string => (cents === null ? "—" : formatCents(cents));

function report(label: string, before: WriteState, after: WriteState): void {
  const b = before.figures;
  const a = after.figures;
  const was = b.line?.neverBilled ? "never billed" : b.line?.billedWithLabel;
  console.log(
    `  ${label}: never billed ${money(b.neverBilledCents)} → ${money(a.neverBilledCents)} · headline ` +
      `${money(b.liveMonthlyCents)} → ${money(a.liveMonthlyCents)} · its line "${was}" → "${a.line?.billedWithLabel}" · ` +
      `evidence ${b.utilitiesEvidence} → ${a.utilitiesEvidence} (the rent: ${a.rentEvidence})`,
  );
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const today = todayIso();
  const real = createDatabase(args.db);
  try {
    const facts = loadFacts(real);
    const verdict = classify(facts);
    console.log(`\n── plan on ${args.db} (today ${today}): ${verdict.kind.toUpperCase()}`);
    if (facts.hasColumn) {
      console.log(`  ${describeSeries(real, UTILITIES.id)}`);
      console.log(`  ${describeSeries(real, RENT.id)}`);
    }
    for (const want of PAYMENTS) {
      const f = facts.payments.get(want.id);
      const shown =
        f === undefined
          ? "not in this ledger"
          : `${f.postedOn} ${formatCents(f.amountCents).padStart(11)}  ${f.status} · ${f.seriesName ?? "no series"}`;
      console.log(`  ${want.id}  ${shown}`);
    }
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") {
      return void console.log(`ALREADY APPLIED — nothing to do: ${UTILITIES.name} is billed with ${RENT.name}`);
    }
    console.log(`  links ${UTILITIES.name} → ${RENT.name}: billed with the rent; its amount, forecast and arrears stay`);

    const rehearsal = await onRehearsalCopy(real, args.scratch, SNAPSHOT_LABEL, (copy) => rehearse(copy, today));
    report("rehearsal", rehearsal.before, rehearsal.after);
    if (rehearsal.failures.length > 0) {
      for (const failure of rehearsal.failures) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "  ✓ rehearsed on a copy: one series row moves in two columns, no money moves, and a second run is ALREADY APPLIED",
    );
    if (!args.confirm) {
      return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");
    }

    const before = captureState(real, today);
    withPreMutationSnapshot(real.db, SNAPSHOT_LABEL, () => applyLink(real));
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
