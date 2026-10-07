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

/*
 * ⚖️ The headline's word is the kind's (`categoryFlowLabel`): "Spent" over an expense category, "Received" over an
 * income one, "Net" over every other — /categories/<Uncategorized> among them, the filing queue, which keeps the
 * agent's unfiled rows both signs and is no Spent figure (session decision 2026-10-06, `agents-unfiled.test.ts`).
 */
describe("the headline's word is asked of the kind, in one place", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/categories/[id]/page.tsx"), "utf8");

  test("the page reads categoryFlowLabel and spells no label of its own", () => {
    expect(page).toMatch(/const flowLabel = categoryFlowLabel\(header\.kind\);/);
    expect(page).not.toMatch(/\?\s*"Spent"\s*:/);
  });
});

/*
 * ⚖️ OWNER DECISION 2026-10-07 (§6A 49): the page names the CATEGORY'S OWN imported-through day — the rule its
 * /budgets row uses — not the ledger-wide one. 🔴 It fed `emptyPeriodReason` the ledger's `ledgerReaches(db)`, and on
 * his ledger read "the ledger is imported through Thu, Sep 24, 2026" one click from a Car row reading "spending
 * imported through Aug 12". The sentence and the trend's empty months ask through one context; the words are
 * `categoryEmptyCopy`'s (pinned in `services/category-detail.test.ts` and `agents-unfiled.test.ts`).
 *
 * ⛔ ONE BUILDER, AND IT IS THE ONE THAT KNOWS WHOSE MONEY THE WINDOW HOLDS. 🔴 The merge of this decision with the
 * agent's-money empty states (owner decisions 2026-09-28 → 2026-10-06) left two: `categoryEmptyCopy`, which says the
 * agent's money is left out, and a day-only builder that did not — and nothing on the page pinned which one it read.
 */
describe("the empty window and the trend ask the category's own day, through the one builder", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/categories/[id]/page.tsx"), "utf8");

  test("the sentence is categoryEmptyCopy's — the builder that passes agentsMoney — and the page composes none", () => {
    expect(page).toMatch(/categoryEmptyCopy\(db, id, range, \{/);
    for (const composer of ["emptyPeriodReason(", "emptyPeriodCopy(", "categoryEmptyPeriodCopy(", "categoryEmptyWindowCopy("]) {
      expect(page).not.toContain(composer);
    }
    const service = fs.readFileSync(path.join(process.cwd(), "src/services/spending.ts"), "utf8");
    const builder = service.slice(service.indexOf("export function categoryEmptyCopy("));
    expect(builder.slice(0, builder.indexOf("\n}\n"))).toMatch(/agentsMoney: agentsMoneyRowCount\(db, range, \{ categoryId \}\) > 0/);
  });

  test("both empty cards print that one sentence", () => {
    expect(page).toMatch(/const emptyText = emptyCopy \? `\$\{emptyCopy\.title\}\. \$\{emptyCopy\.description\}` : undefined;/);
    expect(page.match(/emptyText=\{emptyText\}/g)).toHaveLength(2);
  });

  test("the trend is handed the same reach context", () => {
    expect(page).toMatch(/const reachCtx = categoryReachContext\(db\);/);
    expect(page).toMatch(/categoryMonthlyTrend\([^;]*reachCtx,?\s*\)/);
    expect(page).toMatch(/categoryEmptyCopy\([^;]*reachCtx,?\s*\}\)/);
  });
});
