import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * Captures the numbered README walkthrough from the RUNNING app:
 * a fresh database for the empty state and the live upload flow, then the
 * fully-loaded demo database (built by `pnpm demo:load` through the real
 * import pipeline) for the feature screens. Playwright drives every click.
 */

const OUT = path.join(process.cwd(), "docs", "screenshots");
const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server at ${url} did not come up`);
}

function startServer(dbPath: string, port: number): ChildProcess {
  return spawn("pnpm", ["start", "--port", String(port)], {
    env: {
      ...process.env,
      MONEYAPP_DB_PATH: dbPath,
      MONEYAPP_FAKE_PRICES: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: "ignore",
    detached: false,
  });
}

async function newPage(browser: Browser, base: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: base,
    reducedMotion: "reduce",
  });
  return context.newPage();
}

async function shoot(page: Page, route: string, file: string, fullPage = true): Promise<void> {
  await page.goto(route);
  // hydrated — wait on the theme toggle BY NAME, not `header button svg`: pages
  // with a CalendarGrid (spending heatmap, recurring calendar) or a mounted Sheet
  // put more than one svg under a <header>, which trips strict mode.
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).waitFor();
  await page.waitForTimeout(350); // charts settle
  await page.screenshot({ path: path.join(OUT, file), fullPage });
  process.stdout.write(`  ${file}\n`);
}

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // ── Act 1: fresh database — empty state and the live upload flow ──────
  const freshDb = path.join(process.cwd(), "data", "shots-fresh.db");
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${freshDb}${s}`, { force: true });
  const serverA = startServer(freshDb, 3210);
  await waitForServer("http://localhost:3210/");
  const pageA = await newPage(browser, "http://localhost:3210");

  await shoot(pageA, "/", "01-empty-dashboard.png");

  // a REAL upload through the UI: Capital One's structured export + statements
  await pageA.goto("/imports");
  await pageA.setInputFiles('input[name="files"]', [
    path.join(FIXTURES, "capital-one", "3333_transaction_download.ofx"),
    path.join(FIXTURES, "capital-one", "4444_transaction_download.csv"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-04-01_2026-04-30.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-05-01_2026-05-31.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-checking-2026-06-01_2026-06-30.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-venturex-2026-04-20_2026-05-19.pdf"),
    path.join(FIXTURES, "capital-one", "statements", "capone-venturex-2026-05-20_2026-06-19.pdf"),
  ]);
  await pageA.getByRole("button", { name: "Import", exact: true }).click();
  await pageA.getByText("Imported files").waitFor({ timeout: 60_000 });
  await pageA.screenshot({ path: path.join(OUT, "02-first-import-reconciled.png"), fullPage: true });
  process.stdout.write("  02-first-import-reconciled.png\n");

  // the trust layer catching a corrupted statement
  await pageA.setInputFiles('input[name="files"]', [
    path.join(FIXTURES, "discover", "corrupted", "discover-card-2024-11-15_CORRUPTED.pdf"),
  ]);
  await pageA.getByRole("button", { name: "Import", exact: true }).click();
  await pageA.getByText("Unreconciled statements").waitFor({ timeout: 60_000 });
  await pageA.screenshot({ path: path.join(OUT, "03-reconciliation-gap-quarantine.png"), fullPage: true });
  process.stdout.write("  03-reconciliation-gap-quarantine.png\n");

  await pageA.context().close();
  serverA.kill();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${freshDb}${s}`, { force: true });

  // ── Act 2: the fully-loaded demo database (2 years, 256 files) ────────
  // SAFETY: never serve the app's real db. Default to a throwaway demo db built
  // with `MONEYAPP_DB_PATH=data/demo-shots.db pnpm demo:load`; overridable via env.
  const shotsDb = process.env.MONEYAPP_SHOTS_DB ?? path.join(process.cwd(), "data", "demo-shots.db");
  if (!fs.existsSync(shotsDb)) {
    throw new Error(
      `No demo db at ${shotsDb}. Build one first (kept OUT of your real data):\n` +
        `  MONEYAPP_DB_PATH=data/demo-shots.db MONEYAPP_FAKE_PRICES=1 pnpm tsx scripts/demo/load-demo.ts`,
    );
  }
  const serverB = startServer(shotsDb, 3220);
  await waitForServer("http://localhost:3220/");
  const pageB = await newPage(browser, "http://localhost:3220");

  await shoot(pageB, "/", "04-networth-two-years.png");
  await shoot(pageB, "/transactions", "05-transactions-coverage.png", false);

  // the categorize learning loop — open the guided walk on the first flagged row
  await pageB.goto("/transactions?view=review");
  await pageB.getByRole("button", { name: /Switch to (light|dark) theme/ }).waitFor();
  const startWalk = pageB.getByRole("button", { name: /Start · \d+/ });
  if (await startWalk.isVisible().catch(() => false)) {
    await startWalk.click();
    const dialog = pageB.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await pageB.waitForTimeout(450); // the panel (suggestion/history/rules) loads
    await dialog.screenshot({ path: path.join(OUT, "05b-categorize-card.png") });
    process.stdout.write("  05b-categorize-card.png\n");
    await pageB.keyboard.press("Escape");
  }

  await shoot(pageB, "/spending", "06-spending-analytics.png");
  await shoot(pageB, "/budgets", "07-budgets-alerts.png");

  await pageB.goto("/recurring");
  await pageB.getByRole("button", { name: /Switch to (light|dark) theme/ }).waitFor();
  const math = pageB.locator("details summary").first();
  if (await math.isVisible()) await math.click();
  await pageB.waitForTimeout(250);
  await pageB.screenshot({ path: path.join(OUT, "08-recurring-forecast-math.png"), fullPage: true });
  process.stdout.write("  08-recurring-forecast-math.png\n");

  await shoot(pageB, "/investments", "09-investments-allocation.png");
  await shoot(pageB, "/imports", "10-imports-ledger.png", false);

  // one dark-mode look
  await pageB.emulateMedia({ colorScheme: "dark" });
  await pageB.goto("/");
  await pageB.getByRole("button", { name: /switch to dark theme/i }).click();
  await pageB.waitForTimeout(350);
  await pageB.screenshot({ path: path.join(OUT, "11-dashboard-dark.png"), fullPage: false });
  process.stdout.write("  11-dashboard-dark.png\n");

  await pageB.context().close();
  serverB.kill();
  await browser.close();
  process.stdout.write(`screenshots → ${OUT}\n`);
}

void main();
