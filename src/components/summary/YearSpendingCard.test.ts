import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Provenance } from "@/services/provenance";
import type { YearSpendingView } from "@/services/year-insights";
import { YearSpendingCard } from "./YearSpendingCard";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const proof: Provenance = { verdict: "manual", headline: "A proof.", sources: [], checkedThrough: null, inputs: [], badgeWord: "a proof" };
const note = "These are money out — counted in none of this page's totals, which are all money in.";

const render = (view: YearSpendingView): string => decode(renderToStaticMarkup(createElement(YearSpendingCard, { view })));

/**
 * 🔴 With insights off, /summary/[year] printed no spending figure at all — the
 * total and the change lived only inside the two sentences. The card now prints
 * them either way, and the tests pin both forms.
 */
describe("YearSpendingCard — the figures survive the insights switch", () => {
  test("off: the total and the signed change print with their badges, under the same heading and note", () => {
    const html = render({
      windowLabel: "Jan 1 – Aug 12, 2026",
      windowNote: note,
      insights: null,
      figures: [
        { key: "measured_total:f1", kind: "total", label: "Spent", cents: 6_647_760, subject: "Spending in Jan 1 – Aug 12, 2026", provenance: proof },
        {
          key: "rose_between:f2",
          kind: "change",
          label: "Change from Jan 1 – Aug 12, 2025",
          cents: 4_295_002,
          subject: "Spending change between Jan 1 – Aug 12, 2025 and Jan 1 – Aug 12, 2026",
          provenance: proof,
        },
      ],
    });
    expect(html).toContain(">What you spent</h2>");
    expect(html).toContain("Jan 1 – Aug 12, 2026");
    expect(html).toContain(note);
    expect(html).toContain("<dt class=\"text-ink-muted\">Spent</dt>");
    expect(html).toContain("$66,477.60");
    expect(html).toContain("Change from Jan 1 – Aug 12, 2025");
    expect(html).toContain("+$42,950.02");
    expect(html).toContain('aria-label="How Spending in Jan 1 – Aug 12, 2026 is known — a proof"');
    // not the insight list: nothing here is a sentence the switch turned off
    expect(html).not.toContain('id="ledger-insights"');
    // a badge's popover is a div, and a div may never sit inside a <p>
    expect(html).not.toMatch(/<p(?:\s[^>]*)?>(?:(?!<\/p>).)*<div/s);
  });

  test("a fall prints its minus, and an exact zero claims no direction", () => {
    const base = { windowLabel: "2024", windowNote: note, insights: null };
    const change = (cents: number) =>
      render({ ...base, figures: [{ key: "k", kind: "change", label: "Change from 2023", cents, subject: "Spending change", provenance: null }] });
    expect(change(-237_290)).toContain("-$2,372.90");
    expect(change(0)).toContain(">$0.00<");
    expect(change(0)).not.toContain("-$0.00");
  });

  test("on: the card is the insight list it always was", () => {
    const html = render({
      windowLabel: "2025",
      windowNote: note,
      insights: {
        windowLabel: "2025",
        windowNote: note,
        insights: [{ id: "measured_total:f1", text: "Spending in 2025 came to $41,501.86.", claimId: "measured_total", provenance: proof }],
      },
      figures: [],
    });
    expect(html).toContain('id="ledger-insights"');
    expect(html).toContain("<span>Spending in 2025 came to $41,501.86.</span>");
    expect(html).not.toContain("<dl");
  });
});
