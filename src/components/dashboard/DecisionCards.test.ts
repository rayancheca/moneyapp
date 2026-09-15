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
