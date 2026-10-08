import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { SeriesMergeCandidate } from "@/services/recurring-detail";

// the server actions pull in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({
  attachToSeriesAction: vi.fn(),
  detachFromSeriesAction: vi.fn(),
  mergeIntoSeriesAction: vi.fn(),
  searchAttachCandidatesAction: vi.fn(),
}));

const { MergeConfirmation } = await import("./SeriesMembership");

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The confirmation as it renders: its question, as he reads it, and the buttons under it. */
function confirmation(candidate: SeriesMergeCandidate): { question: string; buttons: string[] } {
  const html = renderToStaticMarkup(
    createElement(MergeConfirmation, { candidate, merging: false, onCancel: () => {}, onConfirm: () => {} }),
  );
  const question = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  return {
    question: decode(question.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    buttons: [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => decode(m[1] as string).trim()),
  };
}

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 54): merging a series in files its rows not filed yet under this series' category,
 * and the confirmation SAYS so before he presses — a merge has no undo button. That sentence was his condition for
 * merge filing at all.
 *
 * 🔴 Review 2026-10-08: no test rendered it. The labels tests covered `mergeFilingClause` on its own and the one e2e
 * merge files nothing (income into a subscription), so deleting the sentence from the page left every test green.
 */
describe("the merge confirmation, as rendered (§6A 54)", () => {
  const base = { id: "s2", name: "CAPITAL ONE 360 TRANSFER", kind: "bill" } as const;

  test("names the exact count and the category path before the press", () => {
    const { question } = confirmation({
      ...base,
      filing: { categoryId: "c1", categoryPath: "Subscriptions > Software", count: 24 },
    });
    expect(question).toBe(
      "Merge CAPITAL ONE 360 TRANSFER into this series? Its charges move here and it ends. " +
        "24 not filed yet will be filed under Subscriptions > Software.",
    );
  });

  test("nothing to file → the sentence he has always read, unchanged", () => {
    const { question } = confirmation({ ...base, name: "Rent", filing: null });
    expect(question).toBe("Merge Rent into this series? Its charges move here and it ends.");
  });

  test("the choice under it is still Cancel or Merge in", () => {
    expect(confirmation({ ...base, filing: null }).buttons).toEqual(["Cancel", "Merge in"]);
  });
});
