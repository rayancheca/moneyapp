import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../src/db/client";
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
  reviewBacklog: number;
}

/** Per-cluster and per-run caps — keep the seeded backlog small and its nav
 * badge a moderate, stable number so baselines don't churn on the count. */
const CLUSTER_CAP = 6;
const MERCHANT_CLUSTERS = 3;

interface FlagRow {
  id: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  accountName: string;
}

/**
 * Content order (newest first), IDENTICAL to reviewInbox's row orderBy
 * (postedOn desc, amount desc, rawDescription desc, accountName asc, id desc) so
 * the seed flags exactly the rows the inbox surfaces first. accountName precedes
 * the id fallback because per-seed uuidv7 ids can shuffle otherwise-tied rows
 * across accounts; id only separates byte-identical rows, which render the same.
 */
function newestFirst(a: FlagRow, b: FlagRow): number {
  return (
    b.postedOn.localeCompare(a.postedOn) ||
    b.amountCents - a.amountCents ||
    b.rawDescription.localeCompare(a.rawDescription) ||
    a.accountName.localeCompare(b.accountName) ||
    b.id.localeCompare(a.id)
  );
}

/**
 * Seeds a deterministic, clustered review backlog (ux-overhaul-plan §3.3): the
 * synthetic import categorizes too cleanly to leave a needsReview queue, so the
 * inbox would render empty and its drain gate couldn't run. Flags the newest
 * rows of the busiest few merchants (→ "Confirm all" clusters) plus one
 * uncategorized stripped-key group (→ "Categorize all"), all selected by
 * content so the flagged set — and every baseline over it — is stable.
 */
export async function seedReviewBacklog(db: AppDatabase): Promise<number> {
  const { transactions } = await import("../src/db/schema/transactions");
  const { merchants } = await import("../src/db/schema/merchants");
  const { accounts } = await import("../src/db/schema/accounts");
  const { eq, inArray } = await import("drizzle-orm");
  const { strippedDescriptionKey } = await import("../src/lib/description-key");

  const active = db
    .select({
      id: transactions.id,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      canonicalName: merchants.canonicalName,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(eq(transactions.status, "active"))
    .all();

  const flagIds: string[] = [];

  // 1) busiest categorized merchants → "Confirm all" clusters
  const byMerchant = new Map<string, { name: string; rows: FlagRow[] }>();
  for (const r of active) {
    if (!r.merchantId || r.categoryId === null) continue;
    const group = byMerchant.get(r.merchantId) ?? { name: r.canonicalName ?? "", rows: [] };
    group.rows.push(r);
    byMerchant.set(r.merchantId, group);
  }
  const rankedMerchants = [...byMerchant.values()]
    .filter((g) => g.rows.length >= 3)
    .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name))
    .slice(0, MERCHANT_CLUSTERS);
  for (const group of rankedMerchants) {
    flagIds.push(...[...group.rows].sort(newestFirst).slice(0, CLUSTER_CAP).map((r) => r.id));
  }

  // 2) one uncategorized merchantless stripped-key group → "Categorize all"
  const byKey = new Map<string, FlagRow[]>();
  for (const r of active) {
    if (r.merchantId || r.categoryId !== null) continue;
    const key = strippedDescriptionKey(r.normalizedDescription);
    if (key === "") continue;
    const bucket = byKey.get(key) ?? [];
    bucket.push(r);
    byKey.set(key, bucket);
  }
  const bestKey = [...byKey.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (bestKey) {
    flagIds.push(...[...bestKey[1]].sort(newestFirst).slice(0, CLUSTER_CAP).map((r) => r.id));
  }

  for (let i = 0; i < flagIds.length; i += 500) {
    db.update(transactions)
      .set({ needsReview: true })
      .where(inArray(transactions.id, flagIds.slice(i, i + 500)))
      .run();
  }
  return flagIds.length;
}

/**
 * Empties every data table on the live connection (schema + migration ledger
 * kept) so the file's inode is stable for the webServer's open connection.
 * FK enforcement is toggled off for the delete sweep so table order is moot.
 */
function resetAllData(sqlite: import("better-sqlite3").Database): void {
  sqlite.pragma("foreign_keys = OFF");
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as { name: string }[];
  const wipe = sqlite.transaction(() => {
    for (const { name } of tables) sqlite.prepare(`DELETE FROM "${name}"`).run();
  });
  wipe();
  sqlite.pragma("foreign_keys = ON");
}

/** Builds the seeded e2e base: reset → seed → import set A → categorize. */
export async function seedE2eDatabase(dbPath: string): Promise<SeedSummary> {
  const { createDatabase } = await import("../src/db/client");
  const { seedDatabase } = await import("../src/db/seed");
  const { importStatementFiles } = await import("../src/services/import/service");
  const { categorizeAll, coverageStats } = await import("../src/services/categorize");
  const { statementPeriods } = await import("../src/db/schema/imports");
  const { eq } = await import("drizzle-orm");

  const { db, sqlite } = createDatabase(dbPath); // migrations run on open
  try {
    // Wipe DATA in place rather than unlinking the file: Playwright's webServer
    // opens data/e2e.db on a long-lived connection, and deleting+recreating the
    // file (a new inode) would strand that connection on the PREVIOUS run's
    // data — invisible while set A was the only seed (identical every run), but
    // fatal to any run-varying seed like the review backlog. Same inode + WAL
    // means the server reads this run's committed seed no matter the order in
    // which Playwright brings up globalSetup and the webServer.
    resetAllData(sqlite);
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

    // the synthetic corpus categorizes too cleanly to leave a review queue;
    // seed a deterministic clustered backlog so the §3.3 inbox + drain render
    const reviewBacklog = await seedReviewBacklog(db);

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
    return {
      files: files.length,
      txns: coverage.total,
      coveragePct: coverage.coveragePct,
      gapPeriods,
      reviewBacklog,
    };
  } finally {
    sqlite.close();
  }
}
