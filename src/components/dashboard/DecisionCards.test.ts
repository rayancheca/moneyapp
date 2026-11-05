import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { DeckCard } from "./CardDeck";
import { DecisionCards } from "./DecisionCards";

// the count never navigates or persists; the view switcher only needs both to exist
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: async () => undefined }));

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const card = (id: string): DeckCard => ({ id, label: id, node: createElement("p", null, `${id} body`) });

const render = (cards: DeckCard[], mode: string): string =>
  text(renderToStaticMarkup(createElement(DecisionCards, { cards, state: { cards: mode } })));

/**
 * 🔴 "1 readings". The dashboard builds the runway card unconditionally and
 * every other card only when its service has something to say, so a ledger
 * with nothing else to report hands the deck ONE card — and the count above it
 * spelled its noun plural at every size. Not live on the owner's ledger or the
 * e2e fixture (13 cards each, measured 2026-09-15), which is why nothing caught
 * it.
 */
describe("the decision cards' count", () => {
  test.each(["deck", "grid"])("one card is one reading, in the %s", (mode) => {
    const html = render([card("runway")], mode);
    expect(html).toMatch(/\b1 reading\b/);
    expect(html).not.toContain("1 readings");
  });

  test.each(["deck", "grid"])("two cards keep the plural, in the %s", (mode) => {
    expect(render([card("runway"), card("trust")], mode)).toContain("2 readings");
  });
});

/**
 * The grid counts the cards it is dealt: one card takes the full width rather than half of it beside a hole. 🔴 The
 * dashboard counted them a second time, `decisionCardCount`, read by nothing since the deck's first commit (ebcb8f77)
 * and missing Worth a look (removed 2026-11-05).
 */
describe("the decision cards' grid", () => {
  const grid = (count: number): string => {
    const cards = Array.from({ length: count }, (_, i) => card(`card-${i}`));
    return renderToStaticMarkup(createElement(DecisionCards, { cards, state: { cards: "grid" } }));
  };

  test("one card is one column", () => {
    expect(grid(1)).toContain("card-0 body");
    expect(grid(1)).not.toContain("lg:grid-cols-2");
  });

  test("two cards go two across", () => {
    expect(grid(2)).toContain("lg:grid-cols-2");
  });
});
