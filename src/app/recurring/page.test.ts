import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/recurring/page.tsx"), "utf8");

// the tab strip reads the URL on screen (`usePageLinks`); nothing here navigates
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/recurring",
  useSearchParams: () => new URLSearchParams(),
}));
// the server actions pull in next/cache; the page and its views only hand them to forms
vi.mock("./actions", () => ({
  detectNowAction: vi.fn(),
  confirmSeriesAction: vi.fn(),
  dismissSeriesAction: vi.fn(),
  loadMonthForecastAction: vi.fn(),
  loadRecurringMonthAction: vi.fn(),
}));

// getDb() opens MONEYAPP_DB_PATH on its first call: a temp file, so the page can never read the owner's ledger
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-recurring-page-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
// the connection is cached on globalThis — drop any inherited handle so this file reads no other database
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { recurringSeries } = await import("@/db/schema/recurring");
const { ALL_SERIES_HREF, seriesListHref } = await import("@/lib/recurring-list");
const { default: RecurringPage } = await import("./page");

/**
 * 🔴 A monthly income rate summed from more than one pay schedule linked to a bare `/recurring?tab=all` — every series
 * the ledger lists, bills among them (review of the dashboard links, 2026-10-12). The rows are cut and the badge counted
 * in ONE call (`lib/recurring-list::allTabOf`, pinned there by behaviour, and followed from the runway's own link in
 * `committed.test.ts`); this gate only keeps the page making that call and no second one of its parts. Source, because
 * a render cannot tell a second rule from the helper's on a ledger where the two agree.
 *
 * 🔴 It matched the page's literal text — `const listed = seriesListed(series, namedSeriesOf(…));` — so a reflow or a
 * renamed local failed it with nothing changed (review of the dashboard links). It asks only which helpers are called.
 */
describe("/recurring's All tab is built by the one helper", () => {
  test("the page calls allTabOf once, and none of the rules it is made of on its own", () => {
    expect(source.match(/\ballTabOf\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\b(seriesListed|namedSeriesOf|isListedSeries)\b/);
  });
});

/*
 * 🔴 …and what the view and the badge are handed was still pinned by the page's text, `allTab.rows`, `allTab.narrowed`
 * and `all: allTab.badge`: renaming the local failed it with nothing changed, what the review above objected to (batch
 * 6 review, #22). So the page is rendered, from a ledger in a temp file, and read the way he reads it: the rows under
 * the tab strip, the line over them and the number in its All tab.
 */
describe("/recurring's All tab, rendered: the rows a link named, the line over them and the badge's count", () => {
  let ids: Record<"salary" | "tutoring" | "rent" | "lending", string>;

  beforeAll(() => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-10-29";
    const { db } = getDbBundle();
    seedDatabase(db);
    const series = (name: string, kind: "income" | "bill", status: "confirmed" | "detected" | "dismissed") =>
      db
        .insert(recurringSeries)
        .values({ name, kind, cadence: "monthly", status })
        .returning({ id: recurringSeries.id })
        .get().id;
    ids = {
      salary: series("Salary", "income", "confirmed"),
      tutoring: series("Tutoring", "income", "detected"),
      rent: series("Rent", "bill", "confirmed"),
      // dismissed: in no section of the tab, and not in its population
      lending: series("STOCK LENDING (COKE)", "income", "dismissed"),
    };
  });

  afterAll(() => {
    getDbBundle().sqlite.close();
    delete dbCache.__moneyappDb;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MONEYAPP_DB_PATH;
    delete process.env.MONEYAPP_FAKE_TODAY;
  });

  /** The page at `href`: the series its All tab lists (each row links its own page), the line over them, its badge. */
  async function allTabAt(href: string) {
    const params = Object.fromEntries(new URL(href, "http://localhost").searchParams);
    const html = renderToStaticMarkup(await RecurringPage({ searchParams: Promise.resolve(params) }));
    const strip = html.indexOf('aria-label="Recurring views"');
    expect(strip).toBeGreaterThan(-1); // guards the guard: a page with no tab strip proves nothing below
    const nav = html.slice(strip, html.indexOf("</nav>", strip));
    const tab = html.slice(strip + nav.length); // what the strip opens — the forecast card above it is not the tab
    return {
      listed: [...tab.matchAll(/href="\/recurring\/([^"/?]+)"/g)].map(([, id]) => id).sort(),
      line: /Showing \d+ of \d+ series[^<]*/.exec(tab)?.[0].trim() ?? null,
      badge: Number(/>All<span[^>]*>(\d+)<\/span>/.exec(nav)?.[1]),
    };
  }

  test("from a link naming two of three listed series: those two, 'Showing 2 of 3', and All's badge 3", async () => {
    const tab = await allTabAt(seriesListHref([ids.salary, ids.tutoring]));
    expect(tab.listed).toEqual([ids.salary, ids.tutoring].sort());
    expect(tab.line).toBe("Showing 2 of 3 series — the ones behind the link you followed.");
    expect(tab.badge).toBe(3);
  });

  test("with no link: every listed series, nothing said over them, and the same badge", async () => {
    const tab = await allTabAt(ALL_SERIES_HREF);
    expect(tab.listed).toEqual([ids.salary, ids.tutoring, ids.rent].sort());
    expect(tab.line).toBeNull();
    expect(tab.badge).toBe(3);
  });
});
