import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

// the URL on screen, per test — a refused "Detect now" landed here on a linked row height, by default
let onScreen = "error=Detection%20failed&tab=calendar&cal=compact";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/recurring",
  useSearchParams: () => new URLSearchParams(onScreen),
}));

const { RecurringTabs } = await import("./RecurringTabs");

const hrefsOf = (tab: "upcoming" | "all" | "calendar"): string[] => {
  const html = renderToStaticMarkup(
    createElement(RecurringTabs, { tab, counts: { upcoming: 1, all: 2, calendar: 3 } }),
  );
  return [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href!.replaceAll("&amp;", "&"));
};

/**
 * ⚖️ Owner 2026-10-06 (§6A 40), the period arrows' rule: a tab keeps every view the URL holds —
 * the calendar's `cal` — and moves on from a refused action's `?error=` banner, as it always has.
 */
describe("RecurringTabs — each tab keeps the calendar's view the URL holds", () => {
  test("every tab's link carries `cal`, and none the banner", () => {
    onScreen = "error=Detection%20failed&tab=calendar&cal=compact";
    expect(hrefsOf("calendar")).toEqual([
      "/recurring?tab=upcoming&cal=compact",
      "/recurring?tab=all&cal=compact",
      "/recurring?tab=calendar&cal=compact",
    ]);
  });

  /*
   * ⛔ …and none the series a link narrowed the All tab to (`SERIES_LIST_PARAM`): that list is the figure's the reader
   * followed, and a tab is the way back to every series — All's own included, which is the note's "Show all".
   */
  test("no tab's link carries the series a link named", () => {
    onScreen = "tab=all&series=019f72da-1fbc-7000-a434-6840bae2d231,side-gig&cal=compact";
    expect(hrefsOf("all")).toEqual([
      "/recurring?tab=upcoming&cal=compact",
      "/recurring?tab=all&cal=compact",
      "/recurring?tab=calendar&cal=compact",
    ]);
  });
});
