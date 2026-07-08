import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { monthKey, todayIso } from "../lib/dates";

/**
 * Snapshots use better-sqlite3's online backup API — never a raw file copy
 * of a live WAL database (a raw copy misses -wal contents and can corrupt).
 * Written to a uniquely-named temp file then renamed, so neither a crash
 * mid-backup nor a concurrent writer can ever leave a plausible-looking
 * partial snapshot. Concurrent calls per backups dir share one in-flight run.
 */

export interface RetentionPolicy {
  keepDaily: number;
  keepMonthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepDaily: 14, keepMonthly: 6 };

export interface SnapshotResult {
  status: "created" | "skipped";
  dailyPath: string;
  monthlyCreated: boolean;
  pruned: string[];
}

const DAILY_RE = /^daily-(\d{4}-\d{2}-\d{2})\.db$/;
const MONTHLY_RE = /^monthly-(\d{4}-\d{2})\.db$/;
const TMP_RE = /\.tmp$/;
const STALE_TMP_MS = 60 * 60 * 1000;

const inFlight = new Map<string, Promise<SnapshotResult>>();

/** Takes today's snapshot if it doesn't exist yet; maintains monthly copies and rotation. */
export function maybeSnapshot(
  sqlite: Database.Database,
  backupsDir: string,
  now: Date = new Date(),
  retention: RetentionPolicy = DEFAULT_RETENTION,
): Promise<SnapshotResult> {
  const existing = inFlight.get(backupsDir);
  if (existing) return existing;
  const run = snapshotOnce(sqlite, backupsDir, now, retention).finally(() => {
    inFlight.delete(backupsDir);
  });
  inFlight.set(backupsDir, run);
  return run;
}

async function snapshotOnce(
  sqlite: Database.Database,
  backupsDir: string,
  now: Date,
  retention: RetentionPolicy,
): Promise<SnapshotResult> {
  fs.mkdirSync(backupsDir, { recursive: true });
  const today = todayIso(now);
  const dailyPath = path.join(backupsDir, `daily-${today}.db`);
  const monthlyPath = path.join(backupsDir, `monthly-${monthKey(today)}.db`);

  let status: SnapshotResult["status"] = "skipped";
  if (!fs.existsSync(dailyPath)) {
    // unique tmp name: concurrent processes can never interleave writes
    const tmpPath = `${dailyPath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await sqlite.backup(tmpPath);
      if (fs.existsSync(dailyPath)) {
        // another process finished first — its snapshot is equally valid
        status = "skipped";
      } else {
        fs.renameSync(tmpPath, dailyPath);
        status = "created";
      }
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  }

  let monthlyCreated = false;
  if (fs.existsSync(dailyPath) && !fs.existsSync(monthlyPath)) {
    fs.copyFileSync(dailyPath, monthlyPath);
    monthlyCreated = true;
  }

  const pruned = prune(backupsDir, retention, now);
  return { status, dailyPath, monthlyCreated, pruned };
}

function prune(backupsDir: string, retention: RetentionPolicy, now: Date): string[] {
  const entries = fs.readdirSync(backupsDir);
  const pruned: string[] = [];
  for (const [re, keep] of [
    [DAILY_RE, retention.keepDaily],
    [MONTHLY_RE, retention.keepMonthly],
  ] as const) {
    const matching = entries
      .filter((name) => re.test(name))
      .sort()
      .reverse(); // lexicographic date order: newest first
    for (const name of matching.slice(keep)) {
      fs.rmSync(path.join(backupsDir, name), { force: true });
      pruned.push(name);
    }
  }
  // stale tmp files from hard crashes (unique names, so >1h old means dead)
  for (const name of entries.filter((n) => TMP_RE.test(n))) {
    const fullPath = path.join(backupsDir, name);
    try {
      if (now.getTime() - fs.statSync(fullPath).mtimeMs > STALE_TMP_MS) {
        fs.rmSync(fullPath, { force: true });
        pruned.push(name);
      }
    } catch {
      // already gone — a concurrent run cleaned it
    }
  }
  return pruned;
}
