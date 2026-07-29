"use client";

import { useEffect, useRef } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { Icon, type IconName } from "@/components/shell/Icon";
import { Popover, usePopover } from "@/components/ui/Popover";
import { CONTROL_MOTION } from "@/components/ui/letterpress";
import type { Placement } from "@/lib/positioning";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  onPointerDown: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  "aria-label": string;
}

interface MenuProps {
  /** Accessible name for the trigger and the menu — non-negotiable. */
  label: string;
  items: readonly MenuItem[];
  /** Custom trigger renderer; must spread every prop it receives. */
  trigger?: (props: MenuTriggerProps) => ReactNode;
  placement?: Placement;
}

// Disabled items stay in the DOM AND in the arrow-nav cycle (APG): they use
// aria-disabled, never the native disabled attribute, so keyboard and
// screen-reader users still discover the command and hear it as unavailable.
const MENUITEM_SELECTOR = '[role="menuitem"]';

/**
 * The ⋯ verb menu: Popover + role=menu list. Arrow keys cycle (Home/End
 * jump), Enter/Space select (native button activation), Tab or focus leaving
 * the menu closes it, Esc and outside clicks light-dismiss natively — the
 * browser returns focus to the trigger on close.
 */
export function Menu({ label, items, trigger, placement = "bottom-end" }: MenuProps) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // The child Popover's effect has already shown the popover by the time
    // this parent effect runs, so the first item is focusable.
    listRef.current?.querySelector<HTMLButtonElement>(MENUITEM_SELECTOR)?.focus();
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      // APG: Tab exits the menu. Close (syncing aria-expanded) WITHOUT
      // preventDefault so the browser moves focus along the natural
      // sequence; native popover focus-restoration only kicks in while
      // focus is still inside, so it cannot yank focus back.
      close();
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const menuItems = Array.from(list.querySelectorAll<HTMLButtonElement>(MENUITEM_SELECTOR));
    if (menuItems.length === 0) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      menuItems[event.key === "Home" ? 0 : menuItems.length - 1]?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const currentIndex = menuItems.findIndex((item) => item === document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    // when focus is not on an item, ↓ lands on the first and ↑ on the last
    const from = currentIndex === -1 ? (delta === 1 ? -1 : 0) : currentIndex;
    menuItems[(from + delta + menuItems.length) % menuItems.length]?.focus();
  };

  const handleFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    // Focus escaping the menu by any path (Tab past the ends, programmatic
    // moves) closes it so the trigger's aria-expanded can never go stale
    // while a detached menu floats over unrelated content.
    const next = event.relatedTarget;
    if (next instanceof Node && listRef.current?.contains(next)) return;
    close();
  };

  const fullTriggerProps: MenuTriggerProps = {
    ...triggerProps,
    "aria-expanded": open,
    "aria-haspopup": "menu",
    "aria-label": label,
  };

  return (
    <>
      {trigger ? (
        trigger(fullTriggerProps)
      ) : (
        // plain button (not IconButton) because the popover anchor needs a ref
        <button
          type="button"
          {...fullTriggerProps}
          className={`inline-flex size-8 items-center justify-center rounded-full font-medium text-ink-muted ${CONTROL_MOTION} hover:bg-surface-leaf hover:text-ink`}
        >
          <Icon name="more" />
        </button>
      )}
      <Popover anchorRef={anchorRef} open={open} onClose={close} placement={placement}>
        <div
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          onBlur={handleFocusOut}
          className="min-w-40 p-1"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled === true ? true : undefined}
              onClick={() => {
                if (item.disabled === true) return; // perceivable but inert
                close();
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-(--duration-tap) ease-(--ease-ink) focus:bg-surface-leaf not-aria-disabled:hover:bg-surface-leaf aria-disabled:text-ink-faint ${
                item.destructive ? "text-negative" : "text-ink"
              }`}
            >
              {item.icon ? <Icon name={item.icon} className="size-4 shrink-0" /> : null}
              {item.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
