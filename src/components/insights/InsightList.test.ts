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
      'aria-label="How Housing is the largest of your 12 monthly budgets, by what you planned to spend, at $2,291.21 is proven — a plan"',
    );
    expect(html).not.toMatch(/\. is proven/);
  });

  test("the visible sentence still ends in its full stop", () => {
    expect(html).toContain(`<span>${text}</span>`);
  });
});
