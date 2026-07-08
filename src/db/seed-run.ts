/* CLI: pnpm db:seed — idempotent re-seed of taxonomy/institutions/rules/settings. */
import { createDatabase } from "./client";
import { seedDatabase } from "./seed";

const { db, sqlite } = createDatabase();
const summary = seedDatabase(db);
process.stdout.write(`Seeded: ${JSON.stringify(summary)}\n`);
sqlite.close();
