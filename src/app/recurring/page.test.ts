import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/recurring/page.tsx"), "utf8");

/**
 * 🔴 A monthly income rate summed from more than one pay schedule linked to a bare `/recurring?tab=all` — every series
 * the ledger lists, bills among them (review of the dashboard links, 2026-10-12). The link names its schedules
 * (`seriesListHref`) and the rows are cut in `lib/recurring-list` (`seriesListed`, tested there and, followed from the
 * runway's own link, in `committed.test.ts`); this gate keeps the page reading the param through that helper and
 * handing the view its rows untouched. Source, not render: the page is an async server component that reads the
 * database.
 */
describe("/recurring's All tab reads the series a link named, through the one helper", () => {
  test("the param is read by namedSeriesOf and cut by seriesListed", () => {
    expect(source).toMatch(
      /const listed = seriesListed\(series, namedSeriesOf\(firstParam\(raw\[SERIES_LIST_PARAM\]\)\)\);/,
    );
  });

  test("the view is handed the helper's rows and its narrowing, and no other list", () => {
    expect(source).toMatch(/<AllSeriesView\s+series=\{listed\.rows\}\s+narrowed=\{listed\.narrowed\}\s/);
    expect(source.match(/<AllSeriesView\b/g)).toHaveLength(1);
  });

  // ⛔ "2 of 14" counts the 14 the badge beside it prints: one population rule for both
  test("the All badge counts the tab's population by the rule the narrowing counts by", () => {
    expect(source).toMatch(/all: series\.filter\(isListedSeries\)\.length,/);
  });
});
