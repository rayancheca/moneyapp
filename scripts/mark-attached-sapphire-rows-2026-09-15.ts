/**
 * REAL-DB WRITE. Marks the 34 Chase Sapphire payment rows that
 * `attach-sapphire-payment-rows-2026-09-14.ts` filed under the statements that
 * print them as ATTACHED — `transactions.file_link_source = 'attached'`
 * (migration 0016) — so un-importing one of those statements keeps them
 * instead of deleting them.
 *
 * Owner decision, 2026-09-15 (answer 4): if a statement the 34 attached rows
 * point at is un-imported, the rows STAY — detached from the file, with their
 * money, category, transfer groups, links and notes.
 *
 * ## Measured, read-only, on the live ledger (2026-09-15)
 *
 *  - The 34 are active Chase Sapphire rows with an import file they were never
 *    parsed from: each note begins "reconstructed credit-card payment leg", each
 *    was created 2026-07-11T00:42Z — weeks before its statement was imported —
 *    and they are the only rows ledger-wide whose `created_at` precedes their
 *    file's `imported_at`. +$9,680.91, 2025-02-11 → 2026-07-01, 12 statements.
 *  - Each lies inside exactly ONE printed-balance Sapphire period, and it is
 *    the period of the file the row is filed under — the rule an import uses to
 *    file a detached row again (`reattachDetachedRows`).
 *  - Nothing carries the marker: the column is new.
 *
 * Without the marker, un-importing 20260302 or 20260702 deletes 5 and 4 of
 * these rows along with the 4 and 2 the statements parsed.
 *
 * ## What is written — the marker only, in ONE transaction, behind a restore point
 *
 * `file_link_source := 'attached'` on the 34. Nothing else, on any row. No
 * balance, period, status or link moves, so nothing is rebuilt.
 *
 * ## Guards — refuse on anything but the measured before-state or this script's after-state
 *
 * each row: Chase Sapphire, day, amount, active, filed under the statement named
 * here (a `chase-card-statement-pdf` file), the reconstruction note, inside that
 * file's printed period and inside no other · no other row carries the marker ·
 * then, before vs after: every `daily_balances` row · every `statement_periods`
 * row · status counts · every transaction column but `file_link_source` (and
 * `updated_at`) · the marker changed on exactly the 34 · per file, what
 * un-importing it would delete falls, and what it would keep rises, by exactly
 * its attached rows (`unimportCountsByFile`).
 *
 * The migration runs when this script opens the database (every
 * `createDatabase` does): an added nullable column, nothing else.
 *
 * ⛔ ORDER on the real ledger: stop the dev server and take the restore point
 * BEFORE anything running code that carries migration 0016 opens
 * `data/moneyapp.db` — the app, this script, any other script. The first open
 * applies it, so a restore point taken afterwards is already migrated.
 *
 * ⚠️ `attach-sapphire-payment-rows-2026-09-14.ts` is no post-check for this write
 * on today's ledger. `pair-checking-115-reversal-2026-09-15.ts` grouped Chase
 * Checking's cancelled −$115.00 (019f4ca7-a6cd-7694-9efd-664fae9f334e) with the
 * leg it cancels, and the attach script's after-state still expects that row
 * ungrouped, so it REFUSES naming it whether or not the 34 are marked. Measured
 * on .backup copies, 2026-09-15: unmarked, it names the 34 and that row; marked,
 * that row alone. Read the marker back instead (runbook).
 *
 *   pnpm tsx scripts/mark-attached-sapphire-rows-2026-09-15.ts --db=data/moneyapp.db
 *   pnpm tsx scripts/mark-attached-sapphire-rows-2026-09-15.ts --db=data/moneyapp.db --confirm
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { transactions } from "@/db/schema/transactions";
import { formatCents } from "@/lib/money";
import { ATTACHED } from "@/services/import/attached-rows";
import { unimportCountsByFile } from "@/services/import/unimport-counts";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, sha256Json, statusCounts } from "./guarded-write-harness";

const SAPPHIRE_ID = "019f4ca7-a750-7f21-8ffa-2546cac01f3a";
const CARD_PROFILE = "chase-card-statement-pdf";
const NOTE_PREFIX = "reconstructed credit-card payment leg";
const LABEL = "mark-attached-sapphire-rows";
const EXPECTED_NET_CENTS = 968_091;

/** [row id, posted_on, amount_cents, the statement it is filed under] — measured 2026-09-15 */
const ATTACHED_ROWS = [
  ["019f4ea0-240b-7005-9cd7-c61d7bb3799b", "2025-02-11", 35000, "20250302-statements-9805-.pdf"],
  ["019f4ea0-240b-7006-9f57-1c6e6eed887a", "2025-02-25", 16812, "20250302-statements-9805-.pdf"],
  ["019f4ea0-240d-7002-829d-31d2478b1714", "2025-02-26", 11101, "20250302-statements-9805-.pdf"],
  ["019f4ea0-240c-7005-847b-2c5fc307a413", "2025-04-03", 51091, "20250502-statements-9805-.pdf"],
  ["019f4ea0-240b-7007-9973-f4756be4d45f", "2025-06-10", 2000, "20250702-statements-9805-.pdf"],
  ["019f4ea0-2419-7009-91cc-6fd4971a8e7d", "2025-06-13", 72200, "20250702-statements-9805-.pdf"],
  ["019f4ea0-2419-700c-981c-a664cce9b962", "2025-08-11", 60599, "20250902-statements-9805-.pdf"],
  ["019f4ea0-240c-7000-b1ec-1b6d3862ecbd", "2025-08-26", 12110, "20250902-statements-9805-.pdf"],
  ["019f4ea0-241a-7001-9ccc-c7c1b0343f44", "2025-08-28", 260, "20250902-statements-9805-.pdf"],
  ["019f4ea0-240b-700c-aa47-cd6d15aeb957", "2025-09-08", 1400, "20251002-statements-9805-.pdf"],
  ["019f4ea0-241a-7004-9f48-bd1819f72783", "2025-09-11", 700, "20251002-statements-9805-.pdf"],
  ["019f4ea0-240a-7001-ad61-b127153d05df", "2025-09-12", 1040, "20251002-statements-9805-.pdf"],
  ["019f4ea0-240b-7003-ada8-f7087ea52a74", "2025-09-22", 35000, "20251002-statements-9805-.pdf"],
  ["019f4ea0-241a-7007-ab77-b32106056911", "2025-09-25", 927, "20251002-statements-9805-.pdf"],
  ["019f4ea0-2419-7005-8523-c32533a64cd4", "2025-09-26", 1098, "20251002-statements-9805-.pdf"],
  ["019f4ea0-240a-7003-8695-2e0aa16599d4", "2025-10-14", 11026, "20251102-statements-9805-.pdf"],
  ["019f4ea0-240d-7005-bf85-920b9b94efcc", "2025-12-01", 8155, "20251202-statements-9805-.pdf"],
  ["019f4ea0-240c-7006-bb3f-cad43fa5cca8", "2025-12-04", 35100, "20260102-statements-9805-.pdf"],
  ["019f4ea0-240b-700a-9b1f-7ae283f31ca4", "2025-12-09", 2904, "20260102-statements-9805-.pdf"],
  ["019f4ea0-241a-7003-9084-1b24e76c9631", "2025-12-11", 80000, "20260102-statements-9805-.pdf"],
  ["019f4ea0-241a-7002-8087-346d22d82f0d", "2025-12-26", 4350, "20260102-statements-9805-.pdf"],
  ["019f4ea0-241b-7000-bbc3-a9809b9fea4f", "2026-01-22", 2050, "20260202-statements-9805-.pdf"],
  ["019f4ea0-2419-7002-88f5-e8aef8bd2446", "2026-01-27", 60041, "20260202-statements-9805-.pdf"],
  ["019f4ea0-2408-7000-ac9b-d7fb58e4fe91", "2026-02-13", 30000, "20260302-statements-9805-.pdf"],
  ["019f4ea0-240d-7003-81fc-2d9c82e82c53", "2026-02-19", 10000, "20260302-statements-9805-.pdf"],
  ["019f4ea0-240a-7005-bfba-7b220c7db87a", "2026-02-20", 10000, "20260302-statements-9805-.pdf"],
  ["019f4ea0-240d-7001-a79e-d3f25bbbe7d7", "2026-02-27", 8200, "20260302-statements-9805-.pdf"],
  ["019f4ea0-240c-7003-bc3d-8f309bfdeff6", "2026-03-02", 11500, "20260302-statements-9805-.pdf"],
  ["019f4ea0-240a-7006-aa9c-2e9671c11008", "2026-05-15", 30000, "20260602-statements-9805-.pdf"],
  ["019f4ea0-241a-700b-ae43-8d9aaf6e4800", "2026-05-27", 150000, "20260602-statements-9805-.pdf"],
  ["019f4ea0-240b-7000-8e3f-a14ce49409d3", "2026-06-04", 46427, "20260702-statements-9805-.pdf"],
  ["019f4ea0-241a-700a-9c08-19d333ce3dff", "2026-06-23", 147000, "20260702-statements-9805-.pdf"],
  ["019f4ea0-240a-7002-9438-5b478bbf6106", "2026-06-25", 10000, "20260702-statements-9805-.pdf"],
  ["019f4ea0-240b-700b-953f-fe98274205df", "2026-07-01", 10000, "20260702-statements-9805-.pdf"],
] as const;
type Attached = (typeof ATTACHED_ROWS)[number];
const IDS = ATTACHED_ROWS.map(([id]) => id);

interface LiveRow {
  id: string;
  account_id: string;
  posted_on: string;
  amount_cents: number;
  status: string;
  import_file_id: string | null;
  file_link_source: string | null;
  notes: string | null;
  file_name: string | null;
  parser_profile: string | null;
}

type Verdict =
  | { kind: "plan"; fileOf: Map<string, string> }
  | { kind: "applied" }
  | { kind: "refuse"; reasons: string[] };

function liveRow(bundle: DbBundle, id: string): LiveRow | undefined {
  return bundle.sqlite
    .prepare(
      `SELECT t.id, t.account_id, t.posted_on, t.amount_cents, t.status, t.import_file_id, t.file_link_source, t.notes,
              f.file_name, f.parser_profile
       FROM transactions t LEFT JOIN import_files f ON f.id = t.import_file_id WHERE t.id = ?`,
    )
    .get(id) as LiveRow | undefined;
}

/** The files whose printed-balance Sapphire period contains this day. */
function printedHolders(bundle: DbBundle, day: string): string[] {
  return (
    bundle.sqlite
      .prepare(
        `SELECT import_file_id FROM statement_periods
         WHERE account_id = ? AND beginning_balance_cents IS NOT NULL AND ending_balance_cents IS NOT NULL
           AND period_start <= ? AND period_end >= ?`,
      )
      .all(SAPPHIRE_ID, day, day) as { import_file_id: string }[]
  ).map((r) => r.import_file_id);
}

/** "before" · "after" · or what is wrong with the row */
function rowState(bundle: DbBundle, [id, day, cents, fileName]: Attached): "before" | "after" | string {
  const row = liveRow(bundle, id);
  if (!row) return `${id}: missing`;
  const shaped =
    row.account_id === SAPPHIRE_ID && row.posted_on === day && row.amount_cents === cents && row.status === "active" &&
    row.import_file_id !== null && row.file_name === fileName && row.parser_profile === CARD_PROFILE &&
    (row.notes ?? "").startsWith(NOTE_PREFIX);
  if (!shaped) return `${id} is not as measured: ${JSON.stringify(row)}`;
  const holders = printedHolders(bundle, day);
  if (holders.length !== 1 || holders[0] !== row.import_file_id) {
    return `${id} (${day}) lies in printed periods of ${JSON.stringify(holders)}, not only its own file ${row.import_file_id}`;
  }
  if (row.file_link_source === null) return "before";
  if (row.file_link_source === ATTACHED) return "after";
  return `${id} carries file_link_source ${JSON.stringify(row.file_link_source)}`;
}

function planFor(bundle: DbBundle): Verdict {
  const reasons: string[] = [];
  const net = ATTACHED_ROWS.reduce((n, [, , cents]) => n + cents, 0);
  if (IDS.length !== 34 || new Set(IDS).size !== 34 || net !== EXPECTED_NET_CENTS) {
    reasons.push(`the list holds ${new Set(IDS).size} rows netting ${net}, not the measured 34 netting ${EXPECTED_NET_CENTS}`);
  }
  const others = bundle.sqlite
    .prepare(`SELECT count(*) AS n FROM transactions WHERE file_link_source IS NOT NULL AND id NOT IN (${IDS.map(() => "?").join(",")})`)
    .get(...IDS) as { n: number };
  if (others.n !== 0) reasons.push(`${others.n} other rows already carry a file_link_source`);
  const states = ATTACHED_ROWS.map((r) => rowState(bundle, r));
  for (const s of states) if (s !== "before" && s !== "after") reasons.push(s);
  if (reasons.length > 0) return { kind: "refuse", reasons };
  if (states.every((s) => s === "after")) return { kind: "applied" };
  if (!states.every((s) => s === "before")) {
    return { kind: "refuse", reasons: [`a mix: ${states.filter((s) => s === "after").length} of 34 already marked`] };
  }
  return { kind: "plan", fileOf: new Map(IDS.map((id) => [id, liveRow(bundle, id)!.import_file_id!])) };
}

function apply(bundle: DbBundle): void {
  bundle.db.transaction((tx) => {
    for (const id of IDS) {
      const changes = tx
        .update(transactions)
        .set({ fileLinkSource: ATTACHED })
        .where(and(eq(transactions.id, id), isNull(transactions.fileLinkSource), isNotNull(transactions.importFileId)))
        .run().changes;
      if (changes !== 1) throw new Error(`${id}: expected to mark 1 row, marked ${changes}`);
    }
  });
}

interface State {
  balances: string;
  periods: string;
  statusCounts: string;
  besideMarker: Map<string, string>;
  markers: Map<string, string>;
  unimport: Map<string, { deleted: number; kept: number }>;
}

function captureState(bundle: DbBundle): State {
  const txns = bundle.sqlite.prepare("SELECT * FROM transactions ORDER BY id").all() as Record<string, unknown>[];
  const besideMarker = new Map<string, string>();
  const markers = new Map<string, string>();
  for (const t of txns) {
    const { file_link_source: marker, updated_at: _updatedAt, ...rest } = t;
    besideMarker.set(String(t.id), JSON.stringify(rest));
    markers.set(String(t.id), String(marker ?? "-"));
  }
  const unimport = new Map(
    [...unimportCountsByFile(bundle.db)].map(([fileId, c]) => [fileId, { deleted: c.deleted, kept: c.kept }]),
  );
  return {
    balances: balancesHash(bundle),
    periods: sha256Json(bundle.sqlite.prepare("SELECT * FROM statement_periods ORDER BY id").all()),
    statusCounts: statusCounts(bundle),
    besideMarker,
    markers,
    unimport,
  };
}

function compareStates(before: State, after: State, fileOf: ReadonlyMap<string, string>): string[] {
  const failures: string[] = [];
  if (before.balances !== after.balances) failures.push("a daily_balances row moved");
  if (before.periods !== after.periods) failures.push("a statement_periods row moved");
  if (before.statusCounts !== after.statusCounts) failures.push(`status counts moved: ${before.statusCounts} → ${after.statusCounts}`);
  const beside = changedKeys(before.besideMarker, after.besideMarker);
  if (beside.length > 0) failures.push(`a column other than the marker changed on ${beside.length} rows: ${beside.slice(0, 5).join(", ")}`);
  const marked = changedKeys(before.markers, after.markers);
  if (JSON.stringify(marked) !== JSON.stringify([...IDS].sort())) failures.push(`the marker moved on ${marked.length} rows, expected the 34`);
  const perFile = new Map<string, number>();
  for (const fileId of fileOf.values()) perFile.set(fileId, (perFile.get(fileId) ?? 0) + 1);
  for (const [fileId, b] of before.unimport) {
    const a = after.unimport.get(fileId);
    const n = perFile.get(fileId) ?? 0;
    if (!a || a.deleted !== b.deleted - n || a.kept !== b.kept + n) {
      failures.push(`un-importing ${fileId} would delete ${b.deleted} → ${a?.deleted} and keep ${b.kept} → ${a?.kept}, expected ∓${n}`);
    }
  }
  return failures;
}

function rehearse(copy: DbBundle): string[] {
  const verdict = planFor(copy);
  if (verdict.kind !== "plan") return [`the copy planned ${verdict.kind}, not a write`];
  const before = captureState(copy);
  apply(copy);
  const failures = compareStates(before, captureState(copy), verdict.fileOf);
  if (planFor(copy).kind !== "applied") failures.push("a second run on the copy is not ALREADY APPLIED");
  return failures;
}

function printPlan(bundle: DbBundle): void {
  const byFile = new Map<string, { n: number; cents: number }>();
  for (const [, , cents, fileName] of ATTACHED_ROWS) {
    const t = byFile.get(fileName) ?? { n: 0, cents: 0 };
    byFile.set(fileName, { n: t.n + 1, cents: t.cents + cents });
  }
  for (const [fileName, t] of byFile) console.log(`  ${fileName}: ${t.n} rows, ${formatCents(t.cents)}`);
  const kept = [...unimportCountsByFile(bundle.db).values()].reduce((n, c) => n + c.kept, 0);
  console.log(`  rows any un-import would keep today: ${kept}`);
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const verdict = planFor(real);
    console.log(`\n── plan on ${args.db}: ${verdict.kind.toUpperCase()}`);
    if (verdict.kind === "refuse") {
      for (const r of verdict.reasons) console.log(`  ✗ ${r}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do");
    printPlan(real);

    const rehearsal = await onRehearsalCopy(real, args.scratch, LABEL, rehearse);
    if (rehearsal.length > 0) {
      for (const f of rehearsal) console.log(`  ✗ rehearsal: ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ rehearsed on a copy: every guard holds, and a second run is ALREADY APPLIED");
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm.");

    const before = captureState(real);
    withPreMutationSnapshot(real.db, LABEL, () => apply(real));
    const failures = compareStates(before, captureState(real), verdict.fileOf);
    if (failures.length > 0) {
      throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${LABEL}.db restore point:\n${failures.join("\n")}`);
    }
    console.log(`APPLIED — every guard holds; ${planFor(real).kind === "applied" ? "a second run is ALREADY APPLIED" : "⚠ re-plan is not APPLIED"}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
