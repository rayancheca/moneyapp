"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode, RefObject, ToggleEvent } from "react";
import { computePosition, type Placement } from "@/lib/positioning";
import { OVERLAY_PRESS } from "./letterpress";

const SHOW_DELAY_MS = 300;

export interface TooltipTriggerProps<T extends HTMLElement> {
  ref: RefObject<T | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<T>) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<T>) => void;
  "aria-describedby": string;
}

interface TooltipProps<T extends HTMLElement> {
  /** Tooltip body — methodology/basis annotations, kept short. */
  content: ReactNode;
  placement?: Placement;
  /** Render prop: spread the given props onto a single trigger element. */
  children: (props: TooltipTriggerProps<T>) => ReactNode;
}

/**
 * Hover/focus tooltip: 300ms hover intent, immediate on keyboard focus,
 * hides on leave/blur/Esc — and on a hide from outside, which it follows.
 * popover="manual" (not "auto") so hovering an annotation never
 * light-dismisses an open menu/popover stack.
 */
export function Tooltip<T extends HTMLElement = HTMLElement>({
  content,
  placement = "top",
  children,
}: TooltipProps<T>) {
  const id = useId();
  const triggerRef = useRef<T>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);

  const cancelDelay = useCallback(() => {
    if (delayRef.current === null) return;
    clearTimeout(delayRef.current);
    delayRef.current = null;
  }, []);

  const hide = useCallback(() => {
    cancelDelay();
    setOpen(false);
  }, [cancelDelay]);

  const handleMouseEnter = useCallback(() => {
    cancelDelay();
    // ⛔ not on a control the page has made `inert` while the hover waited: a deck stepped, the card this ⓘ is on went
    // behind, and the tooltip would open over the card brought forward (CardDeck's `turn`, Tooltip.test.ts)
    delayRef.current = setTimeout(() => {
      if (!triggerRef.current?.closest("[inert]")) setOpen(true);
    }, SHOW_DELAY_MS);
  }, [cancelDelay]);

  // A hide from outside is this tooltip's own: a deck stepping past the card it is on hides it (CardDeck's `turn`),
  // and a hover opens it with no blur or leave to come — a two-finger swipe moves no pointer. Followed, as Popover
  // follows a light dismiss; 🔴 unfollowed, the tooltip held itself open with nothing on screen, and the deck left it
  // floating.
  const handleToggle = useCallback(
    (event: ToggleEvent<HTMLSpanElement>) => {
      if (event.newState === "closed") hide();
    },
    [hide],
  );

  const handleFocus = useCallback((event: FocusEvent<T>) => {
    // Immediate on keyboard focus only; pointer use rides the hover delay.
    if (event.currentTarget.matches(":focus-visible")) setOpen(true);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      if (event.key === "Escape") hide();
    },
    [hide],
  );

  useEffect(() => cancelDelay, [cancelDelay]);

  useEffect(() => {
    const element = tooltipRef.current;
    if (!element) return;
    if (!open) {
      if (element.matches(":popover-open")) element.hidePopover();
      return;
    }
    element.showPopover();
    const anchor = triggerRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const position = computePosition(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { placement },
    );
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }, [open, placement]);

  return (
    <>
      {children({
        ref: triggerRef,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: hide,
        onFocus: handleFocus,
        onBlur: hide,
        onKeyDown: handleKeyDown,
        "aria-describedby": id,
      })}
      {/* A <span>, NOT a <div> — and deliberately with no display utility.
       *
       * Jargon lives in prose, so a tooltip has to be mountable inside a <p>.
       * The HTML parser hoists a <div> out of an open <p> and closes the <p>
       * early, which is an SSR/hydration mismatch rather than a lint error
       * (measured: a <div> so placed reparents to BODY and the <p> loses its
       * trailing text). A <span> is phrasing content and stays put.
       *
       * No `block` class: `position: fixed` already blockifies the span when it
       * is shown, while a display utility would OVERRIDE the UA rule that hides
       * a closed popover — measured, that leaves every tooltip permanently on
       * screen. Closed reads `display: none`, open reads `display: block`. */}
      <span
        ref={tooltipRef}
        id={id}
        role="tooltip"
        popover="manual"
        onToggle={handleToggle}
        className={`fixed inset-auto m-0 max-w-64 rounded-md border border-line bg-surface-overlay px-2 py-1 text-xs text-ink ${OVERLAY_PRESS}`}
      >
        {content}
      </span>
    </>
  );
}
