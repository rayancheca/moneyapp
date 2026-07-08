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

export function getDbBundle(): DbBundle {
  g.__moneyappDb ??= createDatabase();
  return g.__moneyappDb;
}

export function getDb(): AppDatabase {
  return getDbBundle().db;
}
