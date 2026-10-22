import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/recurring/page.tsx"), "utf8");

/**
 * 🔴 A monthly income rate summed from more than one pay schedule linked to a bare `/recurring?tab=all` — every series
 * the ledger lists, bills among them (review of the dashboard links, 2026-10-12). The rows are cut and the badge counted
 * in ONE call (`lib/recurring-list::allTabOf`, pinned there by behaviour, and followed from the runway's own link in
 * `committed.test.ts`); this gate only keeps the page making that call and no second one of its parts. Source, not
 * render: the page is an async server component that reads the database.
 *
 * 🔴 It matched the page's literal text — `const listed = seriesListed(series, namedSeriesOf(…));` — so a reflow or a
 * renamed local failed it with nothing changed (review of the dashboard links). It asks only which helpers are called.
 */
describe("/recurring's All tab is built by the one helper", () => {
  test("the page calls allTabOf once, and none of the rules it is made of on its own", () => {
    expect(source.match(/\ballTabOf\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\b(seriesListed|namedSeriesOf|isListedSeries)\b/);
  });

  test("the view is handed the helper's rows and narrowing, and the badge its count", () => {
    expect(source.match(/<AllSeriesView\b/g)).toHaveLength(1);
    expect(source).toMatch(/series=\{\s*allTab\.rows\s*\}/);
    expect(source).toMatch(/narrowed=\{\s*allTab\.narrowed\s*\}/);
    expect(source).toMatch(/all:\s*allTab\.badge\b/);
  });
});
