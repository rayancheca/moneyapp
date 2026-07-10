import fs from "node:fs";
import path from "node:path";
import type { ImportInput } from "../src/services/import/service";

/**
 * Seeded-base machinery for the e2e harness (ux-overhaul-plan §2.7).
 *
 * Fixture split:
 * - SET A (seeded by global-setup before any spec runs): chase, discover,
 *   sofi, robinhood — structured downloads + statement PDFs. Visual/a11y/
 *   interaction specs render against this populated, un-mutated base.
 * - SET B (reserved): capital-one + discover/corrupted — uploaded through
 *   the real browser UI by zz-golden-path.spec.ts, whose assertions rely on
 *   these accounts and periods NOT pre-existing.
 *
 * App modules are imported dynamically so env (db path, fake clock/prices)
 * is set before any of them evaluates; imports are RELATIVE because this
 * file runs under Playwright's transpiler, not the Next bundler.
 */

/**
 * Pinned "today" for the whole harness: inside the fixture window
 * (2024-07-01 → 2026-07-05 per manifest.json) so "this month" and
 * "last 30 days" surfaces contain fixture transactions, and 3 days past the
 * last posting so "upcoming"/pace surfaces have something imminent. Also the
 * repo's canonical test date (dates.test.ts, demo recurring detection).
 */
export const E2E_FAKE_TODAY = "2026-07-08";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");

/**
 * zz-golden-path uploads the CORRUPTED 2024-11-15 → 2024-12-14 Discover
 * statement; the fixture generator built that month so the PDF is the
 * period's ONLY source. Its clean twin must stay out of set A, or
 * duplicate-period adoption would reconcile the gap away.
 */
const RESERVED_FOR_GOLDEN_PATH = new Set(["discover-card-2024-11-15_2024-12-14.pdf"]);

const SET_A_DIRS: readonly (readonly string[])[] = [
  ["chase"],
  ["chase", "statements"],
  ["discover"],
  ["discover", "statements"],
  ["sofi"],
  ["sofi", "statements"],
  ["robinhood"],
  ["robinhood", "statements"],
];

function loadDir(...rel: string[]): ImportInput[] {
  const dir = path.join(FIXTURES, ...rel);
  return fs
    .readdirSync(dir)
    .filter((f) => !RESERVED_FOR_GOLDEN_PATH.has(f) && fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ name: f, buffer: fs.readFileSync(path.join(dir, f)) }));
}

export interface SeedSummary {
  files: number;
  txns: number;
  coveragePct: number;
  gapPeriods: number;
}

/** Builds the seeded e2e base: migrate → seed → import set A → categorize. */
export async function seedE2eDatabase(dbPath: string): Promise<SeedSummary> {
  const { createDatabase } = await import("../src/db/client");
  const { seedDatabase } = await import("../src/db/seed");
  const { importStatementFiles } = await import("../src/services/import/service");
  const { categorizeAll, coverageStats } = await import("../src/services/categorize");
  const { statementPeriods } = await import("../src/db/schema/imports");
  const { eq } = await import("drizzle-orm");

  const { db, sqlite } = createDatabase(dbPath); // migrations run on open
  try {
    seedDatabase(db);
    const files = SET_A_DIRS.flatMap((dir) => loadDir(...dir));
    const outcomes = await importStatementFiles(db, files);
    const failed = outcomes.filter((o) => o.status === "failed");
    if (failed.length > 0) {
      throw new Error(
        `e2e seed import failures:\n${failed.map((f) => `  ${f.fileName}: ${f.error}`).join("\n")}`,
      );
    }
    // explicit final deterministic pass — category chips/coverage must exist
    // before the visual/a11y/interaction specs render
    categorizeAll(db);

    const coverage = coverageStats(db);
    const gapPeriods = db
      .select({ id: statementPeriods.id })
      .from(statementPeriods)
      .where(eq(statementPeriods.reconciliation, "gap"))
      .all().length;
    if (gapPeriods > 0) {
      // zz-golden-path asserts the ONLY unreconciled statement is its upload
      throw new Error(`e2e seed left ${gapPeriods} unreconciled gap period(s) — set A must be gap-free`);
    }
    return { files: files.length, txns: coverage.total, coveragePct: coverage.coveragePct, gapPeriods };
  } finally {
    sqlite.close();
  }
}
