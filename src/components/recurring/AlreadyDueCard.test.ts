import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CarriedGrace } from "@/lib/occurrence-verdict";
import { AlreadyDueCard } from "./AlreadyDueCard";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function render(
  overdue: { date: string; amountCents: number; occurrenceCount: number; unreadCents: number; inGraceCents?: number },
  graceDays = 3,
  carriedGrace: CarriedGrace | null = null,
): {
  heading: string;
  headingClass: string;
  text: string;
} {
  // an import is what the unread part waits for, unless a test says its days to post are
  const props = { overdue: { inGraceCents: 0, ...overdue, graceDays, carriedGrace } };
  const html = decode(renderToStaticMarkup(createElement(AlreadyDueCard, props)));
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

  /*
   * ⚖️ §6A 60: the read half waited for the grace the arrears carry (`graceDays`) — for a bill paid inside the rent's
   * payment, the rent's when it is wider — so the card names that grace, not the series' own `toleranceDays`.
   */
  test("the body names the grace the read waited for", () => {
    const r = render({ date: "2026-10-01", amountCents: -18221, occurrenceCount: 1, unreadCents: 0 }, 5);
    expect(r.text).toContain("which reach 5 days past it, hold no posting within 5 days of it");
  });

  // …and billed inside the rent with a window of its own of another width, each by name (`overdue.carriedGrace`)
  test("the body names the windows that grace is made of — its own 3 days, the rent's 5", () => {
    const carried = { ownDays: 3, carrierName: "Flamingo South Beach (rent)", carrierDays: 5 };
    const r = render({ date: "2026-10-01", amountCents: -18221, occurrenceCount: 1, unreadCents: 0 }, 5, carried);
    expect(r.text).toContain(
      "which reach 5 days past it, hold no posting of its own within 3 days of it, and none of the rent's payments " +
        "within 5 days of it.",
    );
  });

  /*
   * 🔴 An archived card's bill, its days to post not over, read "Already due — no import has covered it yet" (review of
   * the 2026-10-08 batch): an import that will never come. The card passes what no import keeps unread through.
   */
  test("a day waiting only for its days to post says so — quiet, and no 'import'", () => {
    const r = render({
      date: "2026-10-06",
      amountCents: -4500,
      occurrenceCount: 1,
      unreadCents: 4500,
      inGraceCents: 4500,
    });
    expect(r.heading).toBe("Already due — the days a payment has to post are not over yet");
    expect(r.headingClass).not.toContain("text-warning");
    expect(r.text).not.toMatch(/import/);
  });

  test("a mix says both, and counts the ones behind the first", () => {
    const r = render({ date: "2026-07-01", amountCents: -3000, occurrenceCount: 3, unreadCents: 1000 });
    expect(r.heading).toBe("Already due: $20.00 not posted, and no import has covered the other $10.00 yet");
    expect(r.headingClass).toContain("text-warning");
    expect(r.text).toContain("Jul 1, 2026 and 2 more");
  });
});
