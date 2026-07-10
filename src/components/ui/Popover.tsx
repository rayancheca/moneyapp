"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction, ToggleEvent } from "react";
import { computePosition, type Placement } from "@/lib/positioning";

export interface PopoverTriggerProps<T extends HTMLElement> {
  ref: RefObject<T | null>;
  onClick: () => void;
  onPointerDown: () => void;
}

export interface UsePopoverResult<T extends HTMLElement> {
  anchorRef: RefObject<T | null>;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  close: () => void;
  /** Spread onto the trigger element; wires the ref and toggle-on-click. */
  triggerProps: PopoverTriggerProps<T>;
}

export function usePopover<T extends HTMLElement = HTMLElement>(): UsePopoverResult<T> {
  const anchorRef = useRef<T>(null);
  const [open, setOpen] = useState(false);
  // Light dismiss fires on pointerdown, before the trigger's click event —
  // without remembering the pre-dismiss state, clicking the trigger of an
  // open popover would close it and instantly reopen it.
  const openAtPointerDownRef = useRef(false);

  const onPointerDown = useCallback(() => {
    openAtPointerDownRef.current = open;
  }, [open]);

  const onClick = useCallback(() => {
    const wasOpen = openAtPointerDownRef.current;
    openAtPointerDownRef.current = false;
    if (wasOpen) return;
    setOpen((current) => !current);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return {
    anchorRef,
    open,
    setOpen,
    close,
    triggerProps: { ref: anchorRef, onClick, onPointerDown },
  };
}

interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** Called when the popover light-dismisses natively (outside click, Esc). */
  onClose: () => void;
  placement?: Placement;
  offset?: number;
  className?: string;
  children: ReactNode;
}

/**
 * Generic anchored floating layer on popover="auto": native top layer and
 * light dismiss, positioned by the flip+clamp util on open, scroll, resize.
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  placement = "bottom-start",
  offset,
  className,
  children,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const element = popoverRef.current;
    if (!anchor || !element) return;
    const rect = anchor.getBoundingClientRect();
    const position = computePosition(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { placement, offset },
    );
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }, [anchorRef, placement, offset]);

  useEffect(() => {
    const element = popoverRef.current;
    if (!element) return;
    if (!open) {
      if (element.matches(":popover-open")) element.hidePopover();
      return;
    }
    if (!element.matches(":popover-open")) element.showPopover();
    reposition();
    // The flip/clamp decision is computed against the CURRENT content size —
    // a panel that grows while open (filtered lists, async content) would
    // otherwise keep a stale position and overflow the viewport.
    const observer = new ResizeObserver(() => reposition());
    observer.observe(element);
    const anchor = anchorRef.current;
    if (anchor) observer.observe(anchor);
    // capture-phase so scrolls inside nested containers also reposition
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    window.addEventListener("resize", reposition, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition, anchorRef]);

  const handleToggle = (event: ToggleEvent<HTMLDivElement>) => {
    // Sync native light dismiss back into React state.
    if (event.newState === "closed" && open) onClose();
  };

  return (
    <div
      ref={popoverRef}
      popover="auto"
      onToggle={handleToggle}
      // inset-auto neutralizes the UA's inset: 0 so the inline left/top from
      // the positioning util are not over-constrained; the max-width mirrors
      // the util's 8px viewport padding on each side.
      className={`fixed inset-auto m-0 max-w-[calc(100vw-16px)] rounded-(--radius-overlay) border border-line bg-surface-overlay p-0 text-ink shadow-(--shadow-overlay) ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
