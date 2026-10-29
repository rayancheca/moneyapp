import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { findElement, HookSlots } from "@/hooks/hook-slots.harness";
import { CardDeck, type DeckCard } from "./CardDeck";

/*
 * The deck's hooks, routed to a `HookSlots` while a test below presses a key through the deck's own handler, and to
 * React otherwise — so the static renders in this file stay real renders.
 */
vi.mock("react", async (importOriginal) =>
  (await import("@/hooks/hook-slots.harness")).routeHooks(await importOriginal<typeof import("react")>()),
);

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

const textOf = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(textOf).join("");
  return typeof node === "string" || typeof node === "number" ? `${node}` : "";
};

/** A deck of `count`, stepped through its own code: a key pressed where the focus is, and what the deck did. */
function steppedDeck(count: number) {
  const slots = new HookSlots();
  const cards = Array.from({ length: count }, (_, i) => card(`card-${i}`));
  const deckIn = (tree: ReactNode) => {
    const deck = findElement(tree, "div", { role: "group" });
    if (!deck) throw new Error("no deck in the render");
    return deck;
  };
  const draw = (): ReactNode => slots.render(CardDeck, { cards, ariaLabel: "What this means" });
  return {
    /** what the live region announces: the card at the front, and where it sits */
    position: (): string => textOf(findElement(draw(), "p", { "aria-live": "polite" })?.props.children),
    /** whether the card `id` is `inert` now */
    inert: (id: string): boolean =>
      (deckIn(draw()).props.children as ReactElement<{ inert?: boolean }>[]).find((slot) => slot.key === id)?.props
        .inert === true,
    press(key: string, on: "a link on the front card" | "the deck") {
      const deck = { focus: vi.fn() };
      const target = on === "the deck" ? deck : { tagName: "A" };
      const event = { key, target, currentTarget: deck, preventDefault: vi.fn() };
      (deckIn(draw()).props.onKeyDown as (event: unknown) => void)(event);
      return { focus: deck.focus, preventDefault: event.preventDefault };
    },
  };
}

/**
 * ⛔ An arrow pressed from a link ON the front card sends that card behind, and a card behind is `inert`: the browser
 * drops a focus left inside it to the page, where the next arrow steps nothing. So the deck takes the focus first —
 * the one tab stop that says where you are — and for a STEP only.
 *
 * 🔴 That was pinned by the handler's source text, which stayed green when the hand-off moved up to the handler's first
 * line: every key took the focus then, and Tab never left the deck — DECK, "What Runway means", DECK, … from "Cash you
 * can spend today" on his ledger copy, 2026-10-29 (the review of d27f4f8f). So the keys are pressed through the deck's
 * own handler here, stepped by `HookSlots`: where it steps to, what it keeps from the browser, where the focus goes.
 */
describe("a key pressed inside the deck", () => {
  test.each([
    { key: "ArrowRight", first: undefined, to: "card-1 — card 2 of 4" },
    { key: "ArrowLeft", first: undefined, to: "card-3 — card 4 of 4" },
    { key: "End", first: undefined, to: "card-3 — card 4 of 4" },
    { key: "Home", first: "End", to: "card-0 — card 1 of 4" },
  ])("$key pressed on a link on the front card steps the deck, and the deck takes the focus", ({ key, first, to }) => {
    const deck = steppedDeck(4);
    if (first) deck.press(first, "the deck");
    const was = deck.position().split(" — ")[0]!;
    const { focus, preventDefault } = deck.press(key, "a link on the front card");
    expect(deck.position()).toBe(to);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    // the card the link is on is behind now, and inert: a focus left on it would be dropped to the page
    expect(deck.inert(was)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    // …and no scroll: a bare focus() brings the deck's top into view, and a link low on a tall card sits below it
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("the next arrow, pressed on the deck, steps again and leaves the focus where it is", () => {
    const deck = steppedDeck(4);
    deck.press("ArrowRight", "a link on the front card");
    const { focus, preventDefault } = deck.press("ArrowRight", "the deck");
    expect(deck.position()).toBe("card-2 — card 3 of 4");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });

  test.each(["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "PageDown", "a"])(
    "⛔ %j pressed on a link on the front card is the browser's: the deck neither steps nor takes the focus",
    (key) => {
      const deck = steppedDeck(4);
      const { focus, preventDefault } = deck.press(key, "a link on the front card");
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(deck.position()).toBe("card-0 — card 1 of 4");
    },
  );
});

/**
 * ⛔ The rule above hides a card's CHILDREN, so it is right only while the card's root IS its sheet — a card wrapped in
 * a `<div>` would hand the deck its sheet as a child and lose it, and a stack of bare content has no edge at all. So
 * every card the dashboard deals (its `decisionCards`, the deck's one caller) must return its `<SurfaceCard>` and
 * nothing around it. All twelve on his ledger copy did, 2026-10-29, rendered from his own data.
 *
 * 🔴 The sweep read the deal with `node: <(\w+) data=`, which skipped a card handed any other first prop, and its floor
 * of 13 could not tell: a fourteenth card rooted in a `<div>`, or dealt as a variable, left every test green (the
 * review of d27f4f8f; both measured 2026-10-29). So a card is found by the id every DeckCard carries, and the sweep
 * must have read the component of every one.
 */
describe("every card the dashboard deals is rooted in its sheet", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
  // the deal: `decisionCards`, from its bracket to the section that hands it to the deck
  const deal = page.slice(page.indexOf("const decisionCards: DeckCard[] = ["), page.indexOf("const decisionsSection"));
  const ids = [...deal.matchAll(/\bid: "([^"]+)"/g)].map((m) => m[1]!);
  // each card's component, whatever it is handed
  const dealt = [...deal.matchAll(/\bid: "([^"]+)",[^}]*?\bnode: <(\w+)[\s/>]/g)].map((m) => ({
    id: m[1]!,
    name: m[2]!,
  }));

  test("the sweep reads every card dealt", () => {
    // guards the guard: a deal it cannot find proves nothing
    expect(ids.length, "no card found in page.tsx's decisionCards").toBeGreaterThanOrEqual(13);
    // every card is written out in the deal — spread in only from an inline `(… ? [{ … }] : [])` — so its ids count it
    expect(deal).not.toMatch(/\.\.\.(?!\()|^\s*\w+,?\s*$/m);
    // one node each, and the sweep read the component in every one
    expect(deal.match(/\bnode\b/g) ?? []).toHaveLength(ids.length);
    expect(dealt.map((d) => d.id)).toEqual(ids);
  });

  test.each(dealt)("$name ($id) returns its SurfaceCard, and only that", ({ name }) => {
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
