import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { findElement, HookSlots } from "@/hooks/hook-slots.harness";
import { Tooltip, type TooltipTriggerProps } from "./Tooltip";

/*
 * The tooltip's hooks, routed to a `HookSlots` while a test steps it through its own handlers, and to React otherwise —
 * its id fixed, which `HookSlots` does not keep.
 */
vi.mock("react", async (importOriginal) => ({
  ...(await import("@/hooks/hook-slots.harness")).routeHooks(await importOriginal<typeof import("react")>()),
  useId: () => "tip",
}));

const SHOW_DELAY_MS = 300;

/**
 * One ⓘ and its tooltip, stepped through the tooltip's own code: a hover and the wait it rides, the browser's popover
 * as the browser keeps one, and a deck that can make the card the ⓘ is on `inert` — the card a step sends behind.
 */
function anInfoTip() {
  const slots = new HookSlots();
  let trigger: TooltipTriggerProps<HTMLButtonElement> | null = null;
  const component = Tooltip as unknown as (props: object) => ReactNode;
  const draw = (): ReactNode =>
    slots.render(component, {
      content: "What it means",
      children: (props: TooltipTriggerProps<HTMLButtonElement>) => {
        trigger = props;
        return createElement("button", { type: "button" });
      },
    });
  const tooltip = (tree: ReactNode) => {
    const span = findElement(tree, "span", { role: "tooltip" });
    if (!span) throw new Error("no tooltip in the render");
    return span;
  };

  // the browser's popover: open or not, how many times it has opened, and the `toggle` each change queues for a task
  // later — whoever showed or hid it
  const toggles: ("open" | "closed")[] = [];
  const popover = {
    open: false,
    opened: 0,
    style: {} as Record<string, string>,
    offsetWidth: 160,
    offsetHeight: 24,
    matches: (selector: string): boolean => selector === ":popover-open" && popover.open,
    showPopover: (): void => {
      if (popover.open) return;
      popover.open = true;
      popover.opened += 1;
      toggles.push("open");
    },
    hidePopover: (): void => {
      if (!popover.open) return;
      popover.open = false;
      toggles.push("closed");
    },
  };
  // the ⓘ, on a card a deck can send behind: `inert` then, as every card behind the front is
  const button = {
    inert: false,
    getBoundingClientRect: () => ({ x: 120, y: 200, width: 20, height: 20 }),
    closest: (selector: string): object | null => (selector === "[inert]" && button.inert ? {} : null),
  };

  const first = draw();
  (tooltip(first).props.ref as { current: unknown }).current = popover;
  (trigger!.ref as { current: unknown }).current = button;
  /**
   * every `toggle` a show or a hide queued handed to the tooltip, as the browser hands it over a task later — then the
   * tooltip drawn again for the state it holds now and its effects run, as React runs them after a change — until
   * nothing more changes. ⚠️ `HookSlots` runs every effect on each mount, where React runs one only when what it reads
   * has changed: a toggle the page queued must arrive before the tooltip draws again, as it does in the browser.
   */
  const commit = (): void => {
    for (let round = 0; round < 4; round += 1) {
      const onToggle = tooltip(draw()).props.onToggle as ((event: { newState: string }) => void) | undefined;
      for (const newState of toggles.splice(0)) onToggle?.({ newState });
      draw();
      slots.mount();
      if (toggles.length === 0) return;
    }
    throw new Error("the tooltip never settled");
  };
  commit();

  return {
    popover,
    /** the pointer reaches the ⓘ, and stays */
    hover: () => trigger!.onMouseEnter(),
    /** the pointer leaves it */
    leave: () => trigger!.onMouseLeave(),
    /** time passes, and the tooltip shows what its state now says */
    wait: (ms: number) => {
      vi.advanceTimersByTime(ms);
      commit();
    },
    /** a deck steps: the card the ⓘ is on goes behind, `inert` */
    stepBehind: () => {
      button.inert = true;
    },
    /** something outside the tooltip hides its popover, a deck stepping past it, and the browser's `toggle` follows */
    hiddenFromOutside: () => {
      popover.hidePopover();
      commit();
    },
  };
}

/**
 * ⛔ A tooltip a deck stepped past stays closed. 🔴 The deck left an ⓘ's tooltip to `Tooltip`, which closes on a blur
 * or a pointer leaving the ⓘ, and a hover opens it with neither: a two-finger swipe moves no pointer, so the tooltip
 * floated over the card the swipe brought forward until the pointer moved — 8.5 s in a probe of the deck's step, with
 * no `mouseleave` and the ⓘ still `:hover` (the browser pane's Chromium, 2026-11-05). The deck's step hides it now
 * (CardDeck's `turn`), and the tooltip hears that as Popover hears a light dismiss.
 */
describe("an ⓘ's tooltip a deck steps past", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a hover opens it once the pointer has rested on the ⓘ", () => {
    const tip = anInfoTip();
    tip.hover();
    tip.wait(SHOW_DELAY_MS - 1);
    expect(tip.popover.open).toBe(false);
    tip.wait(1);
    expect(tip.popover.open).toBe(true);
  });

  test("hidden from outside, it holds itself closed — and the next hover opens it again", () => {
    // 🔴 a hide from outside left `Tooltip` holding its own state open, with nothing on screen: the reason the deck
    // left tooltips alone (batch 9 G)
    const tip = anInfoTip();
    tip.hover();
    tip.wait(SHOW_DELAY_MS);
    tip.hiddenFromOutside();
    expect(tip.popover.open).toBe(false);
    tip.wait(SHOW_DELAY_MS);
    expect(tip.popover.open).toBe(false);
    expect(tip.popover.opened).toBe(1);

    tip.leave();
    tip.hover();
    tip.wait(SHOW_DELAY_MS);
    expect(tip.popover.open).toBe(true);
    expect(tip.popover.opened).toBe(2);
  });

  test("⛔ a hover still waiting when the deck steps opens nothing over the card brought forward", () => {
    // the deck's step finds no tooltip open to hide, and the ⓘ it was waiting on is behind now, `inert`
    const tip = anInfoTip();
    tip.hover();
    tip.wait(SHOW_DELAY_MS / 2);
    tip.stepBehind();
    tip.wait(SHOW_DELAY_MS);
    expect(tip.popover.opened).toBe(0);
    expect(tip.popover.open).toBe(false);
  });
});
