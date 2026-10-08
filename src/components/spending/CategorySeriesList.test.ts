import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CategorySeriesRow } from "@/services/category-detail";
import { CategorySeriesList } from "./CategorySeriesList";

function rent(unreadCents: number): CategorySeriesRow {
  return {
    id: "rent",
    name: "Flamingo South Beach (rent)",
    cadence: "monthly",
    amountCents: -210900,
    nextExpectedOn: "2026-11-01",
    overdue: { date: "2026-10-01", occurrenceCount: 1, owedCents: 210900, unreadCents },
    status: "confirmed",
    isActive: true,
    evidence: "active",
    label: null,
    href: "/recurring/rent",
  };
}

function noteOf(row: CategorySeriesRow): string {
  const html = renderToStaticMarkup(createElement(CategorySeriesList, { rows: [row], today: "2026-10-08" }));
  const at = html.lastIndexOf("<span", html.indexOf("Oct 1 —"));
  return html.slice(at, html.indexOf("</span>", at)).replace(/<!-- -->/g, "");
}

/**
 * 🔴 "monthly · next Nov 1 · Oct 1 — not posted", in warning colour, under `/categories/<Housing>` on a copy of his
 * ledger 2026-10-08 — of a day no import had reached, beside a runway saying "no import has covered it yet". The
 * note's second caller follows the same split as the first (`overdueNote`).
 */
describe("CategorySeriesList — the late note follows the runway's read/unread split", () => {
  test("unread: quiet, in the runway's words", () => {
    const note = noteOf(rent(210900));
    expect(note).toContain("Oct 1 — no import has covered it yet");
    expect(note).not.toContain("text-warning");
  });

  test("read and unposted: the warning stays", () => {
    const note = noteOf(rent(0));
    expect(note).toContain("Oct 1 — not posted");
    expect(note).toContain("text-warning");
  });
});
