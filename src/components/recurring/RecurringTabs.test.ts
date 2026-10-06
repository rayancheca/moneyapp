import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/recurring",
  // a refused "Detect now" landed here on a linked row height
  useSearchParams: () => new URLSearchParams("error=Detection%20failed&tab=calendar&cal=compact"),
}));

const { RecurringTabs } = await import("./RecurringTabs");

/**
 * ⚖️ Owner 2026-10-06 (§6A 40), the period arrows' rule: a tab keeps every view the URL holds —
 * the calendar's `cal` — and moves on from a refused action's `?error=` banner, as it always has.
 */
describe("RecurringTabs — each tab keeps the calendar's view the URL holds", () => {
  test("every tab's link carries `cal`, and none the banner", () => {
    const html = renderToStaticMarkup(
      createElement(RecurringTabs, { tab: "calendar", counts: { upcoming: 1, all: 2, calendar: 3 } }),
    );
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href!.replaceAll("&amp;", "&"));

    expect(hrefs).toEqual([
      "/recurring?tab=upcoming&cal=compact",
      "/recurring?tab=all&cal=compact",
      "/recurring?tab=calendar&cal=compact",
    ]);
  });
});
