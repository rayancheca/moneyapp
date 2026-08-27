/**
 * The geometry and the arithmetic behind a stack of cards you swipe through.
 *
 * Owner, 2026-08-27: *"instead of having the cards take up al the space in teh
 * world and having to scroll down to see them just stack them on thop of each
 * other. either make a scrollwheel or a swipe like in tinder. cool animations.
 * think about ui ux. that way you can add as many as you want without flooding
 * the page"*
 *
 * ## ⛔ It is a CAROUSEL, not a discard pile
 *
 * A Tinder swipe means *decide and destroy* — the card is gone and the gesture
 * carries a verdict. These cards are not decisions; they are twelve readings of
 * the same ledger, and losing one by flicking it would be a bug wearing an
 * animation. So the gesture is borrowed and the semantics are not: a swipe
 * ADVANCES, the deck wraps, and nothing can ever be discarded.
 *
 * That also decides the direction question. In a discard pile left and right
 * mean different things (no and yes). Here they are simply back and forward,
 * which is what a reader already expects from arrow keys and from a wheel.
 *
 * ## Why the maths is in `lib`
 *
 * Every number a card is drawn with — its offset, its scale, how faded it is,
 * whether it is parked off-stage — is a pure function of its distance from the
 * front. Written inline in the component none of it could be tested; here it is
 * inside the 100% gate, and a component test could not have caught an
 * off-by-one in a wrap anyway.
 */

/** How many cards peek out behind the front one. Beyond this they are parked. */
export const VISIBLE_DEPTH = 2;

/**
 * Vertical offset per layer, px.
 *
 * ⛔ It must EXCEED what scaling takes off the bottom, or the stack has no
 * visible depth at all — which is what the first build shipped. A card scaled
 * to `1 - d·step` about its top edge loses `d · step · height` from its bottom,
 * so with a 600px card and a 3.5% step, layer 1 sank 21px and was offset 16px:
 * five pixels ABOVE the front card's edge, perfectly hidden.
 *
 * A gentler scale and a larger offset make the peek positive at every height a
 * card can be — 26 − 0.02·H, which is +14px at 600px and +20px at 300px. Tuned
 * by LOOKING: at +8px the strip was one hairline on a near-white page and read
 * as a rendering artefact rather than as a stack.
 */
export const LAYER_OFFSET_PX = 26;

/** Scale lost per layer. Small: a stack, not a funnel — and see the note above. */
export const LAYER_SCALE_STEP = 0.02;

/** Opacity lost per layer, so the back of the stack recedes rather than stacks flat. */
export const LAYER_FADE_STEP = 0.2;

/**
 * How far a drag must travel before releasing advances rather than snapping
 * back, as a fraction of the deck's width.
 *
 * A quarter is deliberate. Much less and a scroll that wanders sideways flips
 * the card; much more and the gesture feels like it is resisting. Paired with
 * `FLING_VELOCITY` so a fast short flick still counts — which is the half of
 * the feel that a distance threshold alone always gets wrong.
 */
export const COMMIT_FRACTION = 0.25;

/** px per ms past which a release counts as a fling regardless of distance. */
export const FLING_VELOCITY = 0.45;

export interface DeckSlot {
  /** 0 for the front card, growing backwards; wraps, so it is never negative */
  depth: number;
  translateY: number;
  scale: number;
  opacity: number;
  zIndex: number;
  /** deeper than the visible stack — kept mounted, moved off-stage */
  parked: boolean;
}

/**
 * Distance from `active` to `index`, going FORWARD around the ring.
 *
 * Forward-only on purpose: the card you are about to see next should be the one
 * directly behind the front, and a signed distance would put half the deck at
 * negative depth and draw it in front.
 */
export function deckDepth(index: number, active: number, count: number): number {
  if (count <= 0) return 0;
  return (((index - active) % count) + count) % count;
}

export function deckSlot(index: number, active: number, count: number): DeckSlot {
  const depth = deckDepth(index, active, count);
  const parked = depth > VISIBLE_DEPTH;
  /*
   * A parked card is pushed further down and fully transparent rather than
   * `display: none`. Two reasons, and the second is the load-bearing one:
   * unmounting would throw away every card's DOM on each step, and a hidden
   * card is invisible to the accessibility tree AND to anything that reads the
   * page's text. The stack is a presentation, not a filter.
   */
  const layer = Math.min(depth, VISIBLE_DEPTH + 1);
  return {
    depth,
    translateY: layer * LAYER_OFFSET_PX,
    scale: Math.max(0, 1 - layer * LAYER_SCALE_STEP),
    opacity: parked ? 0 : Math.max(0, 1 - depth * LAYER_FADE_STEP),
    // the front card must paint above every other, and depth grows backwards
    zIndex: count - depth,
    parked,
  };
}

/** Step the active index, wrapping in both directions. */
export function stepIndex(active: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  return (((active + direction) % count) + count) % count;
}

/** Clamp an arbitrary index into the deck — a stale URL or a shrunk deck. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

export type DragOutcome = "next" | "previous" | "stay";

/**
 * What releasing a drag should do.
 *
 * ⚠️ `dx` is the SIGNED distance the pointer travelled, and a drag to the LEFT
 * (negative) advances — the same direction a page of text moves when you go
 * forward. Getting this backwards is the single most common way a carousel
 * feels wrong, and it is invisible in a screenshot.
 */
export function dragOutcome(dx: number, deckWidth: number, velocity: number): DragOutcome {
  if (deckWidth <= 0) return "stay";
  const flung = Math.abs(velocity) >= FLING_VELOCITY;
  const travelled = Math.abs(dx) >= deckWidth * COMMIT_FRACTION;
  if (!flung && !travelled) return "stay";
  // a fling's DIRECTION comes from the velocity, which can disagree with the
  // net distance when a drag reverses at the end — the last motion is the
  // intent, and honouring the distance instead makes a flick-back advance
  const forward = flung ? velocity < 0 : dx < 0;
  return forward ? "next" : "previous";
}

/**
 * The tilt a dragged card takes, in degrees.
 *
 * This is the whole "like Tinder" feel and it is one line: the card pivots as
 * it is pushed, as though held at its bottom edge. Capped so a long drag does
 * not spin it, and proportional to travel rather than to velocity so it tracks
 * the finger exactly.
 */
export const MAX_TILT_DEGREES = 8;

export function dragTilt(dx: number, deckWidth: number): number {
  if (deckWidth <= 0) return 0;
  const fraction = Math.max(-1, Math.min(1, dx / deckWidth));
  return fraction * MAX_TILT_DEGREES;
}
