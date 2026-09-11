/**
 * Open every dialog, sheet, popover, tab and expander a surface has, and collect
 * what the BROWSER complains about.
 *
 * ⭐ The gap this fills. `e2e/hydration.spec.ts` asserts that 17 routes hydrate
 * cleanly ON LOAD — it never opens anything. The `<div>` inside a `<p>` found on
 * 2026-09-11 lived in the transaction sheet's HEADER: it is in no server-rendered
 * HTML (the popover's panel arrives lazily), no screenshot opens that dialog, and
 * a `<p>`-nesting scan over cached server HTML returns zero for it. Only a real
 * browser that CLICKS can see it, and only if it clicks the thing that opens.
 *
 * ⛔ A `<p>` may not contain a `<div>`: the parser closes the paragraph where the
 * div begins, so the browser's tree stops matching React's and that subtree
 * silently loses its interactivity. Any Popover-based component — ProvenancePopover,
 * CadenceToken, anything whose panel is a `<div popover>` — must never mount
 * inside a paragraph.
 *
 * ## ⛔ Run it against a SANDBOX, never the real ledger
 *
 * This clicks buttons indiscriminately, and some of them write. Zero DB writes
 * is a multi-session invariant. Stand up a disposable copy first:
 *
 *     git worktree add ~/dev/ma-sandbox HEAD --detach
 *     cd ~/dev/ma-sandbox && pnpm install --prefer-offline && pnpm rebuild better-sqlite3
 *     mkdir -p data && cp ~/dev/MoneyApp/data/moneyapp.db data/ && cp ~/dev/MoneyApp/.env .
 *     MONEYAPP_DB_PATH=$PWD/data/moneyapp.db pnpm exec next dev -H 127.0.0.1 -p 3010 &
 *     node scripts/click-sweep.mjs [route...]
 *
 * ⚠️ Turbopack REFUSES a symlinked `node_modules` that points outside the project
 * root, and it refuses one pointing into /tmp even by absolute path — the worktree
 * has to live under the same root and install its own (pnpm hardlinks; ~3s).
 * `better-sqlite3` needs `pnpm rebuild` after that install or every route 500s.
 *
 * ## Measured
 *
 * 2026-09-11: **584 triggers across 32 surfaces — zero nesting errors, zero page
 * errors.** (An earlier run against the real ledger aborted every non-GET as a
 * safety guard and reported 178 `TypeError: Failed to fetch` page errors; those
 * were the guard, not the app. A checker that changes the app's behaviour is
 * measuring itself — hence the sandbox.)
 *
 * Usage:  node scripts/click-sweep.mjs                 # the standing route list
 *         node scripts/click-sweep.mjs /merchants/<id> /investments/crypto/ETH
 *         SWEEP_BASE=http://127.0.0.1:3011 node scripts/click-sweep.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SWEEP_BASE ?? "http://127.0.0.1:3010";
const SIGNATURE = /Minified React error #(418|425)|cannot be a descendant of|Hydration failed|did not match|validateDOMNesting/i;

const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "/",
      "/accounts",
      "/transactions",
      "/spending",
      "/spending?cash=table",
      "/spending?period=2026-07",
      "/categories",
      "/budgets",
      "/recurring",
      "/recurring?tab=all",
      "/recurring?tab=calendar",
      "/investments",
      "/settings",
      "/imports",
      "/flow",
      "/merchants",
      "/summary/2026",
      "/summary/2025",
    ];

const browser = await chromium.launch();
const findings = [];
let clicked = 0;

for (const route of ROUTES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // ⛔ the sandbox owns its own copy of the ledger — never point this at the real one
  const page = await ctx.newPage();
  const complaints = [];
  page.on("pageerror", (e) => complaints.push({ kind: "pageerror", text: String(e) }));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") complaints.push({ kind: m.type(), text: m.text() });
  });

  try {
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 45_000 });
  } catch {
    console.log(`  !! ${route} failed to load`);
    await ctx.close();
    continue;
  }
  await page.waitForTimeout(400);
  const onLoad = complaints.filter((c) => SIGNATURE.test(c.text)).length;

  // every thing that opens something, in DOM order
  const handles = await page.$$(
    "[popovertarget], summary, [aria-haspopup], [aria-expanded], [role=tab], dialog button, tbody tr, [data-testid*=row]",
  );
  const budget = Math.min(handles.length, 70);
  for (let i = 0; i < budget; i++) {
    const h = handles[i];
    try {
      if (!(await h.isVisible())) continue;
      const before = complaints.length;
      await h.click({ timeout: 1200, force: false });
      clicked++;
      await page.waitForTimeout(120);
      const fresh = complaints.slice(before).filter((c) => SIGNATURE.test(c.text) || c.kind === "pageerror");
      if (fresh.length) {
        const label =
          (await h.getAttribute("aria-label")) ||
          (await h.textContent())?.trim().slice(0, 60) ||
          (await h.evaluate((el) => el.tagName));
        for (const f of fresh) findings.push({ route, trigger: label, ...f });
      }
      // close anything modal so the next trigger is reachable
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(40);
    } catch {
      /* not clickable from here; not a finding */
    }
  }

  const hits = complaints.filter((c) => SIGNATURE.test(c.text));
  console.log(
    `${route}  triggers=${budget}  onLoad=${onLoad}  totalNesting=${hits.length}  pageerrors=${complaints.filter((c) => c.kind === "pageerror").length}`,
  );
  for (const h of [...new Set(hits.map((c) => c.text.split("\n")[0]))]) console.log(`     ↳ ${h.slice(0, 200)}`);
  await ctx.close();
}

await browser.close();
console.log(`\nclicked ${clicked} triggers · ${findings.length} trigger-scoped findings`);
for (const f of findings.slice(0, 40)) {
  console.log(`  ${f.route}  «${f.trigger}»  [${f.kind}] ${f.text.split("\n")[0].slice(0, 220)}`);
}
