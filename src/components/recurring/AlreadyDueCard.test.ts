import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AlreadyDueCard } from "./AlreadyDueCard";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function render(
  overdue: { date: string; amountCents: number; occurrenceCount: number; unreadCents: number },
  graceDays = 3,
): {
  heading: string;
  headingClass: string;
  text: string;
} {
  const html = decode(renderToStaticMarkup(createElement(AlreadyDueCard, { overdue: { ...overdue, graceDays } })));
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
  test("a day no checked statement has reached is a quiet heading in the runway's words", () => {
    const r = render({ date: "2026-10-01", amountCents: -210900, occurrenceCount: 1, unreadCents: 210900 });
    expect(r.heading).toBe("Already due — no statement has covered it yet");
    expect(r.headingClass).not.toContain("text-warning");
    expect(r.text).not.toMatch(/not posted/);
    expect(r.text).toContain("Oct 1, 2026");
  });

  test("a read day with nothing posted keeps the warning", () => {
    const r = render({ date: "2026-10-01", amountCents: -210900, occurrenceCount: 1, unreadCents: 0 });
    expect(r.heading).toBe("Already due, and not posted");
    expect(r.headingClass).toContain("text-warning");
  });

  /*
   * ⚖️ §6A 60: the read half waited for the grace the arrears carry (`graceDays`) — for a bill paid inside the rent's
   * payment, the rent's when it is wider — so the card names that grace, not the series' own `toleranceDays`.
   */
  test("the body names the grace the read waited for", () => {
    const r = render({ date: "2026-10-01", amountCents: -18221, occurrenceCount: 1, unreadCents: 0 }, 5);
    expect(r.text).toContain("the statements reach 5 days past it with no posting within 5 days of it");
  });

  /*
   * 🔴 The body said "it" of every bill — the statements "reach 3 days past it" and hold nothing "within 3 days of it"
   * — over a line reading "Jul 2, 2026 and 1 more": a weekly bill owing two due days this month. ⛔ The card says the
   * body of the due days it lists (`occurrenceCount`), not of the first.
   */
  test("a bill owing two due days says the body of both, as its line counts them", () => {
    const read = render({ date: "2026-07-02", amountCents: -14000, occurrenceCount: 2, unreadCents: 0 });
    expect(read.text).toContain("Jul 2, 2026 and 1 more");
    expect(read.text).toContain(
      "Both due days are inside this calendar month, and the statements reach 3 days past each with no posting " +
        "within 3 days of either. The forecast counts both, and so does this month's budget.",
    );
    const unread = render({ date: "2026-07-02", amountCents: -14000, occurrenceCount: 2, unreadCents: 14000 });
    expect(unread.text).toContain("no statement reaches 3 days past either yet");
  });

  test("a mix says both, and counts the ones behind the first", () => {
    const r = render({ date: "2026-07-01", amountCents: -3000, occurrenceCount: 3, unreadCents: 1000 });
    expect(r.heading).toBe("Already due: $20.00 not posted, and no statement has covered the other $10.00 yet");
    expect(r.headingClass).toContain("text-warning");
    expect(r.text).toContain("Jul 1, 2026 and 2 more");
  });
});
