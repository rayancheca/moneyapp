import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { SurfaceInsights } from "@/services/insights";
import { InsightList } from "./InsightList";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * 🔴 The badge beside an insight is labelled by the insight, and an insight is a
 * finished sentence — so its accessible name read "…at $2,291.21. is proven — a
 * plan", a full stop in the middle of what a screen reader speaks as one
 * sentence. The visible sentence keeps its stop; only the name drops it.
 */
describe("InsightList — the proof badge's name", () => {
  const text = "Housing is the largest of your 12 monthly budgets, by what you planned to spend, at $2,291.21.";
  const data: SurfaceInsights = {
    windowLabel: "Sep 2026",
    windowNote: null,
    insights: [
      {
        id: "budget-largest:housing",
        text,
        claimId: "budget-largest",
        provenance: { verdict: "manual", headline: "A plan.", sources: [], checkedThrough: null, inputs: [], badgeWord: "a plan" },
      },
    ],
  };
  const html = decode(renderToStaticMarkup(createElement(InsightList, { data })));

  test("the trigger's name carries the claim without its terminal full stop", () => {
    expect(html).toContain(
      'aria-label="How Housing is the largest of your 12 monthly budgets, by what you planned to spend, at $2,291.21 is known — a plan"',
    );
    expect(html).not.toMatch(/\. is known/);
  });

  test("the visible sentence still ends in its full stop", () => {
    expect(html).toContain(`<span>${text}</span>`);
  });
});

/*
 * ⚖️ His decision 72 (2026-10-13): a total over a window read only in part keeps its figure, its chip reads "partly
 * read", and /budgets' line sits UNDER it. A sentence here is such a total wherever its proof says so — 🔴 on his ledger
 * copy 2026-10-13 a merchant page is the one place its line could print, and nothing printed it: "Flamingo South Beach
 * is the largest of your 254 regular merchants, at $9,248.82" over Chase Checking, read through Aug 12.
 */
describe("InsightList — a sentence over a window read only in part", () => {
  const LINE = "spending imported through Aug 12 · 21 days of this period unaccounted";
  const text = "Flamingo South Beach is the largest of your 254 regular merchants, at $9,248.82.";
  const strip = (partlyRead?: { uncoveredDays: number; line: string }): string => {
    const data: SurfaceInsights = {
      windowLabel: "Jun 16 – Sep 2, 2026",
      windowNote: null,
      insights: [
        {
          id: "merchant-rank",
          text,
          claimId: "largest_in_set",
          provenance: {
            verdict: partlyRead ? "partly_read" : "derived",
            headline: "This total is the sum of 5 rows from 4 documents.",
            sources: [],
            checkedThrough: "2026-08-12",
            inputs: [],
            ...(partlyRead ? { partlyRead } : {}),
          },
        },
      ],
    };
    return decode(renderToStaticMarkup(createElement(InsightList, { data })));
  };

  test("prints /budgets' line under the sentence, beside its chip", () => {
    const html = strip({ uncoveredDays: 21, line: LINE });
    expect(html).toContain(`${text}<span class="mt-0.5 block text-xs text-ink-faint">${LINE}</span></span>`);
    expect(html).toContain("partly read");
  });

  test("a sentence read in full prints no line", () => {
    const html = strip();
    expect(html).toContain(`<span>${text}</span>`);
    expect(html).not.toContain("unaccounted");
  });
});
