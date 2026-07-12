import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "../../src/db/client";
import { seedDatabase } from "../../src/db/seed";
import { accounts } from "../../src/db/schema/accounts";
import { categories } from "../../src/db/schema/categories";
import { institutions } from "../../src/db/schema/institutions";
import { importStatementFiles, type ImportInput } from "../../src/services/import/service";
import { detectRecurringSeries } from "../../src/services/recurring";
import { upsertHolding } from "../../src/services/holdings";
import { refreshPrices } from "../../src/services/prices";
import { createBudget } from "../../src/services/budgets";
import { coverageStats } from "../../src/services/categorize";
import { netWorthSeries } from "../../src/services/derivation";
import { fakeDailyClose } from "../../src/lib/fake-prices";
import { runSimulation } from "../fixtures/simulate";

/**
 * Builds the demo database by driving the REAL pipelines end to end:
 * fixture statements → import/reconcile → categorize → recurring detection →
 * holdings + fake-mode price backfill → budgets. Run with:
 *   MONEYAPP_FAKE_PRICES=1 pnpm demo:load
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");
const DB_PATH = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");

function loadDir(...rel: string[]): ImportInput[] {
  const dir = path.join(FIXTURES, ...rel);
  return fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ name: f, buffer: fs.readFileSync(path.join(dir, f)) }));
}

async function main(): Promise<void> {
  if (process.env.MONEYAPP_FAKE_PRICES !== "1") {
    throw new Error("Run with MONEYAPP_FAKE_PRICES=1 so demo prices match the fixture statements");
  }
  // SAFETY: demo:load DELETES the target before rebuilding, and DB_PATH defaults
  // to the app's real database. Refuse to clobber an existing db unless the caller
  // explicitly forces it or points at a throwaway path — a lost financial db is
  // never worth a convenience default.
  if (fs.existsSync(DB_PATH) && process.env.MONEYAPP_DEMO_FORCE !== "1") {
    const isDefaultDb =
      path.resolve(DB_PATH) === path.resolve(process.cwd(), "data", "moneyapp.db");
    throw new Error(
      `Refusing to overwrite the existing database at ${DB_PATH}` +
        (isDefaultDb ? " — this is the app's default db (likely your REAL financial data)." : ".") +
        `\ndemo:load rebuilds from scratch and would delete it. Either:` +
        `\n  • build into a throwaway path:  MONEYAPP_DB_PATH=data/demo-shots.db pnpm demo:load` +
        `\n  • or force overwrite on purpose: MONEYAPP_DEMO_FORCE=1 pnpm demo:load`,
    );
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  const { db, sqlite } = createDatabase(DB_PATH);
  seedDatabase(db);

  const files: ImportInput[] = [
    ...loadDir("chase"),
    ...loadDir("chase", "statements"),
    ...loadDir("discover"),
    ...loadDir("discover", "statements"),
    ...loadDir("discover", "corrupted"), // demo: one deliberate reconciliation gap
    ...loadDir("capital-one"),
    ...loadDir("capital-one", "statements"),
    ...loadDir("sofi"),
    ...loadDir("sofi", "statements"),
    ...loadDir("robinhood"),
    ...loadDir("robinhood", "statements"),
  ];
  process.stdout.write(`importing ${files.length} statement files through the real pipeline…\n`);
  const outcomes = await importStatementFiles(db, files);
  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) {
    throw new Error(`demo import failures:\n${failed.map((f) => `  ${f.fileName}: ${f.error}`).join("\n")}`);
  }

  // Robinhood crypto account + the user's ETH timeline (manual-entry path);
  // quantities are cumulative totals, per-unit avg cost from the fake walk
  const robinhood = db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  const crypto = db
    .insert(accounts)
    .values({ institutionId: robinhood.id, name: "Robinhood Crypto", type: "investment", subtype: "crypto" })
    .returning({ id: accounts.id })
    .get();
  const ethBuys: [day: string, cumulativeQtyE8: number][] = [
    ["2024-09-12", 50_000_000],
    ["2025-03-20", 80_000_000],
    ["2026-01-15", 100_000_000],
  ];
  let costAccum = 0;
  let qtyAccum = 0;
  for (const [day, cumulative] of ethBuys) {
    const boughtE8 = cumulative - qtyAccum;
    costAccum += Math.round((boughtE8 / 1e8) * fakeDailyClose("ETH", day) * 100);
    qtyAccum = cumulative;
    upsertHolding(db, {
      accountId: crypto.id,
      symbol: "ETH",
      assetType: "crypto",
      quantityE8: cumulative,
      avgCostCents: Math.round(costAccum / (qtyAccum / 1e8)),
      occurredOn: day,
    });
  }

  // brokerage holdings from the simulation's final statement
  const sim = runSimulation();
  const lastRh = [...sim.periods]
    .filter((p) => p.accountKey === "robinhood-brokerage")
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .at(-1)!;
  const brokerage = db.select().from(accounts).all().find((a) => a.subtype === "brokerage")!;
  for (const h of lastRh.holdings ?? []) {
    upsertHolding(db, {
      accountId: brokerage.id,
      symbol: h.symbol,
      assetType: h.symbol === "VOO" ? "etf" : "stock",
      quantityE8: h.quantityE8,
      avgCostCents: Math.round(h.price * 100 * 0.82), // plausible cost basis for P/L display
      occurredOn: "2024-07-01",
    });
  }

  process.stdout.write("backfilling 2 years of prices (fake mode) + live anchors…\n");
  const refresh = await refreshPrices(db, {});
  if (refresh.errors.length > 0) {
    throw new Error(`price refresh errors: ${refresh.errors.join("; ")}`);
  }

  process.stdout.write("detecting recurring series…\n");
  detectRecurringSeries(db, "2026-07-08");

  // budgets tuned to show every alert state in the demo
  const catId = (name: string): string =>
    db.select().from(categories).where(eq(categories.name, name)).get()!.id;
  // amounts tuned so the §8 pace bars show every tone: Food projects OVER its
  // cap (amber/at-risk) while still under today; Housing is already OVER (red);
  // the rest finish comfortably under (green).
  createBudget(db, { categoryId: catId("Food"), period: "monthly", amountCents: 25_000 });
  createBudget(db, { categoryId: catId("Coffee"), period: "monthly", amountCents: 2_000 });
  createBudget(db, { categoryId: catId("Housing"), period: "monthly", amountCents: 200_000 });
  createBudget(db, { categoryId: catId("Transport"), period: "weekly", amountCents: 6_000 });
  createBudget(db, { categoryId: catId("Travel"), period: "annual", amountCents: 300_000 });
  createBudget(db, { categoryId: catId("Subscriptions"), period: "monthly", amountCents: 4_000 });

  const coverage = coverageStats(db);
  const series = netWorthSeries(db);
  const last = series.at(-1)!;
  process.stdout.write(
    `demo ready: ${coverage.total} txns, ${coverage.coveragePct}% categorized, ` +
      `net worth $${(last.totalCents / 100).toLocaleString("en-US")} across ${last.totalAccounts} accounts, ` +
      `history from ${series[0]!.day}\n`,
  );
  sqlite.close();
}

void main();
