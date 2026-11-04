import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { findElement, HookSlots } from "@/hooks/hook-slots.harness";
import { CardDeck, type DeckCard } from "./CardDeck";

/*
 * The deck's hooks, routed to a `HookSlots` while a test below steps the deck through its own handlers, and to React
 * otherwise — so the static renders in this file stay real renders.
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

/** Somewhere the focus can be on a stepped deck's page, named the way a test says where it went. */
interface Spot {
  name: string;
  /** the card it is on, for a spot inside the deck */
  on?: string;
}

/**
 * A popover on a card, as the browser keeps one: a provenance panel (`Popover`, `popover="auto"`), which takes the
 * focus when it opens, or an ⓘ's tooltip (`Tooltip`, `popover="manual"`), which never does.
 */
interface Panel {
  kind: "auto" | "manual";
  open: boolean;
  /** where the focus is while it is inside the panel */
  inside: Spot;
}

interface SlotProps {
  "aria-current"?: string;
  inert?: boolean;
  className: string;
}

/**
 * A deck of `count`, stepped through its own code — a key, the wheel, a drag, a click — on a page that holds a focus
 * and drops it the way the browser does: ⛔ a focus left inside a card a step sent behind is dropped to the page,
 * because that card is `inert` now. That is the whole failure, and with the focus on the page a key never reaches the
 * deck at all — the next arrow steps nothing. A card can hold a panel (`openPanel`), hidden as the browser hides one.
 */
function steppedDeck(count: number) {
  const slots = new HookSlots();
  const ids = Array.from({ length: count }, (_, i) => `card-${i}`);
  const cards = ids.map(card);
  const deckIn = (tree: ReactNode) => {
    const deck = findElement(tree, "div", { role: "group" });
    if (!deck) throw new Error("no deck in the render");
    return deck;
  };
  const draw = (): ReactNode => slots.render(CardDeck, { cards, ariaLabel: "What this means" });
  const handler = (name: string) => deckIn(draw()).props[name] as (event: unknown) => void;

  // the page: where the focus is, a link on every card, and the deck's own element, put where React would put it
  const thePage: Spot = { name: "the page" };
  const doc: { activeElement: Spot } = { activeElement: thePage };
  const links = new Map(ids.map((id): [string, Spot] => [id, { name: `${id}'s link`, on: id }]));
  const listeners = new Map<string, (event: unknown) => void>();
  // the panels opened on its cards (`openPanel`), and where hiding one sends a focus inside it
  const panels: Panel[] = [];
  let hiddenTo: Spot = thePage;
  /** a selector the deck asks the panels by — attributes and `:popover-open`, read as the browser reads them */
  const selects = (panel: Panel, selector: string): boolean =>
    (selector.match(/\[[^\]]*\]|:[\w-]+/g) ?? [""]).every((part) =>
      part === ":popover-open" ? panel.open : part === "[popover]" || part === `[popover="${panel.kind}"]`,
    );
  const deck = {
    name: "the deck",
    ownerDocument: doc,
    // every spot on a card is inside the deck; the page, a pip, Previous and Next are not
    contains: (node: unknown): boolean => node === deck || (node as Spot).on !== undefined,
    focus: vi.fn((_options?: FocusOptions) => {
      doc.activeElement = deck;
    }),
    getBoundingClientRect: () => ({ width: 400 }),
    addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, listener),
    removeEventListener: () => undefined,
    querySelectorAll: (selector: string) =>
      panels
        .filter((panel) => selects(panel, selector))
        .map((panel) => ({
          matches: (other: string) => selects(panel, other),
          // the browser's half of hiding one: a focus inside it goes back to where it was before the panel opened
          hidePopover: () => {
            panel.open = false;
            if (doc.activeElement === panel.inside) doc.activeElement = hiddenTo;
          },
        })),
  };
  (deckIn(draw()).props.ref as { current: unknown }).current = deck;

  const slotsNow = () =>
    (deckIn(draw()).props.children as ReactElement<SlotProps>[]).map((slot) => ({
      id: String(slot.key),
      front: slot.props["aria-current"] === "true",
      inert: slot.props.inert === true,
      classes: slot.props.className.split(/\s+/),
    }));

  // the browser's half of a step: a focus left inside a card that is inert now is dropped to the page
  const settle = () => {
    const { on } = doc.activeElement;
    if (on !== undefined && slotsNow().find((slot) => slot.id === on)?.inert) doc.activeElement = thePage;
  };

  // one gesture a second after the last one ended, so none lands inside the wheel's burst window
  let clock = 1_000;
  /** the deck's wheel listener, mounted once as the page mounts it */
  const wheelListener = (): ((event: unknown) => void) => {
    if (!listeners.has("wheel")) {
      // the deck listens for the wheel in an effect, and reduced motion reads its media query in another
      const query = { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined };
      vi.stubGlobal("window", { matchMedia: () => query });
      draw();
      slots.mount();
    }
    const listener = listeners.get("wheel");
    if (!listener) throw new Error("the deck listens for no wheel");
    return listener;
  };
  /** one gesture: the focus the deck took while it ran (each call's options), and what it kept from the browser */
  const gesture = (fire: (preventDefault: () => void) => void) => {
    const before = deck.focus.mock.calls.length;
    const preventDefault = vi.fn();
    clock += 1_000;
    fire(preventDefault);
    settle();
    return { focus: deck.focus.mock.calls.slice(before).map(([options]) => options), preventDefault };
  };

  return {
    /** what the live region announces: the card at the front, and where it sits */
    position: (): string => textOf(findElement(draw(), "p", { "aria-live": "polite" })?.props.children),
    /** where the focus is now */
    focused: (): string => doc.activeElement.name,
    focusOn(where: "a link on the front card" | "the deck") {
      const front = slotsNow().find((slot) => slot.front)?.id ?? "";
      doc.activeElement = where === "the deck" ? deck : (links.get(front) ?? thePage);
    },
    /**
     * A panel opened on the front card, as a click opens one: a provenance panel takes the focus as it opens
     * (`ProvenancePopover`), a tooltip opens on a hover and takes none. `hidden` is where hiding it sends a focus
     * inside it — Chromium hands it back to the button the click focused; WebKit, which never focuses a button on a
     * click, has nothing to hand it back to and drops it to the page.
     */
    openPanel(kind: Panel["kind"], hidden: "back to its button" | "to the page" = "back to its button"): Panel {
      const front = slotsNow().find((slot) => slot.front)?.id ?? "";
      const panel: Panel = { kind, open: true, inside: { name: `inside ${front}'s panel`, on: front } };
      panels.push(panel);
      hiddenTo = hidden === "to the page" ? thePage : { name: `${front}'s panel button`, on: front };
      if (kind === "auto") doc.activeElement = panel.inside;
      return panel;
    },
    /** how each card is drawn now, in deck order */
    drawn: (): string[] =>
      slotsNow().map(({ id, front, inert, classes }) => {
        const marks: [boolean, string][] = [
          [true, front ? "in front" : "behind"],
          [inert, "inert"],
          [classes.includes("overflow-hidden") && classes.includes("*:h-full"), "clipped to the front"],
          [classes.includes("*:*:opacity-0"), "its sheet only"],
        ];
        return `${id}: ${marks
          .filter(([on]) => on)
          .map(([, mark]) => mark)
          .join(", ")}`;
      }),
    /** the deck with `front` in front, as it must be drawn: that card whole and live, every other its sheet, inert */
    inFront: (front: string): string[] =>
      ids.map((id) => `${id}: ${id === front ? "in front" : "behind, inert, clipped to the front, its sheet only"}`),
    /** a key, pressed where the focus is: with the focus on the page, or on a pip, the deck never hears it */
    press: (key: string) =>
      gesture((preventDefault) => {
        const target = doc.activeElement;
        if (deck.contains(target)) handler("onKeyDown")({ key, target, currentTarget: deck, preventDefault });
      }),
    /** a wheel tick over the deck — a trackpad's two-finger swipe arrives as `deltaX` */
    wheel: (deltaX: number, deltaY = 0) =>
      gesture((preventDefault) => wheelListener()({ deltaX, deltaY, timeStamp: clock, preventDefault })),
    /** a trackpad's two-finger swipe as it comes: `ticks` horizontal wheel events, `apart` ms apart */
    swipe: (deltaX: number, ticks: number, apart: number) =>
      gesture((preventDefault) => {
        const listener = wheelListener();
        for (let tick = 0; tick < ticks; tick += 1) {
          listener({ deltaX, deltaY: 0, timeStamp: clock + tick * apart, preventDefault });
        }
        clock += (ticks - 1) * apart;
      }),
    /** a drag across the front card's own text (one that starts on a control is that control's), `dx` px */
    drag: (dx: number) =>
      gesture(() => {
        const target = { closest: () => null };
        const currentTarget = { setPointerCapture: () => undefined };
        handler("onPointerDown")({ pointerId: 1, clientX: 200, timeStamp: clock, target, currentTarget });
        handler("onPointerUp")({ pointerId: 1, clientX: 200 + dx, timeStamp: clock + 200 });
      }),
    /** a click on a pip, Previous or Next — outside the deck, where the click puts the focus */
    click: (label: string) =>
      gesture(() => {
        const button = findElement(draw(), "button", { "aria-label": label });
        if (!button) throw new Error(`no "${label}" button`);
        doc.activeElement = { name: label };
        (button.props.onClick as () => void)();
      }),
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
    { key: "ArrowRight", first: undefined, front: "card-1", to: "card-1 — card 2 of 4" },
    { key: "ArrowLeft", first: undefined, front: "card-3", to: "card-3 — card 4 of 4" },
    { key: "End", first: undefined, front: "card-3", to: "card-3 — card 4 of 4" },
    { key: "Home", first: "End", front: "card-0", to: "card-0 — card 1 of 4" },
  ])("$key pressed on a link on the front card steps the deck, and the deck takes the focus", (row) => {
    const deck = steppedDeck(4);
    if (row.first) {
      deck.focusOn("the deck");
      deck.press(row.first);
    }
    deck.focusOn("a link on the front card");
    const { focus, preventDefault } = deck.press(row.key);
    expect(deck.position()).toBe(row.to);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    // the card the link was on is behind now, inert and its sheet only, and the card brought forward is whole and
    // live — 🔴 only the first half was checked here (the review of 04c5fd30; the walk below)
    expect(deck.drawn()).toEqual(deck.inFront(row.front));
    // once, and without a scroll: a bare focus() brings the deck's top into view, above a link low on a tall card
    expect(focus).toEqual([{ preventScroll: true }]);
    expect(deck.focused()).toBe("the deck");
  });

  test("the next arrow, pressed on the deck, steps again and leaves the focus where it is", () => {
    const deck = steppedDeck(4);
    deck.focusOn("a link on the front card");
    deck.press("ArrowRight");
    const { focus, preventDefault } = deck.press("ArrowRight");
    expect(deck.position()).toBe("card-2 — card 3 of 4");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focus).toEqual([]);
    expect(deck.focused()).toBe("the deck");
  });

  test.each(["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "PageDown", "a"])(
    "⛔ %j pressed on a link on the front card is the browser's: the deck neither steps nor takes the focus",
    (key) => {
      const deck = steppedDeck(4);
      deck.focusOn("a link on the front card");
      const { focus, preventDefault } = deck.press(key);
      expect(focus).toEqual([]);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(deck.position()).toBe("card-0 — card 1 of 4");
      expect(deck.focused()).toBe("card-0's link");
    },
  );
});

/**
 * ⛔ The hand-off is a step's, whichever way the step is taken — not the arrow keys' alone.
 *
 * 🔴 Only the key handler handed the focus over. A horizontal wheel — a trackpad's two-finger swipe — sent the card
 * holding the focus behind, and Chromium dropped it to <body>: after a click on Runway's "What Runway means", one swipe
 * and ← → stepped nothing (the review of 04c5fd30, in headless Chromium). Runway is his front card, with that ⓘ, four
 * more and six links on it (his ledger copy, 2026-10-29). The wheel listens in an effect, which `HookSlots` never ran,
 * so no test could reach it; `mount` runs it now.
 */
describe("every way a step is taken from inside the deck hands the focus over", () => {
  afterEach(() => vi.unstubAllGlobals());

  test.each([
    { way: "an arrow key", step: (deck: ReturnType<typeof steppedDeck>) => deck.press("ArrowRight") },
    { way: "a trackpad swipe (a horizontal wheel)", step: (deck: ReturnType<typeof steppedDeck>) => deck.wheel(120) },
    // a mouse's press focuses the deck before it drags; a finger's drag moves no focus
    { way: "a drag that moved no focus", step: (deck: ReturnType<typeof steppedDeck>) => deck.drag(-200) },
  ])("$way from a link on the front card: the deck takes the focus, and the next arrow steps", ({ step }) => {
    const deck = steppedDeck(4);
    deck.focusOn("a link on the front card");
    const { focus } = step(deck);
    expect(deck.position()).toBe("card-1 — card 2 of 4");
    expect(deck.drawn()).toEqual(deck.inFront("card-1"));
    expect(focus).toEqual([{ preventScroll: true }]);
    expect(deck.focused()).toBe("the deck");

    deck.press("ArrowRight");
    expect(deck.position()).toBe("card-2 — card 3 of 4");
  });

  test("⛔ a vertical wheel is the reader scrolling the page: no step, and the focus stays where it is", () => {
    const deck = steppedDeck(4);
    deck.focusOn("a link on the front card");
    const { focus, preventDefault } = deck.wheel(0, 120);
    expect(deck.position()).toBe("card-0 — card 1 of 4");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).toEqual([]);
    expect(deck.focused()).toBe("card-0's link");
  });

  test.each([
    { control: "Next card", front: "card-1" },
    { control: "Previous card", front: "card-3" },
    { control: "card-2", front: "card-2" },
  ])("⛔ $control, clicked, steps and keeps the focus where the click put it — outside the deck", (row) => {
    // a pip or Previous pressed again and again from the keyboard must stay where it is, not jump into the deck
    const deck = steppedDeck(4);
    const { focus } = deck.click(row.control);
    expect(deck.drawn()).toEqual(deck.inFront(row.front));
    expect(focus).toEqual([]);
    expect(deck.focused()).toBe(row.control);
  });

  test("⛔ the front card is moved in one place — the step that hands the focus over", () => {
    // a new way in that set the front card itself would skip the hand-off, as the wheel's step did
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/dashboard/CardDeck.tsx"), "utf8");
    expect(source.match(/\bsetActive\(/g) ?? []).toHaveLength(1);
    const step = source.slice(source.indexOf("const turn = useCallback("), source.indexOf("const go = useCallback("));
    expect(step).toMatch(/\.focus\(\{ preventScroll: true \}\)[^]*\bsetActive\(/);
  });
});

type SteppedDeck = ReturnType<typeof steppedDeck>;

/**
 * ⛔ A horizontal wheel is the deck's alone, and one swipe is one card. A trackpad's two-finger swipe that also reached
 * the browser would scroll the page sideways or swipe back through its history; and a trackpad sends a tick every
 * frame for as long as the fingers move, so a deck that stepped on every tick would spin through the stack.
 *
 * 🔴 Neither was pinned: dropping the wheel's `preventDefault`, or its burst lock, left all 41 tests green (the review
 * of 5b123d41). Only the vertical wheel was asked what it kept from the browser, and every gesture here came a second
 * apart, so no two ticks ever fell inside one burst.
 */
describe("a trackpad swipe over the deck", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("is one card however many ticks it sends, and every tick is kept from the browser", () => {
    const deck = steppedDeck(4);
    deck.focusOn("the deck");
    // a frame apart: 19 ticks 16 ms apart are 288 ms of fingers moving
    const { preventDefault } = deck.swipe(120, 19, 16);
    expect(deck.position()).toBe("card-1 — card 2 of 4");
    expect(preventDefault).toHaveBeenCalledTimes(19);
    // the next swipe, once the fingers have lifted, is the next card — and a swipe back is the card before
    deck.swipe(120, 19, 16);
    expect(deck.position()).toBe("card-2 — card 3 of 4");
    deck.swipe(-120, 19, 16);
    expect(deck.position()).toBe("card-1 — card 2 of 4");
  });

  test.each([
    { apart: 319, to: "card-1 — card 2 of 4" },
    { apart: 320, to: "card-2 — card 3 of 4" },
  ])("a second tick $apart ms after the one that stepped: $to", ({ apart, to }) => {
    // the burst ends 320 ms after the tick that stepped: at 319 ms a tick is still that swipe's, at 320 a new one's
    const deck = steppedDeck(4);
    deck.focusOn("the deck");
    deck.swipe(120, 2, apart);
    expect(deck.position()).toBe(to);
  });
});

/**
 * ⛔ A step closes a panel left open on the card it sends behind. 🔴 It floated over the next card: with On your cards
 * in front, "How what you owe is known — 3 of 3 add up" clicked open, then → — Eating out came forward under a panel
 * still reading "$2,624.16 across 3 cards…", inside a card now inert, so nothing in it could be clicked (the review of
 * d27f4f8f, his ledger copy 2026-10-29). Four of his twelve cards carry one: On your cards, What the banks charge you,
 * What you are riding on, and Worth a look two (his ledger copy, 2026-10-30).
 */
describe("a panel left open on the front card", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ways = [
    { way: "an arrow key pressed in it", step: (deck: SteppedDeck) => deck.press("ArrowRight") },
    { way: "a trackpad swipe", step: (deck: SteppedDeck) => deck.wheel(120) },
    { way: "a drag that moved no focus", step: (deck: SteppedDeck) => deck.drag(-200) },
  ];
  test.each(
    ways.flatMap((row) => [
      { ...row, browser: "Chromium", hidden: "back to its button" as const },
      { ...row, browser: "WebKit", hidden: "to the page" as const },
    ]),
  )("is closed by $way ($browser), and the focus that was in it goes to the deck", ({ step, hidden }) => {
    const deck = steppedDeck(4);
    const panel = deck.openPanel("auto", hidden);
    expect(deck.focused()).toBe("inside card-0's panel");
    step(deck);
    expect(deck.position()).toBe("card-1 — card 2 of 4");
    expect(panel.open).toBe(false);
    expect(deck.focused()).toBe("the deck");
    // …so the next arrow steps
    deck.press("ArrowRight");
    expect(deck.position()).toBe("card-2 — card 3 of 4");
  });

  test("a pip clicked outside the deck closes it too, and the focus stays on the pip", () => {
    // the browser's light dismiss closes it on that click anyway; the deck closes it whoever holds the focus
    const deck = steppedDeck(4);
    const panel = deck.openPanel("auto");
    const { focus } = deck.click("card-2");
    expect(deck.drawn()).toEqual(deck.inFront("card-2"));
    expect(panel.open).toBe(false);
    expect(focus).toEqual([]);
    expect(deck.focused()).toBe("card-2");
  });

  test("⛔ an ⓘ's tooltip is not the deck's to close", () => {
    // its open state is `Tooltip`'s, which a hide from outside would leave holding it open — it closes on the blur
    // the hand-off causes, and on a pointer leaving it
    const deck = steppedDeck(4);
    const tip = deck.openPanel("manual");
    deck.focusOn("a link on the front card");
    deck.press("ArrowRight");
    expect(deck.position()).toBe("card-1 — card 2 of 4");
    expect(tip.open).toBe(true);
  });
});

/**
 * 🔴 Every check of how the cards are drawn ran with card 1 of N in front, and a step checked only the card it left
 * behind (the review of 04c5fd30): a deck that kept the card brought forward inert, or its content hidden, or that
 * showed card 1's content once it went behind, left all 32 tests green. Kept inert, the card brought forward is dead
 * to the pointer and to Tab, which skipped it for "Previous card" in Chromium — every card after Runway. So the deck
 * is walked the whole way round, every way in, and drawn after every step.
 */
test("after every step, whichever way it was taken, the card in front is whole and every other is its sheet", () => {
  const deck = steppedDeck(4);
  deck.focusOn("the deck");
  const walk: [string, () => unknown, string][] = [
    ["ArrowRight", () => deck.press("ArrowRight"), "card-1"],
    ["ArrowRight", () => deck.press("ArrowRight"), "card-2"],
    ["ArrowRight", () => deck.press("ArrowRight"), "card-3"],
    ["ArrowRight, round to the first", () => deck.press("ArrowRight"), "card-0"],
    ["ArrowLeft, round to the last", () => deck.press("ArrowLeft"), "card-3"],
    ["Home", () => deck.press("Home"), "card-0"],
    ["End", () => deck.press("End"), "card-3"],
    ["a swipe forward", () => deck.wheel(120), "card-0"],
    ["a swipe back", () => deck.wheel(-120), "card-3"],
    ["a drag left", () => deck.drag(-200), "card-0"],
    ["a drag right", () => deck.drag(200), "card-3"],
    ["card-2's pip", () => deck.click("card-2"), "card-2"],
    ["Previous", () => deck.click("Previous card"), "card-1"],
    ["Next", () => deck.click("Next card"), "card-2"],
  ];
  try {
    for (const [how, step, front] of walk) {
      step();
      expect(deck.drawn(), `after ${how}`).toEqual(deck.inFront(front));
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

/** A card written out: its `id`, and the component its `node` is one element of — or null when it is not that. */
function cardOf(literal: ts.ObjectLiteralExpression): { id: string; name: string } | null {
  const props = literal.properties.filter(ts.isPropertyAssignment);
  // every property written out: a spread of another card could carry any `node`
  if (props.length !== literal.properties.length) return null;
  const value = (name: string) => props.find((prop) => prop.name.getText() === name)?.initializer;
  const id = value("id");
  const node = value("node");
  const opening = node && ts.isJsxElement(node) ? node.openingElement : node;
  const element = opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) ? opening : null;
  const tag = element?.tagName;
  return id && ts.isStringLiteral(id) && tag && ts.isIdentifier(tag) ? { id: id.text, name: tag.text } : null;
}

/**
 * The deal in page.tsx, read by the compiler: every card written out in `decisionCards`, and the text of everything
 * in it — or in the deck's call — the sweep cannot read as one. A card is an object literal of plain properties, a
 * string `id` and a `node` that is one element of a named component; it is spread in only from
 * `cond ? [card, …] : []`; and the deck is handed `decisionCards` itself. Anything else — a card from a variable, a
 * call or a cast, a list spread in — is unread, because nothing here can say what that card's component returns.
 */
function readDeal(source: string): { cards: { id: string; name: string }[]; unread: string[] } {
  const file = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bare = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? bare(node.expression) : node;
  const cards: { id: string; name: string }[] = [];
  const unread: string[] = [];
  const read = (element: ts.Expression): void => {
    const card = ts.isObjectLiteralExpression(element) ? cardOf(element) : null;
    if (card) cards.push(card);
    else unread.push(element.getText(file));
  };
  let dealt = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "decisionCards") {
      const deal = node.initializer && bare(node.initializer);
      if (!deal || !ts.isArrayLiteralExpression(deal)) throw new Error("page.tsx's decisionCards is not written out");
      dealt = true;
      for (const element of deal.elements) {
        const spread = ts.isSpreadElement(element) ? bare(element.expression) : null;
        const cond = spread && ts.isConditionalExpression(spread) ? spread : null;
        const [then, otherwise] = cond ? [bare(cond.whenTrue), bare(cond.whenFalse)] : [null, null];
        if (!spread) read(element);
        else if (then && ts.isArrayLiteralExpression(then) && otherwise?.getText(file) === "[]") {
          then.elements.forEach(read);
        } else unread.push(element.getText(file));
      }
    }
    const jsx = ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node) ? node : null;
    if (jsx?.tagName.getText(file) === "DecisionCards") {
      // the deck is handed the deal itself, never a list built around it
      const handed = jsx.attributes.properties.find((prop) => prop.name?.getText(file) === "cards");
      const value = handed && ts.isJsxAttribute(handed) ? handed.initializer : undefined;
      if (value?.getText(file) !== "{decisionCards}") unread.push(jsx.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!dealt) throw new Error("page.tsx deals no decisionCards");
  return { cards, unread };
}

/**
 * ⛔ The rule above hides a card's CHILDREN, so it is right only while the card's root IS its sheet — a card wrapped in
 * a `<div>` would hand the deck its sheet as a child and lose it, and a stack of bare content has no edge at all. So
 * every card the dashboard deals (its `decisionCards`, the deck's one caller) must return its `<SurfaceCard>` and
 * nothing around it. All twelve on his ledger copy did, 2026-10-29, rendered from his own data.
 *
 * 🔴 The sweep read the deal with `node: <(\w+) data=`, which skipped a card handed any other first prop, and its floor
 * of 13 could not tell: a fourteenth card rooted in a `<div>`, or dealt as a variable, left every test green (the
 * review of d27f4f8f; both measured 2026-10-29). So a card is found by the id every DeckCard carries, and the sweep
 * must have read the component of every one. 🔴 …by two regexes, and the review of 04c5fd30 dealt that card past them
 * four more ways, every test green (the first four rows below). The compiler reads the deal now (`readDeal`).
 */
describe("every card the dashboard deals is rooted in its sheet", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
  const { cards: dealt, unread } = readDeal(page);

  test("the sweep reads every card dealt", () => {
    // guards the guard: a deal it cannot find proves nothing
    expect(dealt.length, "no card found in page.tsx's decisionCards").toBeGreaterThanOrEqual(13);
    // every card is written out where it is dealt, so the sweep has read the component of every one
    expect(unread).toEqual([]);
  });

  /** page.tsx with `line` dealt as one more card, at the end of the deal */
  const dealing = (line: string): string => {
    const end = page.indexOf("\n  ];", page.indexOf("const decisionCards"));
    if (end < 0) throw new Error("page.tsx's decisionCards has no end");
    return `${page.slice(0, end)}\n    ${line}${page.slice(end)}`;
  };

  // a fourteenth card rooted in a `<div>` (ZzCard), dealt each way: read as ZzCard, whose root the test below then
  // checks, or named as unread
  test.each([
    { how: "a variable in the deal's conditional", line: "...(runway ? [zzCard] : [])," },
    { how: "a card a call builds", line: "zzCardFor(runway)," },
    { how: "a list spread in", line: "...(extraCards)," },
    { how: "a card cast to one", line: "zzCard as DeckCard," },
    { how: "a card from a variable", line: "zzCard," },
    { how: "a card in the other branch", line: "...(runway ? [] : [zzCard])," },
    { how: "a node a spread overrides", line: '{ id: "zz", node: <RunwayCard data={runway} />, ...zzCard },' },
    { how: "a card whose node is chosen", line: '{ id: "zz", node: runway ? <ZzCard /> : null },' },
    { how: "a first prop other than data", line: '{ id: "zz", node: <ZzCard key="zz" data={runway} /> },' },
    { how: "the deal's own conditional", line: '...(runway ? [{ id: "zz", node: <ZzCard data={runway} /> }] : []),' },
  ])("⛔ $how: caught", ({ line }) => {
    const { cards, unread: missed } = readDeal(dealing(line));
    const caught = missed.length > 0 || cards.some((c) => c.name === "ZzCard");
    expect(caught, `read as ${cards.map((c) => c.name).join(", ")}`).toBe(true);
  });

  test("⛔ a card added where the deal is handed to the deck: caught", () => {
    const handed = page.replace("cards={decisionCards}", "cards={[...decisionCards, zzCard]}");
    expect(handed, "page.tsx hands the deck no `cards={decisionCards}`").not.toBe(page);
    expect(readDeal(handed).unread).toHaveLength(1);
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
