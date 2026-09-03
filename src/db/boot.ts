import { getDbBundle } from "./client";
import { dailySnapshotDir, maybeSnapshot } from "./backup";
import { seedDatabase } from "./seed";

/**
 * Server boot sequence: open the database (migrations run on open), seed
 * idempotently, take the daily snapshot. Node-runtime only — loaded via
 * dynamic import from instrumentation.ts so the edge bundle never sees it.
 */
export async function bootDatabase(): Promise<void> {
  // Database and seed failures are fatal — the app is useless without them.
  const bundle = getDbBundle();
  seedDatabase(bundle.db);

  // A failed snapshot must degrade, never prevent boot (review finding).
  // MONEYAPP_SKIP_BACKUP=1 turns it off for the e2e harness so the Settings
  // backup list stays a deterministic empty state across reseeds.
  if (process.env.MONEYAPP_SKIP_BACKUP === "1") return;
  // the real archive belongs to the real database — see dailySnapshotDir
  const dir = dailySnapshotDir(bundle.sqlite.name);
  if (dir === null) {
    process.stderr.write(
      `[moneyapp] daily backup skipped: ${bundle.sqlite.name} is not the real database and MONEYAPP_BACKUPS_DIR is unset\n`,
    );
    return;
  }
  try {
    await maybeSnapshot(bundle.sqlite, dir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[moneyapp] daily backup failed (app continues): ${message}\n`);
  }
}
