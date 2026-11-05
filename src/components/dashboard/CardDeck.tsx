"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/shell/Icon";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  LAYER_OFFSET_PX,
  VISIBLE_DEPTH,
  clampIndex,
  deckHeight,
  deckSlot,
  dragOutcome,
  dragTilt,
  dragUncovers,
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
 * order, so the document's text still holds all twelve — a deck that
 * unmounted eleven of them would be a filter wearing a stack. The deck is one
 * tab stop that announces its position; the pips are real buttons; and under
 * `prefers-reduced-motion` nothing transitions at all.
 *
 * ⛔ The cards BEHIND the front are `inert`, as anything covered must be (see
 * the slot below): out of the pointer, the Tab order and a screen reader's
 * cursor, which reads the card on screen as the eye does — every card's name
 * is on its pip, and the grid reads all twelve at once. So every way in steps
 * through `turn`, which hands a focus on the front card to the deck before
 * that card goes behind. ⚠️ …and out of find-in-page: ⌘F on the deck finds
 * the front card's text only — "Paid up front", on The car behind Runway, was
 * not found on his ledger copy (the review of d27f4f8f). The grid is the
 * full-text view; the 08-27 handoff's rule now says so.
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

  /*
   * ⛔ Every step goes through here — an arrow, Home, End, the wheel, a drag, a pip, Previous, Next — and it hands the
   * focus over BEFORE the card moves, while that card can still hold it. A step sends the front card behind, where it
   * is `inert`, and the browser drops a focus left inside an inert card to the page, where the next arrow steps
   * nothing. So a focus inside the deck moves to the deck, the one tab stop that says where you are, without a scroll:
   * a bare focus() brings the deck's top into view, and a link low on a tall card sits below it. A focus outside the
   * deck stays — a pip, Previous or Next keeps the focus its click put there.
   *
   * 🔴 Only an arrow key handed it over, from the key handler: a trackpad swipe (the wheel) after a click on Runway's
   * "What Runway means" left the focus on <body> and ← → dead — the review of 04c5fd30, in headless Chromium.
   *
   * ⛔ …and it closes a provenance panel (`popover="auto"`) left open on the card going behind — AFTER the hand-off,
   * whoever holds the focus. Hidden first, a panel holding the focus hands it back to whatever held it before it
   * opened, which on WebKit (it never focuses a button on a click) is the page, and the deck would see no focus of its
   * own to take. 🔴 It floated over the next card: On your cards' "How what you owe is known — 3 of 3 add up" open,
   * then →, and Eating out came forward under "$2,624.16 across 3 cards…", in a card now inert (the review of
   * d27f4f8f, his ledger copy 2026-10-29). An ⓘ's tooltip is not the deck's: its open state is `Tooltip`'s, and it
   * closes on the blur the hand-off causes and on a pointer leaving it.
   */
  const turn = useCallback(
    (to: (current: number) => number) => {
      const deck = deckRef.current;
      const focused = deck?.ownerDocument.activeElement;
      if (deck && focused && focused !== deck && deck.contains(focused)) deck.focus({ preventScroll: true });
      deck?.querySelectorAll<HTMLElement>('[popover="auto"]:popover-open').forEach((panel) => panel.hidePopover());
      setActive((current) => to(clampIndex(current, count)));
    },
    [count],
  );

  const go = useCallback(
    (direction: 1 | -1) => turn((current) => stepIndex(current, count, direction)),
    [turn, count],
  );

  /*
   * The container height follows the FRONT card. Measured rather than guessed,
   * because a decision card's height depends on its own content — the runway
   * card is three rows and the trust card is twelve.
   */
  useLayoutEffect(() => {
    const el = cardRefs.current[index];
    if (!el) return;
    /*
     * ⛔ CEIL, not the raw float. `getBoundingClientRect().height` is
     * sub-pixel, and feeding it straight into a style makes the container's
     * laid-out height depend on where the fraction happens to land — the
     * dashboard's 768px dark baseline came out 3,269px in a full run and
     * 3,270px on its own, a 5,638-pixel diff from ONE pixel of height. Ceiling
     * it makes the height deterministic, and rounding up rather than down means
     * a card is never clipped by half a pixel. 🔴 …but not quite deterministic:
     * a card measuring an integer OR one 1/64-px layout unit above it still
     * flipped a pixel (`deckHeight`).
     */
    const measure = () => setHeight(deckHeight(el.getBoundingClientRect().height));
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

  /** the pointer let go of and the front card back on the stack — and with it the sheet of the card behind */
  const dropPointer = () => {
    pointer.current = null;
    setDragging(false);
    setDrag(0);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    const dx = event.clientX - p.x;
    const elapsed = Math.max(1, event.timeStamp - p.lastAt);
    const velocity = (event.clientX - p.lastX) / elapsed;
    const width = deckRef.current?.getBoundingClientRect().width ?? 0;
    const outcome = dragOutcome(dx, width, velocity);
    dropPointer();
    if (outcome === "next") go(1);
    else if (outcome === "previous") go(-1);
  };

  /*
   * ⛔ A pointer the browser takes back (`pointercancel`) abandons the drag: the card snaps back and the deck never
   * steps, as ScrubChart drops its scrub. The browser took it — a vertical pan it claims (`touch-pan-y`, below), a
   * touch the system interrupts — so where it says the pointer was is not where anyone let go. 🔴 It was read as a
   * release there, and Chromium says clientX 0: a thumb pushed straight up from the middle of the deck was a drag of
   * 195 px left at a fling's speed, and the page scrolled 72 px AND Runway went behind The car (the review of
   * 246dcf1e, headless Chromium with CDP touch at 390 and 1024 px, his ledger copy 2026-11-05).
   */
  const abandonDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id === event.pointerId) dropPointer();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    /*
     * ⛔ A step key only reaches `turn`, which hands the focus to the deck; every other key is the browser's and
     * leaves the focus where it is. Taken for every key, a Tab pressed on a link lands on the deck and walks back
     * into the front card's first control, and Tab never leaves the deck — DECK, "What Runway means", DECK, … on
     * his ledger copy, 2026-10-29 (pinned in CardDeck.test.ts).
     */
    if (event.key === "ArrowRight") go(1);
    else if (event.key === "ArrowLeft") go(-1);
    else if (event.key === "Home") turn(() => 0);
    else if (event.key === "End") turn(() => count - 1);
    else return;
    event.preventDefault();
  };

  if (count === 0) return null;

  const width = deckRef.current?.getBoundingClientRect().width ?? 0;
  const tilt = dragging ? dragTilt(drag, width) : 0;
  const motion = reduced ? "none" : "transform var(--duration-normal) var(--ease-out-expo), opacity var(--duration-normal) ease";
  // what is on the card a step brings forward fades in on the step's own duration — and at once, as the step moves,
  // under reduced motion (the slot below)
  const fadeIn = reduced ? "" : "*:*:transition-opacity *:*:duration-(--duration-normal)";
  // a drag is on once it has pushed the front card `UNCOVER_SLOP_PX` off the card behind it — not while a press has
  // merely landed, nor for a thumb's drift on a vertical pan the browser is about to take
  const pushed = dragging && dragUncovers(drag);

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
        onPointerCancel={abandonDrag}
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
           *
           * 🔴 …and whatever the card held at that height: Earned vs banked's "…the arrangement can have
           * quietly ended — nothing here can tell those apart." sat faintly in the edge of the gate's own
           * baselines (dashboard-light-1024 and both 320s). So a card behind shows its SHEET and nothing on it:
           * `*:*:opacity-0` hides its root's CHILDREN and never its root, because every card's root is its sheet
           * (pinned in CardDeck.test.ts — all twelve on his ledger copy, 2026-10-29). Opacity, not `visibility`:
           * the text is still the page's, and decision-cards.spec reads it there.
           *
           * ⚖️ default built, not asked (2026-11-05): …all but the card DIRECTLY behind, while a drag has pushed
           * the front off it. He asked on 2026-08-27 for "a swipe like in tinder" — a swipe that uncovers the next
           * card — and since d27f4f8f a drag on Runway uncovered The car as an empty sheet until it let go (the
           * review of d27f4f8f); it uncovers "$1,306.79 a month, all in" and its rows now (his ledger copy,
           * 2026-11-05). That card only: Earned vs banked, two back, stays its sheet, or its text would show
           * through The car, drawn at 0.8. Only once the drag has pushed the front card 10 px off it
           * (`UNCOVER_SLOP_PX`): a press on the front card, or a thumb's drift on a vertical pan the browser is
           * about to take, must not flash the next card into the edge. 🔴 Any push at all did, and a thumb pushed
           * straight up the deck with a pixel of drift flashed The car into Runway's edge until Chromium took the
           * pointer (the review of 246dcf1e). The sheet comes back the moment the drag ends or the browser takes
           * it, and the card stays `inert` throughout — the reveal is the eye's.
           *
           * …and the card a step brings forward fades what is on it in over the step's own 300 ms
           * (`--duration-normal`, on its opacity alone) rather than popping it in at the start of the move. The
           * transition sits on the FRONT card only, so the card a step sends behind drops its content at once —
           * faded out, it would show through the card coming forward, still part-clear as the move starts — and
           * the card a drag uncovered comes forward already showing, with nothing to fade. Under reduced motion it
           * appears at once, as the step does. None of the thirteen cards the page deals puts a transition of its
           * own on a child of its sheet for this one to replace (read 2026-11-05).
           *
           * ⛔ And it is `inert`: out of the pointer and out of the Tab order. 🔴 Only the pointer was kept out,
           * and a Tab walked every link and button behind the front — 16 and 14 behind Runway on his ledger copy,
           * 2026-10-29, each one a focus ring drawn on a card nobody could see.
           */
          const stretched = !isFront && height !== null ? height : undefined;
          const uncovered = pushed && slot.depth === 1;
          const sheet = uncovered ? "overflow-hidden *:h-full" : "overflow-hidden *:h-full *:*:opacity-0";
          return (
            <div
              key={card.id}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              aria-current={isFront ? "true" : undefined}
              inert={isFront ? undefined : true}
              className={`absolute inset-x-0 top-0 *:min-w-0 ${isFront ? fadeIn : sheet}`}
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
            onClick={() => turn(() => i)}
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
