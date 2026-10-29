import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { CardDeck, type DeckCard } from "./CardDeck";

/** A card the way the dashboard deals one: rooted in its sheet, a heading and a link on it. */
const card = (id: string): DeckCard => ({
  id,
  label: id,
  node: createElement(
    SurfaceCard,
    null,
    createElement("h3", null, `${id} heading`),
    createElement("a", { href: `/${id}` }, `${id} link`),
  ),
});

const markup = (count: number): string => {
  const cards = Array.from({ length: count }, (_, i) => card(`card-${i}`));
  return renderToStaticMarkup(createElement(CardDeck, { cards, ariaLabel: "What this means" }));
};

/** Each card's slot — the deck's own wrapper around a card — as its opening tag, in deck order. */
function slots(html: string): string[] {
  const tags = [...html.matchAll(/<div\b[^>]*>/g)].map((m) => m[0]);
  return tags.filter((tag) => tag.includes('class="absolute inset-x-0 top-0'));
}

const classes = (tag: string): string[] => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
const isFront = (tag: string): boolean => tag.includes('aria-current="true"');

/**
 * 🔴 A card behind the front showed a line of its CONTENT in the stack's edge. Each one is stretched to the front
 * card's height and clipped, so whatever it holds at that height lands in the strip below the front: Earned vs
 * banked's "…the arrangement can have quietly ended — nothing here can tell those apart.", faint, in the gate's own
 * baselines (dashboard-light-1024, dashboard-light-320, dashboard-dark-320). And every card behind took Tab focus:
 * 16 links and 14 buttons behind Runway on his ledger copy, 2026-10-29, each a focus ring on a card nobody can see.
 */
describe("a card behind the front shows its sheet and nothing on it", () => {
  test("the front card is drawn as it always was — nothing hidden, nothing inert", () => {
    const front = slots(markup(4)).filter(isFront);
    expect(front).toHaveLength(1);
    expect(front[0]).not.toContain("inert");
    expect(classes(front[0]!)).not.toContain("*:*:opacity-0");
    expect(classes(front[0]!)).not.toContain("overflow-hidden");
  });

  test("every card behind it hides what is ON its sheet, and keeps the sheet", () => {
    /*
     * ⛔ The card's CHILDREN, never the card: its root is its sheet (pinned below), and `*:opacity-0` would hide the
     * sheet with the content — no strip, no stack. ⚠️ Opacity, never `visibility` or `display`: decision-cards.spec
     * reads the cards behind the front through innerText (every `.figures`), finds Earned vs banked's "Schedule →" by
     * its role and asks Eating out's heading `toBeVisible()`, and all three survive `opacity: 0` and nothing else.
     */
    const behind = slots(markup(4)).filter((tag) => !isFront(tag));
    expect(behind).toHaveLength(3);
    for (const tag of behind) {
      expect(classes(tag)).toContain("*:*:opacity-0");
      for (const never of ["*:opacity-0", "*:*:invisible", "*:*:hidden", "*:invisible", "*:hidden"]) {
        expect(classes(tag)).not.toContain(never);
      }
      // still the stack's edge: stretched to the front card's height and clipped
      expect(classes(tag)).toEqual(expect.arrayContaining(["overflow-hidden", "*:h-full"]));
    }
  });

  test("every card behind it is out of the pointer AND the Tab order", () => {
    // `inert`, as the house hides a covered panel (Disclosure, InstitutionCard): a link under the front card can be
    // neither clicked through it nor tabbed to behind it
    const behind = slots(markup(5)).filter((tag) => !isFront(tag));
    expect(behind).toHaveLength(4);
    for (const tag of behind) {
      expect(tag).toMatch(/\binert=""/);
      expect(tag).toContain("pointer-events:none");
    }
  });

  test("⛔ nothing is lost — every card's content is still in the document", () => {
    // hidden from the eye and the Tab key, never unmounted: the text is the page's, and the grid's count is the deck's
    const html = markup(5);
    for (let i = 0; i < 5; i += 1) {
      expect(html).toContain(`card-${i} heading`);
      expect(html).toContain(`href="/card-${i}"`);
    }
  });

  test("a deck of one has nothing behind it", () => {
    const only = slots(markup(1));
    expect(only).toHaveLength(1);
    expect(isFront(only[0]!)).toBe(true);
    expect(only[0]).not.toContain("inert");
  });
});

/**
 * ⛔ An arrow pressed from a link ON the front card sends that card behind, and a card behind is `inert`: the browser
 * drops a focus left inside it to the page, where the next arrow steps nothing. So the deck takes the focus first —
 * the one tab stop that says where you are. Source, not render: a server render fires no keys, and there is no DOM here.
 */
describe("a step pressed from inside the front card leaves the focus on the deck", () => {
  test("the key handler hands the focus to the deck when the key came from a card", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/dashboard/CardDeck.tsx"), "utf8");
    const handler = source.slice(source.indexOf("const onKeyDown"), source.indexOf("if (count === 0) return null;"));
    expect(handler).toContain("event.preventDefault();");
    expect(handler).toContain(
      "if (event.target !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });",
    );
  });
});

/**
 * ⛔ The rule above hides a card's CHILDREN, so it is right only while the card's root IS its sheet — a card wrapped in
 * a `<div>` would hand the deck its sheet as a child and lose it, and a stack of bare content has no edge at all. So
 * every card the dashboard deals (its `decisionCards`, the deck's one caller) must return its `<SurfaceCard>` and
 * nothing around it. All twelve on his ledger copy did, 2026-10-29, rendered from his own data.
 */
describe("every card the dashboard deals is rooted in its sheet", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
  const dealt = [...page.matchAll(/node: <(\w+) data=/g)].map((m) => m[1]!);

  test("there are cards to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(dealt.length).toBeGreaterThanOrEqual(13);
  });

  test.each(dealt)("%s returns its SurfaceCard, and only that", (name) => {
    const from = new RegExp(`import \\{ ${name} \\} from "@/([^"]+)";`).exec(page)?.[1];
    expect(from, `no import of ${name} in page.tsx`).toBeDefined();
    const source = fs.readFileSync(path.join(process.cwd(), "src", `${from}.tsx`), "utf8");
    const start = source.indexOf(`export function ${name}(`);
    expect(start, `no exported ${name}`).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    // the component's own returns sit at its top level, two spaces in; a nested callback's sit deeper
    const roots = [...body.matchAll(/^ {2}return\b\s*\(?\s*(<[\w.]+|[^\s;]+)/gm)].map((m) => m[1]);
    expect(roots).toEqual(["<SurfaceCard"]);
  });
});
