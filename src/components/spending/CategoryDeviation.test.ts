import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CategoryDeviation } from "./CategoryDeviation";

/**
 * ⛔ A label names the window it measured. Once "What moved" can be cut to the
 * days both windows share, the page's period is not what the panel measured —
 * so the caption, the accessible name and the empty state all carry the cut
 * windows, and the panel says where they stop.
 */
const CUT = { currentLabel: "Aug 1 – 12, 2026", previousLabel: "Jul 1 – 12, 2026" };
const NOTE =
  "Both windows stop on Aug 12, 2026, the last day every account you spend from has been imported through, so the same days are set side by side.";

describe("CategoryDeviation names the windows it measured", () => {
  test("a cut comparison captions both windows, says where they stop, and names them to a screen reader", () => {
    const rows = [
      { key: "food", label: "Food", currentCents: 4_000, previousCents: 20_000, previousCount: 1 },
      { key: "shop", label: "Shopping", currentCents: 1_000, previousCents: 3_000, previousCount: 1 },
    ];
    const html = renderToStaticMarkup(createElement(CategoryDeviation, { rows, ...CUT, note: NOTE }));
    expect(html).toContain("Aug 1 – 12, 2026 against Jul 1 – 12, 2026 — biggest moves first");
    expect(html).toContain(NOTE);
    expect(html).toContain("2 categories moved in Aug 1 – 12, 2026 against Jul 1 – 12, 2026: 0 up, 2 down.");
    expect(html).not.toContain("the previous period");
  });

  test("the note stands over the empty state too", () => {
    const rows = [{ key: "food", label: "Food", currentCents: 4_000, previousCents: 4_000, previousCount: 1 }];
    const html = renderToStaticMarkup(createElement(CategoryDeviation, { rows, ...CUT, note: NOTE }));
    expect(html).toContain("No category changed between Jul 1 – 12, 2026 and Aug 1 – 12, 2026.");
    expect(html).toContain(NOTE);
  });
});
