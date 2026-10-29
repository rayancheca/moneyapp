import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE SHRINK GATE for the dashboard.
 *
 * A grid item's automatic minimum size is its min-content size, so a track will
 * happily size itself to the widest merchant name in the ledger and push the
 * whole document sideways — measured here at +95px on a 375px window and +30px
 * at 440px, from a single 454px track inside a 343px page. It is invisible on
 * seed data (short names) and only appears on the owner's real transactions,
 * which is exactly why it needs a gate rather than an eye.
 *
 * The cure is one token, `*:min-w-0`, and the failure repeats: it is the same
 * shape as `truncate` needing `min-w-0`, and the same shape as the four other
 * containers this pass found elsewhere in the app. So every grid on this page
 * must say out loud that its tracks are allowed to shrink.
 */

const source = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");

/** Every literal className on the page — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

describe("the dashboard's tracks can shrink", () => {
  test("there are grids here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(source).filter(isGrid).length).toBeGreaterThanOrEqual(2);
  });

  test("every grid zeroes its items' automatic minimum size", () => {
    for (const cls of classNames(source).filter(isGrid)) {
      expect(
        cls.includes("*:min-w-0"),
        `grid without a shrink guard — add \`*:min-w-0\`, or the widest cell ` +
          `sets the track width and the page scrolls sideways on a phone:\n  ${cls}`,
      ).toBe(true);
    }
  });

  test("the activity hub still composes 1.5fr against 1fr above lg", () => {
    // the fix must not have been "delete the two-column layout"
    const activity = classNames(source).find((c) => c.includes("lg:grid-cols-[1.5fr_1fr]"));
    expect(activity).toBeDefined();
    expect(activity).toContain("*:min-w-0");
  });
});

/*
 * ⚖️ Decisions 64 + 72: the Flow mode's range pills ask the same rule /spending's Sankey asks — a range holding money
 * in and no spending found, every elapsed day of it past the day all his spending is read through, draws no "Net
 * saved" (`spendingSankey`'s `today`). 🔴 Review of b356d57, a second copy of his ledger with a $1,141.92 pay on Oct 16:
 * the 1W pill (Oct 15 – 21) drew "Salary → Money in → Net saved $1,141.92". Source, not render.
 */
describe("the dashboard's Flow asks whether its range's spending has been found", () => {
  const section = fs.readFileSync(
    path.join(process.cwd(), "src/components/dashboard/DashboardChartSection.tsx"),
    "utf8",
  );

  test("every range's Sankey is asked with today", () => {
    expect(source).toMatch(/spendingSankey\(db, \{ from: rangeAggregateStartDay\(r, today\) \?\? EARLIEST_DAY, to: today \}, today\)/);
  });

  /*
   * ⚖️ §6A 68: …and a range whose income nobody has looked for is said of "this range", the noun its own empty words
   * use (2026-10-29). 🔴 His ledger copy 2026-10-29: the Flow's 1W (Oct 23 – 29) and 1M (Sep 30 – Oct 29) read "Not one
   * day of this period has been checked in the accounts that pay lands in", the chart's default noun, beside pills
   * whose flow says "No money flow in this range." where nothing flowed.
   */
  test("its Sankey says an unread range's Income of 'this range', as it says an empty one", () => {
    const mount = /<SankeyChart\b[\s\S]*?\/>/.exec(section)?.[0] ?? "";
    expect(mount).toContain('emptyLabel="No money flow in this range."');
    expect(mount).toContain('incomeUnreadNote={noIncomeDayCheckedNote("this range")}');
  });

  /*
   * ⚡ …and only the ranges it draws a pill for. 🔴 It ran `spendingSankey` for every `CHART_RANGES` entry, 1D
   * included — a range neither the Flow nor the Bridge draws a pill for (`DAILY_SERIES_RANGES` drops it) and no URL
   * reaches (the hero's ChartFocus opens on 1Y and mirrors no `rangeParam`): one Sankey per Flow render, and one bridge
   * per Bridge render, that nothing showed (batch 7 review, 2026-10-23). His pills on his ledger copy 2026-10-29: 1W,
   * 1M, 3M, YTD, 1Y and ALL.
   */
  test("its flow and its bridge are built for exactly the range pills the hero draws", () => {
    // the list a row of pills maps, and the list a precomputed record is built from
    const pills = (group: string) =>
      new RegExp(`aria-label="${group}"[\\s\\S]*?\\{(\\w+)\\.map\\(\\(r\\) =>`).exec(section)?.[1];
    const built = (name: string) =>
      new RegExp(`const ${name} =[^;]*?Object\\.fromEntries\\(\\s*(\\w+)\\.map\\(`).exec(source)?.[1];
    expect([pills("Flow range"), pills("Bridge range")]).toEqual(["DAILY_SERIES_RANGES", "DAILY_SERIES_RANGES"]);
    expect([built("sankeyByRange"), built("bridgeByRange")]).toEqual(["DAILY_SERIES_RANGES", "DAILY_SERIES_RANGES"]);
  });
});
