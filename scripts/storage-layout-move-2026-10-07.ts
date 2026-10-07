/**
 * REAL-DISK + REAL-DB WRITE — the owner's answer to §6A 53 of 2026-10-07: run the storage-layout tidy-up
 * (`migrateStorageLayout(db, { move: true })`), guarded. It moves statement ORIGINALS between folders of
 * `data/statements/` and repoints `import_files.storage_path`; no money, row, balance or anchor moves.
 *
 * Measured on a fresh copy, 2026-10-07 (nothing moved): 31 originals named by 55 reads — 24 robinhood-cash/ →
 * robinhood-combined/ (48 retired reads; 2 already there byte-identical, so the move drops the duplicate),
 * 5 capital-one-venturex-4147/ → capital-one-venturex-4208/, 2 robinhood-brokerage-3525/ → robinhood-cash/;
 * 0 unplaced; 276 of 307 already in place.
 *
 * ## The runbook — from the main checkout, with the dev server stopped
 *
 *   pnpm tsx scripts/storage-layout-move-2026-10-07.ts --db=data/moneyapp.db             # dry run: the moves
 *   pnpm tsx scripts/storage-layout-move-2026-10-07.ts --db=data/moneyapp.db --confirm   # manifest, restore point, move
 *   pnpm tsx scripts/storage-layout-move-2026-10-07.ts --db=data/moneyapp.db             # NOTHING TO MOVE
 *   pnpm ledger-check
 *
 * ⛔ Before a file moves, a manifest — every move's from, to and the bytes' sha256 — is written to
 * `data/backups/storage-move-<stamp>.json`, beside the ledger's own restore point. Putting a file back is copying `to`
 * to `from`; restoring the ledger file puts the paths back. After the move every `storage_path` in the ledger must name
 * a file on disk, and every moved file must hash as it did before; anything else throws, naming both.
 *
 * ⛔ Refused when the dry run's plan is not what was measured (any original unplaced, a destination holding OTHER bytes
 * under the same name, a source missing): the tidy-up never decides anything the measurement did not.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { takeRestorePoint } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { migrateStorageLayout, type StorageMigration } from "@/services/import/service";
import { parseGuardedArgs } from "./guarded-write-harness";

const LABEL = "storage-layout-move";

interface Move {
  from: string;
  to: string;
  sha256: string;
  reads: number;
  /** the destination already holds these bytes: the move only drops the source */
  duplicate: boolean;
}

const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The moves a dry run plans, one per original, and why any would be refused. */
function plan(results: readonly StorageMigration[]): { moves: Move[]; refusals: string[] } {
  const byFrom = new Map<string, { to: string | null; reads: number }>();
  for (const r of results) {
    const e = byFrom.get(r.from) ?? { to: r.to, reads: 0 };
    byFrom.set(r.from, { to: e.to, reads: e.reads + 1 });
  }
  const moves: Move[] = [];
  const refusals: string[] = [];
  for (const [from, { to, reads }] of byFrom) {
    if (to === null) {
      refusals.push(`${from}: no folder resolves for it — unplaced`);
      continue;
    }
    if (!fs.existsSync(from)) {
      refusals.push(`${from}: the source is not on disk`);
      continue;
    }
    const bytes = sha(from);
    const duplicate = fs.existsSync(to);
    if (duplicate && sha(to) !== bytes) {
      refusals.push(`${to}: already holds OTHER bytes than ${from}`);
      continue;
    }
    moves.push({ from, to, sha256: bytes, reads, duplicate });
  }
  return { moves, refusals };
}

function summarise(moves: readonly Move[]): void {
  const folder = (p: string) => path.basename(path.dirname(p));
  const pairs = new Map<string, { files: number; reads: number; duplicates: number }>();
  for (const m of moves) {
    const key = `${folder(m.from)}/ → ${folder(m.to)}/`;
    const p = pairs.get(key) ?? { files: 0, reads: 0, duplicates: 0 };
    pairs.set(key, { files: p.files + 1, reads: p.reads + m.reads, duplicates: p.duplicates + (m.duplicate ? 1 : 0) });
  }
  for (const [key, p] of [...pairs].sort()) {
    const dup = p.duplicates > 0 ? `, ${p.duplicates} already there byte-identical` : "";
    console.log(`  ${key}  ${p.files} original(s), ${p.reads} read(s)${dup}`);
  }
}

function main(): void {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const { moves, refusals } = plan(migrateStorageLayout(real.db, { move: false }));
    console.log(`\n── plan on ${args.db}: ${refusals.length > 0 ? "REFUSE" : moves.length === 0 ? "NOTHING TO MOVE" : "PLAN"}`);
    summarise(moves);
    if (refusals.length > 0) {
      for (const r of refusals) console.log(`  ✗ ${r}`);
      process.exitCode = 1;
      return;
    }
    if (moves.length === 0) return;
    console.log(`  ${moves.length} original(s), ${moves.reduce((s, m) => s + m.reads, 0)} read(s); no money, row or balance moves`);
    if (!args.confirm) return void console.log("DRY RUN — nothing moved. Re-run with --confirm, with the dev server stopped.");

    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const backups = path.join(path.dirname(path.resolve(args.db)), "backups");
    fs.mkdirSync(backups, { recursive: true });
    const manifest = path.join(backups, `storage-move-${stamp}.json`);
    fs.writeFileSync(manifest, JSON.stringify({ db: path.resolve(args.db), moves }, null, 1));
    const restore = takeRestorePoint(real.db, LABEL);
    if (restore.status !== "created") throw new Error(`no restore point (${restore.reason ?? "skipped"}) — nothing moved`);
    console.log(`  manifest ${manifest}`);
    console.log(`  restore point ${restore.path}`);

    migrateStorageLayout(real.db, { move: true });

    const failures: string[] = [];
    for (const m of moves) {
      if (!fs.existsSync(m.to)) failures.push(`${m.to}: not on disk after the move`);
      else if (sha(m.to) !== m.sha256) failures.push(`${m.to}: bytes differ from ${m.from}'s`);
    }
    const paths = real.sqlite.prepare("SELECT DISTINCT storage_path AS p FROM import_files").all() as { p: string }[];
    for (const { p } of paths) if (!fs.existsSync(p)) failures.push(`storage_path ${p}: no file there`);
    if (failures.length > 0) {
      throw new Error(`MOVED, and a guard failed — put files back from ${manifest} and restore the ledger:\n${failures.join("\n")}`);
    }
    const again = plan(migrateStorageLayout(real.db, { move: false }));
    console.log(`MOVED — every moved file hashes as before and every stored path names a file; a second run: ${again.moves.length === 0 && again.refusals.length === 0 ? "NOTHING TO MOVE" : `⚠ ${again.moves.length} move(s), ${again.refusals.length} refusal(s)`}`);
  } finally {
    real.sqlite.close();
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
