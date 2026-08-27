"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/shell/Icon";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  LAYER_OFFSET_PX,
  VISIBLE_DEPTH,
  clampIndex,
  deckSlot,
  dragOutcome,
  dragTilt,
  stepIndex,
} from "@/lib/card-deck";

/**
 * Twelve cards in the space of one — a stack you swipe, wheel or arrow through.
 *
 * Owner, 2026-08-27: *"instead of having the cards take up al the space in teh
 * world … just stack them on thop of each other … that way you can add as many
 * as you want without flooding the page"*. Twelve full-height cards ran the
 * dashboard past three screens; the deck is one card tall whatever it holds,
 * which is the whole point — a thirteenth costs nothing.
 *
 * ## What it is NOT
 *
 * ⛔ Not a discard pile. A Tinder swipe destroys, and these cards are readings
 * of a ledger rather than decisions — so the gesture is borrowed and the
 * meaning is not. The deck WRAPS and nothing can be lost. See `lib/card-deck`.
 *
 * ## Every way in
 *
 * A gesture nobody can find is a gesture nobody has. So: drag (pointer, which
 * covers touch and mouse alike), the wheel, ← → Home End, and clicking a pip.
 * The pips also do the work a scrollbar does — they say how many there are and
 * where you are, which a stack alone cannot.
 *
 * ## ⚠️ The one layout property that is animated, and why
 *
 * The container's HEIGHT follows the front card's, and that breaks this repo's
 * "compositor-friendly properties only" rule on purpose. The rule exists to
 * stop per-frame layout thrash inside a continuous animation; this is one
 * discrete transition per card change, and the drag itself is pure transform.
 * The alternative — a fixed height at the tallest card — puts a block of empty
 * white inside every short card's box, which the owner has objected to twice
 * (it is why the grid carries `items-start`). Measured against that, a single
 * height transition is the cheaper honesty.
 *
 * ## Accessibility
 *
 * The stack is presentation. Every card stays MOUNTED and in the document, in
 * order, so a screen reader and anything reading the page's text still get all
 * twelve — a deck that hid eleven of them would be a filter wearing a stack.
 * The deck is one tab stop that announces its position; the pips are real
 * buttons; and under `prefers-reduced-motion` nothing transitions at all.
 */

export interface DeckCard {
  /** stable across renders — the React key and the pip's label */
  id: string;
  /** what the pip and the live region call this card */
  label: string;
  node: React.ReactNode;
}

export function CardDeck({ cards, ariaLabel }: { cards: readonly DeckCard[]; ariaLabel: string }) {
  const [active, setActive] = useState(0);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const reduced = usePrefersReducedMotion();

  const deckRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pointer = useRef<{ id: number; x: number; at: number; lastX: number; lastAt: number } | null>(null);
  /* the wheel fires many times per gesture; one step per burst, not per tick */
  const wheelLock = useRef(0);

  const count = cards.length;
  const index = clampIndex(active, count);

  const go = useCallback(
    (direction: 1 | -1) => setActive((current) => stepIndex(clampIndex(current, count), count, direction)),
    [count],
  );

  /*
   * The container height follows the FRONT card. Measured rather than guessed,
   * because a decision card's height depends on its own content — the runway
   * card is three rows and the trust card is twelve.
   */
  useLayoutEffect(() => {
    const el = cardRefs.current[index];
    if (!el) return;
    const measure = () => setHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [index, count]);

  // ── the wheel ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      /*
       * ⛔ Only a HORIZONTAL-dominant wheel steers the deck. A vertical wheel is
       * the reader scrolling the page, and swallowing it would trap them inside
       * a card stack halfway down the dashboard — the classic carousel sin. A
       * trackpad's two-finger swipe arrives here as deltaX, which is exactly
       * the gesture that should turn the card.
       */
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = event.timeStamp;
      if (now - wheelLock.current < 320) return;
      wheelLock.current = now;
      go(event.deltaX > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [go]);

  // ── the drag ─────────────────────────────────────────────────────────────
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // a drag that starts on a link or a button is that control's, not the deck's
    if ((event.target as HTMLElement).closest("a,button,input,select,textarea,[popover]")) return;
    pointer.current = { id: event.pointerId, x: event.clientX, at: event.timeStamp, lastX: event.clientX, lastAt: event.timeStamp };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    p.lastX = event.clientX;
    p.lastAt = event.timeStamp;
    setDrag(event.clientX - p.x);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    const dx = event.clientX - p.x;
    const elapsed = Math.max(1, event.timeStamp - p.lastAt);
    const velocity = (event.clientX - p.lastX) / elapsed;
    const width = deckRef.current?.getBoundingClientRect().width ?? 0;
    const outcome = dragOutcome(dx, width, velocity);
    pointer.current = null;
    setDragging(false);
    setDrag(0);
    if (outcome === "next") go(1);
    else if (outcome === "previous") go(-1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") go(1);
    else if (event.key === "ArrowLeft") go(-1);
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(count - 1);
    else return;
    event.preventDefault();
  };

  if (count === 0) return null;

  const width = deckRef.current?.getBoundingClientRect().width ?? 0;
  const tilt = dragging ? dragTilt(drag, width) : 0;
  const motion = reduced ? "none" : "transform var(--duration-normal) var(--ease-out-expo), opacity var(--duration-normal) ease";

  return (
    <div className="space-y-3">
      <div
        ref={deckRef}
        role="group"
        aria-roledescription="card deck"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative touch-pan-y select-none rounded-(--radius-card) outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        style={{
          height: height === null ? undefined : height + VISIBLE_DEPTH * LAYER_OFFSET_PX,
          // no height transition while a finger is down: the card under it must
          // not resize mid-gesture
          transition: reduced || dragging ? "none" : "height var(--duration-normal) var(--ease-out-expo)",
          cursor: dragging ? "grabbing" : "grab",
        }}
      >
        {cards.map((card, i) => {
          const slot = deckSlot(i, index, count);
          const isFront = slot.depth === 0;
          const x = isFront && dragging ? drag : 0;
          /*
           * ⛔ A card behind the front is stretched to the FRONT card's height
           * and clipped. Without this the stack has no depth on most steps:
           * these cards are wildly different heights — the runway card is three
           * rows and the trust card is twelve — so a short one sitting behind a
           * tall one ends 200px above its bottom edge and never peeks at all.
           * What shows is the bottom strip of a card-coloured sheet, which is
           * exactly what the edge of a stack looks like.
           */
          const stretched = !isFront && height !== null ? height : undefined;
          return (
            <div
              key={card.id}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              aria-current={isFront ? "true" : undefined}
              className={`absolute inset-x-0 top-0 *:min-w-0 ${isFront ? "" : "overflow-hidden *:h-full"}`}
              style={{
                height: stretched,
                zIndex: slot.zIndex,
                opacity: slot.opacity,
                transform: `translate3d(${x}px, ${slot.translateY}px, 0) scale(${slot.scale}) rotate(${isFront ? tilt : 0}deg)`,
                transformOrigin: "center top",
                // only the front card takes the pointer; the stack behind it is
                // scenery, and a link peeking out from under it must not be
                // clickable through the card on top
                pointerEvents: isFront ? "auto" : "none",
                transition: dragging && isFront ? "none" : motion,
                willChange: dragging ? "transform" : undefined,
              }}
            >
              {card.node}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous card"
          className="rounded-full p-1 text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink"
        >
          <Icon name="more" className="size-3.5 rotate-180" aria-hidden />
        </button>
        {cards.map((card, i) => (
          <button
            key={card.id}
            type="button"
            onClick={() => setActive(i)}
            aria-label={card.label}
            aria-current={i === index ? "true" : undefined}
            className={`h-1.5 rounded-full transition-all duration-(--duration-normal) ${
              i === index ? "w-6 bg-ink" : "w-1.5 bg-line hover:bg-ink-faint"
            }`}
          />
        ))}
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="Next card"
          className="rounded-full p-1 text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink"
        >
          <Icon name="more" className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* the position, for a reader who cannot see the stack shift */}
      <p aria-live="polite" className="sr-only">
        {cards[index]?.label} — card {index + 1} of {count}
      </p>
    </div>
  );
}
