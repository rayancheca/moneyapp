import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { resolvePeriod, type PeriodParams } from "@/lib/period";

/** the URL on screen, as the router committed it */
const onScreen = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/spending",
  useSearchParams: () => new URLSearchParams(onScreen.search),
}));

const { PeriodSelector } = await import("./PeriodSelector");

const TODAY = "2026-10-06";

/** every link the bar renders, by its accessible name: an arrow's label, else its text */
function links(search: string, params: PeriodParams): Map<string, string> {
  onScreen.search = search;
  const html = renderToStaticMarkup(
    createElement(PeriodSelector, { period: resolvePeriod(params, TODAY), today: TODAY }),
  );
  const out = new Map<string, string>();
  for (const [, attrs, inner] of html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)) {
    const href = /href="([^"]*)"/.exec(attrs!)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const name = /aria-label="([^"]*)"/.exec(attrs!)?.[1] ?? inner!.replace(/<[^>]*>/g, "");
    out.set(name, href);
  }
  return out;
}

/**
 * ⚖️ Owner 2026-10-06 (§6A 40): every link of the bar keeps a view only the URL held, the way a
 * press does, and replaces the period params alone. 🔴 Each wrote the period alone:
 * `?period=2026-07&where=relief` with List saved, ‹, and June opened on List.
 */
describe("PeriodSelector — its links keep every view the URL on screen holds", () => {
  test("‹ ›, each granularity and the reset carry the views, in a new period", () => {
    const july = links("period=2026-07&where=relief&cash=table", { period: "2026-07" });

    expect(july.get("Previous period")).toBe("/spending?period=2026-06&where=relief&cash=table");
    expect(july.get("Next period")).toBe("/spending?period=2026-08&where=relief&cash=table");
    expect(july.get("This month")).toBe("/spending?period=2026-10&where=relief&cash=table");
    expect(july.get("Year")).toBe("/spending?period=2026&where=relief&cash=table");
    for (const [name, href] of july) {
      expect(href, name).toMatch(/^\/spending\?period=[^&]+&where=relief&cash=table$/);
    }
  });

  test("from a custom range, a period replaces its from and to; a step keeps it a range", () => {
    const range = links("from=2026-05-01&to=2026-05-20&where=relief", { from: "2026-05-01", to: "2026-05-20" });

    expect(range.get("Month")).toBe("/spending?period=2026-05&where=relief");
    expect(range.get("Previous period")).toBe("/spending?from=2026-04-11&to=2026-04-30&where=relief");
  });
});
