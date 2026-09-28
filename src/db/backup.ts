import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { monthKey, todayIso } from "../lib/dates";
import { createDatabase, type AppDatabase, type DbBundle } from "./client";

/**
 * Snapshots copy the database through SQLite itself — never a raw file copy
 * of a live WAL database (a raw copy misses -wal contents and can corrupt).
 * Two mechanisms, one discipline:
 *   - the daily/monthly archive uses the ASYNC online backup API;
 *   - pre-mutation snapshots use `VACUUM INTO`, its synchronous sibling, so a
 *     synchronous mutation path never has to become async to protect itself.
 * Both write to a uniquely-named temp file then rename, so neither a crash
 * mid-backup nor a concurrent writer can ever leave a plausible-looking
 * partial snapshot. Concurrent calls per backups dir share one in-flight run.
 */

export interface RetentionPolicy {
  keepDaily: number;
  keepMonthly: number;
  keepPreMutation: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepDaily: 14,
  keepMonthly: 6,
  // A rolling window of the last 12 irreversible actions. Sized so the archive
  // stays bounded (~12 x db size) while covering a full working session — the
  // daily snapshot is only ever the floor, never the nearest restore point.
  keepPreMutation: 12,
};

export interface SnapshotResult {
  status: "created" | "skipped";
  dailyPath: string;
  monthlyCreated: boolean;
  pruned: string[];
}

const DAILY_RE = /^daily-(\d{4}-\d{2}-\d{2})\.db$/;
const MONTHLY_RE = /^monthly-(\d{4}-\d{2})\.db$/;
/** pre-<YYYY-MM-DD>T<HHMMSS>-<what-it-preceded>[-n].db */
const PRE_RE = /^pre-\d{4}-\d{2}-\d{2}T\d{6}-[a-z0-9-]+\.db$/;
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
    [PRE_RE, retention.keepPreMutation],
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

/* ------------------------------------------------------------------ *
 * Pre-mutation snapshots
 *
 * The daily snapshot runs once at boot, so without this an un-import at 6pm
 * would roll back to 9am. Every irreversible mutation takes its own restore
 * point first — milliseconds on a 13 MB database, which is cheap next to a
 * day of categorising.
 *
 * FAILURE POLICY: a snapshot that cannot be written ABORTS the mutation (the
 * error propagates; every call site already surfaces it as an action error).
 * These are user-initiated, retryable actions — refusing one is a nuisance,
 * running one unprotected is unrecoverable. The only silent paths are the two
 * that have nothing to protect, and both report themselves in `reason`.
 * ------------------------------------------------------------------ */

export interface PreMutationSnapshotResult {
  status: "created" | "skipped";
  /** Absolute path of the snapshot written, or null when none was. */
  path: string | null;
  /** Why nothing was written — a skip is never silent. */
  reason?: "disabled" | "not-a-file-database";
  pruned: string[];
}

/**
 * The one database an env flag must never be able to leave unprotected.
 * Deliberately NOT defaultDbPath(): that honours MONEYAPP_DB_PATH, and the
 * whole point is to recognise the real database whatever the env says.
 */
function isRealDatabase(sqlite: Database.Database): boolean {
  return isRealDatabasePath(sqlite.name);
}

/**
 * Exported for the write scripts' `--db=<path>` (scripts/db-target.ts), so
 * "which file is the real database" has ONE definition — a rehearsal that
 * mistook the real file for a copy would archive and snapshot as if it were one.
 */
export function isRealDatabasePath(dbPath: string, cwd: string = process.cwd()): boolean {
  return path.resolve(cwd, dbPath) === path.resolve(cwd, "data", "moneyapp.db");
}

/**
 * Where the BOOT-TIME daily snapshot of `dbPath` goes — or null for "take none".
 *
 * 🔴 `data/backups/daily-2026-08-29.db` was the e2e FIXTURE. 1,264 rows, net
 * worth $143,952.43, three hand categorisations — listed on /settings between
 * the owner's real dailies with a Restore button beside it. And because the
 * rotation keeps the newest fourteen by NAME, a fixture stamped a day ahead
 * (the e2e server runs under TZ=Pacific/Kiritimati) sits at the TOP of the
 * rotation and pushes a real daily out a day early, for as long as it stays.
 * Any process that opened another database beside the real one
 * (`MONEYAPP_DB_PATH=data/e2e.db`) without `MONEYAPP_BACKUPS_DIR` inherited
 * the real archive, because the default was a fixed folder rather than a
 * folder that belongs to a database.
 *
 * The rule: the real archive belongs to the real database. Anything else is
 * snapshotted only where an explicit `MONEYAPP_BACKUPS_DIR` says to.
 */
export function dailySnapshotDir(
  dbPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const configured = env.MONEYAPP_BACKUPS_DIR;
  if (configured !== undefined && configured !== "") return configured;
  return isRealDatabasePath(dbPath) ? path.join(process.cwd(), "data", "backups") : null;
}

/**
 * The archive lives beside the database it protects unless one is configured
 * explicitly (the e2e harness points MONEYAPP_BACKUPS_DIR at its own dir). The
 * beside-the-db default is what keeps a unit test's temp database from ever
 * writing into — or pruning — the owner's real archive.
 */
function backupsDirFor(sqlite: Database.Database): string {
  const configured = process.env.MONEYAPP_BACKUPS_DIR;
  if (configured !== undefined && configured !== "") return configured;
  return path.join(path.dirname(sqlite.name), "backups");
}

/** Labels become filenames, so they are reduced to a safe, greppable slug. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "mutation" : slug;
}

function clockStamp(now: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Writes `pre-<date>T<time>-<label>.db` — a human reading the Settings list can
 * tell what the snapshot preceded and when.
 *
 * The prefix is NOT a sort key. `pre-` > `monthly-` > `daily-` lexicographically,
 * so a reverse name sort buries every daily behind every restore point (measured
 * 2026-07-28: all 14 dailies fell outside the page's 8-row window). Ordering is
 * {@link listSnapshots}'s job, by write time across all three kinds.
 */
export function preMutationSnapshot(
  sqlite: Database.Database,
  backupsDir: string,
  label: string,
  now: Date = new Date(),
  retention: RetentionPolicy = DEFAULT_RETENTION,
): PreMutationSnapshotResult {
  // VACUUM cannot run inside a transaction, and a snapshot taken mid-write
  // would not be the pre-mutation state anyway. Loud, because a caller that
  // hits this has put the safety net in the wrong place.
  if (sqlite.inTransaction) {
    throw new Error("Take the pre-mutation snapshot before opening a transaction, not inside one");
  }

  fs.mkdirSync(backupsDir, { recursive: true });
  const base = `pre-${todayIso(now)}T${clockStamp(now)}-${slugify(label)}`;
  let target = path.join(backupsDir, `${base}.db`);
  // Two mutations in the same second: keep both restore points. rename()
  // overwrites silently, so a colliding name must never reach it.
  for (let n = 2; fs.existsSync(target) && n <= 99; n++) {
    target = path.join(backupsDir, `${base}-${n}.db`);
  }
  if (fs.existsSync(target)) throw new Error(`Cannot name a snapshot beside ${base}.db`);

  // unique tmp name: concurrent processes can never interleave writes
  const tmpPath = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    sqlite.prepare("VACUUM INTO ?").run(tmpPath);
    fs.renameSync(tmpPath, target);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  return { status: "created", path: target, pruned: prune(backupsDir, retention, now) };
}

/**
 * drizzle attaches the driver handle as `$client` at runtime; AppDatabase's
 * declared type omits it, so this is the single place that narrows it.
 */
function driverHandle(db: AppDatabase): Database.Database | null {
  const client = (db as unknown as { $client?: unknown }).$client;
  if (typeof client !== "object" || client === null) return null;
  const candidate = client as Partial<Database.Database>;
  return typeof candidate.prepare === "function" && typeof candidate.name === "string"
    ? (client as Database.Database)
    : null;
}

/**
 * Snapshots the database, THEN runs `mutate`. Wrap every irreversible mutation
 * in this: if the restore point cannot be written the mutation never happens.
 */
export function withPreMutationSnapshot<T>(db: AppDatabase, label: string, mutate: () => T): T {
  takeRestorePoint(db, label);
  return mutate();
}

/**
 * The restore point `withPreMutationSnapshot` takes, handed back — for a write
 * that must put the ledger back ITSELF when its own after-check fails
 * (scripts/reread-unrecorded-files.ts restores from `path`). A skip says why.
 */
export function takeRestorePoint(db: AppDatabase, label: string): PreMutationSnapshotResult {
  const sqlite = driverHandle(db);
  if (sqlite === null) {
    throw new Error(
      "Cannot take a pre-mutation snapshot: no better-sqlite3 handle on this database",
    );
  }
  try {
    return snapshotBeforeMutation(sqlite, label);
  } catch (error: unknown) {
    // Say the outcome, not just the cause: the action was REFUSED, not
    // half-applied, so the user knows retrying is safe.
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not save a restore point, so nothing was changed: ${cause}`);
  }
}

/**
 * A snapshot the owner asked for, on the spot. Same mechanism and the same
 * `pre-` namespace as an automatic restore point — which means it also counts
 * against `keepPreMutation`, so the button says so.
 */
export function manualSnapshot(sqlite: Database.Database): PreMutationSnapshotResult {
  return snapshotBeforeMutation(sqlite, "manual-backup");
}

/** The skip rules, kept apart from the writing so both stay readable. */
function snapshotBeforeMutation(
  sqlite: Database.Database,
  label: string,
): PreMutationSnapshotResult {
  // An in-memory database has no file anyone could restore from.
  if (sqlite.memory) {
    return { status: "skipped", path: null, reason: "not-a-file-database", pruned: [] };
  }
  // MONEYAPP_SKIP_BACKUP exists for the e2e harness, which keeps the Settings
  // backup list a deterministic empty state. It is honoured ONLY for a database
  // that is not the real one, so the escape hatch can never be the reason real
  // data is lost — setting it does nothing to data/moneyapp.db.
  if (process.env.MONEYAPP_SKIP_BACKUP === "1" && !isRealDatabase(sqlite)) {
    return { status: "skipped", path: null, reason: "disabled", pruned: [] };
  }
  return preMutationSnapshot(sqlite, backupsDirFor(sqlite), label);
}

/* ------------------------------------------------------------------ *
 * Reading the archive
 *
 * A filename is not a state. "pre-2026-07-23T105800-clarify-peers.db" says when
 * and what it preceded but nothing about the ledger inside it, and the owner has
 * runs of a dozen snapshots differing only in how much of it he had categorised.
 * So every row is summarised FROM THE SNAPSHOT ITSELF, opened read-only.
 *
 * Cost is real — ~35 ms per file on the owner's 13 MB archive — so the reads are
 * memoised on (size, mtime). Snapshots are written to a unique temp name and
 * renamed into place, never edited, so that pair is a complete identity.
 * ------------------------------------------------------------------ */

export type SnapshotKind = "daily" | "monthly" | "restore-point" | "other";

/** What the ledger looked like inside a snapshot. Every field is measured. */
export interface SnapshotState {
  /** active rows — what the ledger screens count */
  transactions: number;
  /** how far the ledger ran; null when the snapshot has no transactions */
  latestTransactionOn: string | null;
  /** net worth on {@link netWorthOn}; null when no account has coverage */
  netWorthCents: number | null;
  /** the day the net-worth figure is for */
  netWorthOn: string | null;
  coveredAccounts: number;
  activeAccounts: number;
  /** rows categorised by hand — the axis his restore points actually differ on */
  userCategorized: number;
}

export interface SnapshotSummary {
  name: string;
  kind: SnapshotKind;
  /** what an automatic restore point preceded ("clarify peers"), else null */
  label: string | null;
  /** both null when the file could not be stat'd */
  sizeBytes: number | null;
  takenAtMs: number | null;
  /** whether {@link RetentionPolicy} rotates this file, or it is kept forever */
  governedByRetention: boolean;
  state: SnapshotState | null;
  /** why {@link state} is null — never a silent blank */
  unreadable: string | null;
}

export interface SnapshotListing {
  /** newest first, capped at the requested limit */
  snapshots: SnapshotSummary[];
  /** every `.db` file in the archive, including the ones past the cap */
  totalFiles: number;
  /** `.db-wal`/`.db-shm` siblings left beside raw copies — NOT rotated */
  sidecarFiles: number;
  /** files present that no retention rule will ever prune */
  ungovernedFiles: number;
  /** bytes of everything in the directory, sidecars included */
  totalBytes: number;
}

/** The page window: enough for 14 dailies plus a working session of restore points. */
export const SNAPSHOT_LIST_LIMIT = 24;
const SIDECAR_RE = /\.db-(wal|shm)$/;
/** legacy script snapshots: `pre-<label>-<YYYY-MM-DD>.db`, `pre-<label>-<8>-<6>.db` */
const LEGACY_PRE_RE = /^pre-(.+?)-(?:\d{4}-\d{2}-\d{2}|\d{8}-\d{6})\.db$/;
const PRE_LABEL_RE = /^pre-\d{4}-\d{2}-\d{2}T\d{6}-(.+)\.db$/;

/**
 * What a file in the archive is, from its name alone.
 *
 * `governedByRetention` is the honest half: only the three names {@link prune}
 * recognises are rotated. The owner's archive also holds script-written
 * snapshots under an older `pre-<label>-<date>` shape and `-wal`/`-shm` siblings
 * beside the raw-copied ones — none of which any keep-N count has ever touched,
 * so the page must not claim otherwise.
 */
export function classifySnapshot(name: string): Pick<
  SnapshotSummary,
  "kind" | "label" | "governedByRetention"
> {
  const daily = DAILY_RE.exec(name);
  if (daily) return { kind: "daily", label: daily[1]!, governedByRetention: true };
  const monthly = MONTHLY_RE.exec(name);
  if (monthly) return { kind: "monthly", label: monthly[1]!, governedByRetention: true };
  if (PRE_RE.test(name)) {
    const label = PRE_LABEL_RE.exec(name)?.[1] ?? null;
    return { kind: "restore-point", label: readableLabel(label), governedByRetention: true };
  }
  // anything else that still looks like a restore point — kept, never rotated
  if (name.startsWith("pre-")) {
    const legacy = LEGACY_PRE_RE.exec(name);
    return {
      kind: "restore-point",
      label: readableLabel(legacy?.[1] ?? null),
      governedByRetention: false,
    };
  }
  return { kind: "other", label: null, governedByRetention: false };
}

function readableLabel(slug: string | null): string | null {
  if (slug === null || slug === "") return null;
  return slug.replace(/-/g, " ");
}

const STATE_SQL = `
  SELECT COUNT(*) AS transactions,
         MAX(posted_on) AS latest,
         SUM(CASE WHEN categorization_source = 'user' THEN 1 ELSE 0 END) AS userCategorized
    FROM transactions
   WHERE status = 'active'`;

/**
 * Net worth on one day, the way the net-worth series reads it: each active
 * account's most recent NON-GAP daily balance at or before the day, summed
 * (balances are net-worth-signed, so liabilities subtract themselves).
 *
 * daily_balances is a derived cache, not truth — but it is the cache the app
 * itself renders from, so a snapshot summarised through it states the number
 * that snapshot would put on the dashboard. Re-deriving would mean WRITING to a
 * backup, the one thing reading a backup must never do.
 */
const NET_WORTH_SQL = `
  SELECT COALESCE(SUM(b.balance_cents), 0) AS cents, COUNT(*) AS covered
    FROM accounts a
    JOIN daily_balances b
      ON b.account_id = a.id
     AND b.day = (SELECT MAX(d.day) FROM daily_balances d
                   WHERE d.account_id = a.id AND d.day <= ? AND d.basis <> 'gap')
   WHERE a.is_active = 1`;

/**
 * Opens a snapshot READ-ONLY and measures it.
 *
 * The database file is never written: the connection is SQLITE_OPEN_READONLY, so
 * a `-wal` sibling is read (its committed pages belong to the snapshot and must
 * be counted) but never checkpointed back.
 *
 * The DIRECTORY needs the same care and does not get it for free. Snapshots
 * inherit journal_mode=wal, and SQLite cannot read a WAL database without
 * building its `-shm` index — which a read-only connection has no authority to
 * clean up. Left alone, every render of the Settings page sprinkled a
 * `-wal`/`-shm` pair beside every snapshot (measured: 46 snapshots, 92 new
 * files, and a retention note counting its own litter). So anything this open
 * created is removed again; anything already there — a raw copy's real `-wal`
 * holds committed pages — is left exactly as found.
 *
 * Throws when the file is not a readable database of a recognisable shape —
 * callers turn that into a row that says so rather than a page that dies.
 */
export function readSnapshotState(filePath: string): SnapshotState {
  const ours = ["-wal", "-shm"].filter((suffix) => !fs.existsSync(`${filePath}${suffix}`));
  const sqlite = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const totals = sqlite.prepare(STATE_SQL).get() as {
      transactions: number;
      latest: string | null;
      userCategorized: number | null;
    };
    const { active } = sqlite
      .prepare("SELECT COUNT(*) AS active FROM accounts WHERE is_active = 1")
      .get() as { active: number };
    // no transactions is a real state (the first monthly copy is one) — fall
    // back to the last day the balance cache knows about rather than blanking
    const fallback = sqlite.prepare("SELECT MAX(day) AS day FROM daily_balances").get() as {
      day: string | null;
    };
    const asOf = totals.latest ?? fallback.day;
    const netWorth =
      asOf === null
        ? null
        : (sqlite.prepare(NET_WORTH_SQL).get(asOf) as { cents: number; covered: number });
    return {
      transactions: totals.transactions,
      latestTransactionOn: totals.latest,
      // "no account had coverage" is not "$0" — say nothing rather than a wrong number
      netWorthCents: netWorth === null || netWorth.covered === 0 ? null : netWorth.cents,
      netWorthOn: netWorth === null || netWorth.covered === 0 ? null : asOf,
      coveredAccounts: netWorth?.covered ?? 0,
      activeAccounts: active,
      userCategorized: totals.userCategorized ?? 0,
    };
  } finally {
    sqlite.close();
    for (const suffix of ours) {
      const sidecar = `${filePath}${suffix}`;
      try {
        // a read-only connection cannot have put pages in a WAL; the size check
        // is the belt to that braces, so a real one is never mistaken for ours
        if (suffix === "-shm" || fs.statSync(sidecar).size === 0) {
          fs.rmSync(sidecar, { force: true });
        }
      } catch {
        // already gone, or never created — either way the directory is clean
      }
    }
  }
}

interface CacheEntry {
  identity: string;
  state: SnapshotState | null;
  unreadable: string | null;
}

const stateCache = new Map<string, CacheEntry>();

/** Test seam — the archive is process-global, so a test that writes must reset. */
export function clearSnapshotStateCache(): void {
  stateCache.clear();
}

function summarize(dir: string, name: string): SnapshotSummary {
  const full = path.join(dir, name);
  const base: SnapshotSummary = {
    name,
    ...classifySnapshot(name),
    sizeBytes: null,
    takenAtMs: null,
    state: null,
    unreadable: null,
  };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch (error: unknown) {
    // ONE unreadable file used to take the whole Settings page down with it.
    return { ...base, unreadable: messageOf(error, "could not be read") };
  }

  const identity = `${stat.size}:${stat.mtimeMs}`;
  let entry = stateCache.get(full);
  if (entry === undefined || entry.identity !== identity) {
    try {
      entry = { identity, state: readSnapshotState(full), unreadable: null };
    } catch (error: unknown) {
      entry = { identity, state: null, unreadable: messageOf(error, "is not a readable snapshot") };
    }
    stateCache.set(full, entry);
  }
  return {
    ...base,
    sizeBytes: stat.size,
    takenAtMs: stat.mtimeMs,
    state: entry.state,
    unreadable: entry.unreadable,
  };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

/**
 * The archive, newest first, each row summarised from inside the file.
 *
 * Ordering is by WRITE TIME, not by name: the naming shapes sort against each
 * other lexicographically in an order with nothing to do with age (see
 * {@link preMutationSnapshot}), and legacy script snapshots encode their date in
 * a fourth place again. mtime is the one thing every file has, and it is exactly
 * the question being asked — which state is most recent.
 */
export function listSnapshots(
  backupsDir: string,
  limit: number = SNAPSHOT_LIST_LIMIT,
): SnapshotListing {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupsDir);
  } catch {
    // no archive yet is a normal first-run state, not an error
    return { snapshots: [], totalFiles: 0, sidecarFiles: 0, ungovernedFiles: 0, totalBytes: 0 };
  }

  const files = entries.filter((name) => name.endsWith(".db"));
  const summaries = files
    .map((name) => summarize(backupsDir, name))
    .sort(
      (a, b) =>
        (b.takenAtMs ?? Number.NEGATIVE_INFINITY) - (a.takenAtMs ?? Number.NEGATIVE_INFINITY) ||
        b.name.localeCompare(a.name),
    );

  let totalBytes = 0;
  for (const name of entries) {
    try {
      totalBytes += fs.statSync(path.join(backupsDir, name)).size;
    } catch {
      // counted as zero rather than failing the listing over one bad entry
    }
  }

  return {
    snapshots: summaries.slice(0, Math.max(0, limit)),
    totalFiles: files.length,
    sidecarFiles: entries.filter((name) => SIDECAR_RE.test(name)).length,
    ungovernedFiles: summaries.filter((s) => !s.governedByRetention).length,
    totalBytes,
  };
}

/* ------------------------------------------------------------------ *
 * Restore
 *
 * THE DANGEROUS ONE. The server holds an open handle to the live database, so
 * the naive implementation — copy the snapshot over data/moneyapp.db — is a
 * ledger-shredder: rename() swaps the directory entry while SQLite keeps reading
 * the old inode, and the live `-wal`/`-shm` (which ARE looked up by path) end up
 * paired with a database they were never written for.
 *
 * Considered and rejected: a logical restore — ATTACH the snapshot, delete every
 * table, re-INSERT inside one transaction. It never touches the handle and rolls
 * back cleanly, but it can only restore a snapshot whose schema already matches,
 * and measured on the owner's archive 34 of 46 are one to three migrations
 * behind — three quarters of his restore points, unusable.
 *
 * So the file IS replaced, in an order where every window is survivable:
 *
 *   1. STAGE first — copy the snapshot (and its `-wal`) beside the live
 *      database, fold the WAL in, integrity-check it. Nothing has moved yet, so
 *      a corrupt or missing snapshot fails here with the ledger untouched.
 *      Staging before step 2 also matters because step 2 prunes: the snapshot
 *      being restored can be the one rotation is about to delete.
 *   2. SNAPSHOT the current state, through the same VACUUM INTO every other
 *      irreversible action uses. Restoring is itself undoable.
 *   3. CHECKPOINT(TRUNCATE) the live database so all of it is in the one file
 *      and its `-wal` is empty — a crash between the rename and the sibling
 *      cleanup then finds a zero-length WAL, which is harmless, instead of one
 *      belonging to the file that just got replaced.
 *   4. CLOSE. better-sqlite3 refuses while a query is running, and it refuses
 *      before anything has moved, so that failure is a clean abort too.
 *   5. RENAME (atomic, same filesystem) and drop the meaningless siblings.
 *   6. REOPEN. createDatabase() migrates on open, which is what carries an older
 *      snapshot forward — and it happens here, inside the action, so a snapshot
 *      that cannot be migrated is reported, not discovered on the next paint.
 *
 * What this cannot protect: a request already mid-render holds the closed handle
 * and fails once. Local single-user app, explicitly typed confirmation; a reload
 * fixes it and nothing is corrupted.
 * ------------------------------------------------------------------ */

export interface RestoreResult {
  /** file the ledger now holds */
  restoredFrom: string;
  /** the state from BEFORE the restore, so this is reversible; null when skipped */
  preRestorePath: string | null;
  transactionsBefore: number | null;
  transactionsAfter: number | null;
  /**
   * The connection now serving the restored file. Installed in client.ts's
   * globalThis cache when the closed bundle was the cached one; handed back so
   * a caller that owns its own bundle (a test) can close it. NOT serializable —
   * a server action must map this result, never return it.
   */
  reopened: DbBundle;
}

/**
 * Resolves a snapshot NAME (never a path) against the archive.
 *
 * The name arrives from the browser, so it is confined to the archive: anything
 * resolving elsewhere — `../`, an absolute path, a nested segment — is refused
 * rather than sanitised into something plausible.
 */
export function resolveSnapshotPath(backupsDir: string, name: string): string {
  const dir = path.resolve(backupsDir);
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== dir || path.basename(full) !== name || name.trim() === "") {
    throw new Error("That is not a snapshot in the backups folder");
  }
  if (!name.endsWith(".db")) throw new Error("Only .db snapshots can be used");
  return full;
}

/**
 * client.ts caches the open bundle on globalThis so Next's hot-reload cannot
 * accumulate connections. A restore closes that connection, so the cache must be
 * replaced in the same breath or every later getDb() hands out a dead handle.
 * The only place outside client.ts that touches the key, deliberately:
 * invalidating the cache belongs to whoever invalidated the connection.
 */
function recacheBundle(previous: DbBundle, next: DbBundle | null): void {
  const g = globalThis as { __moneyappDb?: DbBundle };
  if (g.__moneyappDb !== previous) return; // someone else's bundle — leave it alone
  if (next === null) delete g.__moneyappDb;
  else g.__moneyappDb = next;
}

function countTransactions(sqlite: Database.Database): number | null {
  try {
    return (
      sqlite.prepare("SELECT COUNT(*) AS c FROM transactions WHERE status = 'active'").get() as {
        c: number;
      }
    ).c;
  } catch {
    return null; // an older snapshot may not have the column; the count is decoration
  }
}

/** Copy a snapshot beside the live database and make it self-contained. */
function stageSnapshot(snapshotPath: string, stagedPath: string): number | null {
  fs.copyFileSync(snapshotPath, stagedPath);
  // A raw-copied snapshot carries committed pages in its -wal; dropping it
  // would silently restore an OLDER state than the file represents.
  if (fs.existsSync(`${snapshotPath}-wal`)) {
    fs.copyFileSync(`${snapshotPath}-wal`, `${stagedPath}-wal`);
  }
  const staged = new Database(stagedPath);
  try {
    staged.pragma("journal_mode = DELETE"); // folds the WAL in, then removes it
    const integrity = staged.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`that snapshot failed its integrity check (${String(integrity)})`);
    }
    return countTransactions(staged);
  } finally {
    staged.close();
  }
}

function removeStaged(stagedPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${stagedPath}${suffix}`, { force: true });
  }
}

/**
 * Replaces the live ledger with a snapshot and reopens it. See the block above
 * for why each step is where it is — the ordering IS the safety.
 */
export function restoreFromSnapshot(bundle: DbBundle, snapshotPath: string): RestoreResult {
  const { sqlite } = bundle;
  const dbPath = sqlite.name;
  if (sqlite.memory) throw new Error("This database lives in memory — there is no file to replace");
  if (sqlite.inTransaction) throw new Error("A write is in progress — try again in a moment");
  if (path.resolve(snapshotPath) === path.resolve(dbPath)) {
    throw new Error("That is the live database, not a snapshot of it");
  }
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`No snapshot named ${path.basename(snapshotPath)} — the list may be stale`);
  }

  const transactionsBefore = countTransactions(sqlite);
  const stagedPath = `${dbPath}.restore-${process.pid}-${randomUUID()}.tmp`;
  let transactionsAfter: number | null;
  let preRestorePath: string | null;
  try {
    // 1 — verify the replacement before anything is at risk
    transactionsAfter = stageSnapshot(snapshotPath, stagedPath);
    // 2 — the undo, taken while the handle is still open (and before rotation,
    //     which is why staging came first)
    preRestorePath = snapshotBeforeMutation(sqlite, "restore").path;
    // 3 + 4 — leave one self-contained file behind, then let go of it
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.close();
  } catch (error: unknown) {
    removeStaged(stagedPath);
    // Every throw above happens before the swap: the ledger is exactly as it was.
    throw new Error(`Nothing was restored and nothing was changed: ${messageOf(error, "unknown")}`);
  }

  // 5 — past this line the connection is gone, so the cache must not survive
  //     the function whatever happens next
  try {
    fs.renameSync(stagedPath, dbPath);
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  } catch (error: unknown) {
    removeStaged(stagedPath);
    recacheBundle(bundle, null); // the untouched file reopens on the next getDb()
    throw new Error(`Could not replace the database file: ${messageOf(error, "unknown")}`);
  }

  // 6 — reopen; migrations run here, carrying an older snapshot forward
  let reopened: DbBundle;
  try {
    reopened = createDatabase(dbPath);
  } catch (error: unknown) {
    recacheBundle(bundle, null);
    const saved =
      preRestorePath === null ? "" : ` The state from before is ${path.basename(preRestorePath)}.`;
    throw new Error(
      `Restored ${path.basename(snapshotPath)}, but it would not reopen: ${messageOf(error, "unknown")}.${saved}`,
    );
  }
  recacheBundle(bundle, reopened);

  return {
    restoredFrom: path.basename(snapshotPath),
    preRestorePath,
    transactionsBefore,
    transactionsAfter,
    reopened,
  };
}
