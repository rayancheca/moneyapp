import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DbBundle {
  sqlite: Database.Database;
  db: AppDatabase;
}

export function defaultDbPath(): string {
  return process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
}

/**
 * Backups live beside the db by default; MONEYAPP_BACKUPS_DIR relocates them so
 * the e2e harness never reads (or pollutes) the real archive — the Settings
 * page lists this dir, so a shared one makes the settings baseline drift every
 * time a backup lands.
 */
export function defaultBackupsDir(): string {
  return process.env.MONEYAPP_BACKUPS_DIR ?? path.join(process.cwd(), "data", "backups");
}

export function defaultMigrationsFolder(): string {
  return path.join(process.cwd(), "src", "db", "migrations");
}

/** Opens (creating if needed) a database with WAL + FK enforcement and runs migrations. */
export function createDatabase(
  dbPath: string = defaultDbPath(),
  migrationsFolder: string = defaultMigrationsFolder(),
): DbBundle {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    return { sqlite, db };
  } catch (error: unknown) {
    sqlite.close(); // never leak the handle when migration fails
    throw error;
  }
}

// Next.js dev hot-reload re-evaluates modules — the connection must be a
// globalThis-cached singleton or connections accumulate.
const g = globalThis as unknown as { __moneyappDb?: DbBundle };

/**
 * Because the bundle above survives hot reload, createDatabase() — and so
 * migrate() — runs once per SERVER PROCESS, not once per edit. Generating a
 * migration while `next dev` is running therefore leaves the live server on the
 * old schema until somebody restarts it, and the symptom arrives much later and
 * far from the cause: a bare "no such table: price_intraday" on whichever page
 * touches the new table first. (Measured: that cost a full day.)
 *
 * Applying on open is already this module's contract, so applying after a
 * hot reload is the same contract, not a new behaviour. Dev only — a production
 * server boots into its own current code and migrates there.
 */
function applyPendingMigrations(bundle: DbBundle): void {
  const migrationsFolder = defaultMigrationsFolder();
  let newestOnDisk: number;
  let newestApplied: number;
  try {
    const journal = fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
    const entries = (JSON.parse(journal) as { entries: { when: number }[] }).entries;
    if (entries.length === 0) return;
    newestOnDisk = Math.max(...entries.map((e) => e.when));
    // Must be drizzle's OWN predicate, not a count: its migrator applies a file
    // only when the newest applied created_at is older than that file's
    // timestamp. Counting instead disagrees in both directions — a journal
    // entry stamped older than the watermark makes the count trail forever
    // while migrate() correctly applies nothing (so this would re-run it, and
    // open a write transaction, on every single call), and a migration swapped
    // for a differently-stamped one across a branch or worktree keeps the count
    // equal while a real migration is pending. This repo hand-edits the journal
    // (entry 4 is an exactly-round `when`) and uses worktrees, so both are live.
    newestApplied = Number(
      (bundle.sqlite.prepare("SELECT max(created_at) AS t FROM __drizzle_migrations").get() as { t: number | null })
        .t ?? 0,
    );
  } catch {
    return; // no journal, or never migrated — createDatabase() owns that path
  }
  if (newestApplied >= newestOnDisk) return;
  try {
    migrate(bundle.db, { migrationsFolder });
  } catch (error: unknown) {
    // Never take down every page over this. Two processes can both see the
    // same pending migration, both decide to apply, then serialize — the loser
    // hits "table already exists", which is not a reason to 500 a request that
    // has nothing to do with the new table. Let the original, specific
    // "no such table" surface instead if the schema really is behind.
    console.error("[db] pending migration did not apply — restart the dev server:", error);
  }
}

export function getDbBundle(): DbBundle {
  g.__moneyappDb ??= createDatabase();
  return g.__moneyappDb;
}

// Runs at module evaluation, which in dev is exactly once per hot reload — the
// only moment a new migration file can appear while the process lives. Doing it
// here rather than inside getDbBundle() keeps fs + JSON.parse out of every
// request while still catching the case createDatabase() cannot: a connection
// opened before the migration existed.
if (process.env.NODE_ENV !== "production" && g.__moneyappDb) {
  applyPendingMigrations(g.__moneyappDb);
}

export function getDb(): AppDatabase {
  return getDbBundle().db;
}
