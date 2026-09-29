/**
 * What every guarded real-DB script shares: `--db` is required and must
 * exist, a dry run is the default, and the write is rehearsed on a throwaway
 * `.backup` copy — in `--scratch=<dir>`, default the OS temp directory —
 * before `--confirm` lets it touch the ledger.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, type DbBundle } from "@/db/client";

export interface GuardedArgs {
  db: string;
  confirm: boolean;
  scratch: string;
  /** the value of `--name=value`, or null when the flag is absent */
  value: (name: string) => string | null;
}

export function parseGuardedArgs(argv: readonly string[]): GuardedArgs {
  const value = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const db = value("db");
  if (db === null) throw new Error("--db=<path> is required");
  // createDatabase would create an empty ledger at a mistyped path
  if (!fs.existsSync(db)) throw new Error(`No database at ${db}`);
  return { db, confirm: argv.includes("--confirm"), scratch: value("scratch") ?? os.tmpdir(), value };
}

/**
 * Runs `fn` on a `.backup` copy of `real`, then deletes the copy and its WAL files. `fn` may be async (an import is):
 * the copy is closed only once it settles — returned un-awaited, the `finally` closed it under a running import.
 */
export async function onRehearsalCopy<T>(
  real: DbBundle,
  scratch: string,
  label: string,
  fn: (copy: DbBundle) => T | Promise<T>,
): Promise<T> {
  const copyPath = path.join(scratch, `${label}-rehearsal-${process.pid}-${Date.now()}.db`);
  await real.sqlite.backup(copyPath);
  const copy = createDatabase(copyPath);
  try {
    return await fn(copy);
  } finally {
    copy.sqlite.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${copyPath}${suffix}`, { force: true });
  }
}

export function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Every `daily_balances` row, hashed: a link-only write must leave it identical. */
export function balancesHash(bundle: DbBundle): string {
  return sha256Json(bundle.sqlite.prepare("SELECT * FROM daily_balances ORDER BY account_id, day").all());
}

export function statusCounts(bundle: DbBundle): string {
  return JSON.stringify(bundle.sqlite.prepare("SELECT status, count(*) AS n FROM transactions GROUP BY status ORDER BY status").all());
}

/** Keys whose values differ between two snapshots, sorted. */
export function changedKeys(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
}
