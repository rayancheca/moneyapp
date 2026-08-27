/**
 * Screenshot the three new surfaces against the REAL ledger on the dev server.
 *
 * ⚠️ The Browser pane reports blank for this app; drive Playwright directly,
 * from inside the repo so module resolution works.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:3000";
const shots = [
  ["summary-2026", "/summary/2026"],
  ["summary-2024", "/summary/2024"],
  ["budgets", "/budgets"],
  ["spending", "/spending"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
for (const [name, path] of shots) {
  const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
  console.log(`${String(res?.status()).padEnd(4)} ${path}`);
  await page.screenshot({ path: `/tmp/real-${name}.png`, fullPage: true });
}
await browser.close();
