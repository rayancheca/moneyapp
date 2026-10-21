import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { emptyPeriodCopy } from "@/lib/empty-period";
import type { SpendingPace } from "@/services/dashboard";
import { SpendingPaceWidget } from "./SpendingPaceWidget";

/**
 * 🔴 ONE FACT, TWO WORDINGS, ONE CLICK APART. With not one elapsed day of October imported the dashboard's pace tile
 * read "October 2026 is not imported yet" under its "—", and the category headline it links toward "— October 2026
 * has not been imported yet" — the empty state's heading every page with a period selector prints (review of b2c9db7,
 * 2026-10-12). One phrase now, the empty state's (`notImportedTitle`).
 */

const OCTOBER: SpendingPace = {
  monthLabel: "October 2026",
  actualToDateCents: 0,
  projectedCents: 0,
  uncoveredDays: 13,
  points: [],
  freeToSpendCents: null,
  href: "/spending",
};

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("SpendingPaceWidget — a month nobody has imported", () => {
  test("says what the category headline and every empty state say of the same month, word for word", () => {
    const html = render(OCTOBER);
    const title = emptyPeriodCopy({ kind: "after-records", uncoveredDays: 13 }, "October 2026", "2026-08-12", (d) => d).title;
    expect(title).toBe("October 2026 has not been imported yet");
    expect(text(html)).toContain(`Free to spend — ${title}`);
    expect(html).not.toContain("is not imported yet");
  });

  test("a month read in part keeps its figures, marked as floors", () => {
    const partly = { ...OCTOBER, actualToDateCents: 12_000, projectedCents: 40_000, uncoveredDays: 2, freeToSpendCents: 50_000 };
    expect(text(render(partly))).toContain("≈ $500.00 at least $120.00 spent · at least $400.00 projected");
  });
});

function render(pace: SpendingPace): string {
  return renderToStaticMarkup(createElement(SpendingPaceWidget, { pace }));
}
