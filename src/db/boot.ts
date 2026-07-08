import path from "node:path";
import { getDbBundle } from "./client";
import { maybeSnapshot } from "./backup";
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
  try {
    await maybeSnapshot(bundle.sqlite, path.join(process.cwd(), "data", "backups"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[moneyapp] daily backup failed (app continues): ${message}\n`);
  }
}
