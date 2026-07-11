import fs from "node:fs";
import path from "node:path";
import { E2E_FAKE_TODAY, seedE2eDatabase } from "./seed-helpers";

/**
 * E2E runs against a dedicated, freshly-built database — never dev data.
 * The base is seeded through the REAL import pipeline (fixture set A, see
 * seed-helpers.ts) so visual/a11y/interaction specs see populated pages;
 * capital-one (set B) stays reserved for zz-golden-path's upload flow.
 * The clock is pinned to E2E_FAKE_TODAY here AND in playwright.config.ts's
 * webServer command so seed-time derivation and server renders agree.
 */
export default async function globalSetup(): Promise<void> {
  const dbPath = path.join(process.cwd(), "data", "e2e.db");
  // NB: the db file is deliberately NOT unlinked — seedE2eDatabase wipes its
  // data in place so the webServer's open connection keeps the same inode and
  // reads this run's seed (see resetAllData). Deleting the file here would
  // strand the server on the previous run's data.
  // originals archived by the import pipeline follow the database: the e2e
  // harness must NEVER write into data/originals, where the user's REAL
  // statement originals live. Wiped like the db — droppings are not state.
  const originalsDir = path.join(process.cwd(), "data", "e2e-originals");
  fs.rmSync(originalsDir, { recursive: true, force: true });
  // Settings lists the backups dir; a dedicated (empty) one keeps that list a
  // deterministic empty state and out of the user's real backup archive.
  const backupsDir = path.join(process.cwd(), "data", "e2e-backups");
  fs.rmSync(backupsDir, { recursive: true, force: true });

  // set BEFORE the app modules load: rebuildAccount calls todayIso() while
  // deriving balances, and its output must match what the server renders
  process.env.MONEYAPP_DB_PATH = dbPath;
  process.env.MONEYAPP_ORIGINALS_DIR = originalsDir;
  process.env.MONEYAPP_BACKUPS_DIR = backupsDir;
  process.env.MONEYAPP_SKIP_BACKUP = "1";
  process.env.MONEYAPP_FAKE_PRICES = "1";
  process.env.MONEYAPP_FAKE_TODAY = E2E_FAKE_TODAY;

  const summary = await seedE2eDatabase(dbPath);
  // one-line audit trail so a bad seed is debuggable from CI output
  console.log(
    `[e2e setup] seeded ${summary.txns} txns from ${summary.files} files — ` +
      `${summary.coveragePct}% categorized, ${summary.gapPeriods} open gaps, ` +
      `${summary.reviewBacklog} flagged for review, fake today ${E2E_FAKE_TODAY}`,
  );
}
