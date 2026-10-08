import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AlreadyDueCard } from "./AlreadyDueCard";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function render(overdue: { date: string; amountCents: number; occurrenceCount: number; unreadCents: number }): {
  heading: string;
  headingClass: string;
  text: string;
} {
  const html = decode(renderToStaticMarkup(createElement(AlreadyDueCard, { overdue, toleranceDays: 3 })));
  const h2 = /<h2 class="([^"]*)">([\s\S]*?)<\/h2>/.exec(html);
  return {
    headingClass: h2?.[1] ?? "",
    heading: (h2?.[2] ?? "").replace(/<[^>]+>/g, ""),
    text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
  };
}

/**
 * 🔴 `/recurring/<Flamingo South Beach (rent)>` on a copy of his ledger 2026-10-08 — "Already due, and not posted" in
 * warning colour over "Oct 1, 2026 -$2,109.00", a day no import has reached (Wells Fargo is read through Sep 24). The
 * runway on the same ledger: "came due earlier this month and no import has covered it yet". ⚖️ Staleness between
 * uploads is normal, never a warning (his words 2026-08-05).
 */
describe("AlreadyDueCard — the bill's own page follows the runway's read/unread split", () => {
  test("a day no import has reached is a quiet heading in the runway's words", () => {
    const r = render({ date: "2026-10-01", amountCents: -210900, occurrenceCount: 1, unreadCents: 210900 });
    expect(r.heading).toBe("Already due — no import has covered it yet");
    expect(r.headingClass).not.toContain("text-warning");
    expect(r.text).not.toMatch(/not posted/);
    expect(r.text).toContain("Oct 1, 2026");
  });

  test("a read day with nothing posted keeps the warning", () => {
    const r = render({ date: "2026-10-01", amountCents: -210900, occurrenceCount: 1, unreadCents: 0 });
    expect(r.heading).toBe("Already due, and not posted");
    expect(r.headingClass).toContain("text-warning");
  });

  test("a mix says both, and counts the ones behind the first", () => {
    const r = render({ date: "2026-07-01", amountCents: -3000, occurrenceCount: 3, unreadCents: 1000 });
    expect(r.heading).toBe("Already due: $20.00 not posted, and no import has covered the other $10.00 yet");
    expect(r.headingClass).toContain("text-warning");
    expect(r.text).toContain("Jul 1, 2026 and 2 more");
  });
});
