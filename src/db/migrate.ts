/* CLI: pnpm db:migrate — opens the database (running migrations) and seeds. */
import { createDatabase, defaultDbPath } from "./client";
import { seedDatabase } from "./seed";

const { db, sqlite } = createDatabase();
const summary = seedDatabase(db);
process.stdout.write(
  `Migrated ${defaultDbPath()} — seeded: ${JSON.stringify(summary)}\n`,
);
sqlite.close();
