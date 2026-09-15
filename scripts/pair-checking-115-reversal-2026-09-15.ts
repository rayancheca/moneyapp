/**
 * REAL-DB WRITE — the owner's answer (2) of 2026-09-15: record Chase Checking's
 * 2026-03-02 −$115.00 ("Payment to Chase card ending in 9805 03/02", …7081) and
 * +$115.00 ("…Cancelled", …7694) as ONE cancelled transfer that nets to zero,
 * so the transfers card stops calling the +$115.00 an arrival from an unknown
 * account. No balance moves.
 *
 * The measurement, why a transfer group, and every guard are in
 * `scripts/checking-115-reversal.ts`. This file is the command line.
 *
 * ⛔ ORDER: answer (1) first. This write refuses until
 * `link-sapphire-one-leg-groups-2026-09-15.ts` has linked the OTHER 2026-03-02
 * −$115.00 (…7d70) to Sapphire — and that script refuses after this one has
 * run, because it pins …7081 and …7694 as ungrouped.
 *
 * ⛔ Needs the fix(transfers) commit that reads a one-account cancelling group
 * (transfer-links' `isCancelledTransfer`). Without it the rehearsal's card
 * guard fails — linked +1, stranded +$115.00 — and nothing is written.
 *
 *   pnpm tsx scripts/pair-checking-115-reversal-2026-09-15.ts --db=data/moneyapp.db
 *   pnpm tsx scripts/pair-checking-115-reversal-2026-09-15.ts --db=data/moneyapp.db --confirm
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy
 * (in `--scratch=<dir>`, default the OS temp directory; removed afterwards).
 * `--confirm` rehearses again, takes a `pre-*-pair-checking-115-reversal.db`
 * restore point beside the ledger, writes, and re-checks every guard. Run twice:
 * ALREADY APPLIED. Any other state is refused.
 */
import fs from "node:fs";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { formatCents } from "@/lib/money";
import {
  REAL_IDS,
  SNAPSHOT_LABEL,
  applyReversal,
  captureReversalState,
  classifyReversal,
  compareReversal,
  loadFacts,
  parseReversalCli,
  rehearseReversal,
  type ReversalState,
  type TransferFigures,
} from "./checking-115-reversal";
import { onRehearsalCopy } from "./guarded-write-harness";

const MONEY: readonly (keyof TransferFigures)[] = [
  "movedCents",
  "linkedCents",
  "unpairedCents",
  "mirrorCents",
  "strandedCents",
  "routedCents",
  "arrivalCents",
  "cancelledCents",
  "flowGrossCents",
];

function show(key: keyof TransferFigures, value: TransferFigures[keyof TransferFigures]): string {
  if (typeof value !== "number") return JSON.stringify(value);
  return MONEY.includes(key) ? formatCents(value) : String(value);
}

function report(label: string, before: ReversalState, after: ReversalState): void {
  console.log(`  ${label} — transfers card read on ${REAL_IDS.cardDay}, /flow over the card's window:`);
  for (const key of Object.keys(before.figures) as (keyof TransferFigures)[]) {
    const a = show(key, before.figures[key]);
    const b = show(key, after.figures[key]);
    console.log(`    ${key.padEnd(16)} ${a === b ? a : `${a} → ${b}`}`);
  }
  const worth = (s: ReversalState) => (s.lastNetWorth === null ? "—" : `${s.lastNetWorth.day} ${formatCents(s.lastNetWorth.cents)}`);
  console.log(`    net worth        ${worth(before)} → ${worth(after)} (every day ${before.netWorth === after.netWorth ? "identical" : "MOVED"})`);
  console.log(`    daily_balances   ${before.balances === after.balances ? "identical" : "MOVED"}`);
  console.log(`    active rows      ${before.active.count} ${formatCents(before.active.cents)} → ${after.active.count} ${formatCents(after.active.cents)}`);
  console.log(`    one-leg groups   ${before.oneLegGroups} → ${after.oneLegGroups} · one-account groups ${before.oneAccountGroups} → ${after.oneAccountGroups}`);
}

async function main(): Promise<void> {
  const cli = parseReversalCli(process.argv.slice(2), { cwd: process.cwd(), exists: fs.existsSync });
  const real = createDatabase(cli.dbPath);
  try {
    const verdict = classifyReversal(loadFacts(real));
    console.log(`\n── plan on ${cli.dbPath}: ${verdict.kind.toUpperCase()}`);
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do");
    console.log(
      `  Chase Checking ${REAL_IDS.day}: −${formatCents(REAL_IDS.cents)} ${REAL_IDS.sentId} and +${formatCents(REAL_IDS.cents)} "…Cancelled" ${REAL_IDS.cancelledId} become ONE cancelled transfer, group ${REAL_IDS.sentId}`,
    );

    const rehearsal = await onRehearsalCopy(real, cli.scratch, SNAPSHOT_LABEL, (copy) => rehearseReversal(copy));
    report("rehearsal", rehearsal.before, rehearsal.after);
    if (rehearsal.failures.length > 0) {
      for (const failure of rehearsal.failures) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ rehearsed on a copy: every guard holds, and a second run is ALREADY APPLIED");
    if (!cli.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write.");

    const before = captureReversalState(real);
    withPreMutationSnapshot(real.db, SNAPSHOT_LABEL, () => applyReversal(real));
    const after = captureReversalState(real);
    const failures = compareReversal(before, after);
    if (failures.length > 0) {
      throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${SNAPSHOT_LABEL}.db restore point:\n${failures.join("\n")}`);
    }
    report("written", before, after);
    const again = classifyReversal(loadFacts(real));
    console.log(`APPLIED — every guard holds; ${again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
