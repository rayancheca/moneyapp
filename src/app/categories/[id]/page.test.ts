import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⛔ "ALL TIME" MUST NAME ONE WINDOW ON EVERY PAGE THAT OFFERS IT.
 *
 * `resolvePeriod` is pure: without the ledger's first day it starts "All time"
 * at `ALL_TIME_FLOOR` (2020-01-01). `/spending` passes `ledgerFirstDay(db)`;
 * `/categories/<id>` did not. Measured 2026-09-14, all 80 category pages at
 * `?period=ALL` started on 2020-01-01 — 967 days before the ledger's first row
 * on 2022-08-25 — while `/spending?period=ALL` started on 2022-08-25, so the
 * same words named two windows one click apart, and the category page's Day and
 * Year pills stepped into years that hold nothing.
 *
 * A source gate, like the page's siblings: the page is an async server
 * component that reads the database, and the rule is one argument.
 */

const PAGES = ["src/app/categories/[id]/page.tsx", "src/app/spending/page.tsx"];

/** Every `resolvePeriod(` call's argument list, balanced over parentheses. */
function resolvePeriodCalls(src: string): string[] {
  const calls: string[] = [];
  let at = src.indexOf("resolvePeriod(");
  while (at !== -1) {
    let depth = 0;
    let end = at + "resolvePeriod".length;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(at, end + 1));
    at = src.indexOf("resolvePeriod(", end);
  }
  return calls;
}

describe("every page resolves 'All time' from the ledger's first day", () => {
  const fromUrl = PAGES.flatMap((file) =>
    resolvePeriodCalls(fs.readFileSync(path.join(process.cwd(), file), "utf8"))
      .filter((call) => call.includes("firstParam(raw."))
      .map((call) => ({ file, call })),
  );

  test("there are URL-built period resolutions to gate", () => {
    // guards the guard: a pattern that silently matches nothing proves nothing
    expect(fromUrl.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fromUrl.map((c) => c.file)).size).toBe(PAGES.length);
  });

  test("each one passes ledgerFirstDay(db)", () => {
    for (const { file, call } of fromUrl) expect(call, file).toContain("ledgerFirstDay(db)");
  });
});
