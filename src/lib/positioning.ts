/**
 * Pure flip+clamp positioning math for popovers, menus, and tooltips.
 * No DOM access — callers measure rects and pass them in. Per the plan
 * (docs/ux-overhaul-plan.md §2.5) this small util is the primary
 * positioning mechanism; CSS anchor positioning is progressive sugar.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "top" | "bottom" | "left" | "right";
export type Alignment = "start" | "center" | "end";
export type Placement = Side | `${Side}-${Alignment}`;

export interface PositionOptions {
  placement: Placement;
  /** Gap between the anchor and the floating element, px. Default 6. */
  offset?: number;
  /** Minimum distance kept from the viewport edges, px. Default 8. */
  padding?: number;
}

export interface PositionResult {
  x: number;
  y: number;
  /** The placement actually used — the opposite side when flipped. */
  placement: Placement;
}

const DEFAULT_OFFSET = 6;
const DEFAULT_PADDING = 8;

const OPPOSITE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

interface ParsedPlacement {
  side: Side;
  alignment: Alignment;
  hasExplicitAlignment: boolean;
}

function parsePlacement(placement: Placement): ParsedPlacement {
  const dashIndex = placement.indexOf("-");
  if (dashIndex === -1) {
    return { side: placement as Side, alignment: "center", hasExplicitAlignment: false };
  }
  return {
    side: placement.slice(0, dashIndex) as Side,
    alignment: placement.slice(dashIndex + 1) as Alignment,
    hasExplicitAlignment: true,
  };
}

function sideFits(
  side: Side,
  anchor: Rect,
  floating: Size,
  viewport: Size,
  offset: number,
  padding: number,
): boolean {
  switch (side) {
    case "top":
      return anchor.y - offset - floating.height >= padding;
    case "bottom":
      return anchor.y + anchor.height + offset + floating.height <= viewport.height - padding;
    case "left":
      return anchor.x - offset - floating.width >= padding;
    case "right":
      return anchor.x + anchor.width + offset + floating.width <= viewport.width - padding;
  }
}

function alignedStart(
  alignment: Alignment,
  anchorStart: number,
  anchorSize: number,
  floatingSize: number,
): number {
  switch (alignment) {
    case "start":
      return anchorStart;
    case "center":
      return anchorStart + anchorSize / 2 - floatingSize / 2;
    case "end":
      return anchorStart + anchorSize - floatingSize;
  }
}

/** Clamp into [padding, limit − size − padding]; the near edge wins when the element cannot fit at all. */
function clampAxis(value: number, size: number, limit: number, padding: number): number {
  return Math.max(padding, Math.min(value, limit - size - padding));
}

export function computePosition(
  anchor: Rect,
  floating: Size,
  viewport: Size,
  options: PositionOptions,
): PositionResult {
  const offset = options.offset ?? DEFAULT_OFFSET;
  const padding = options.padding ?? DEFAULT_PADDING;
  const { side: preferredSide, alignment, hasExplicitAlignment } = parsePlacement(options.placement);

  const shouldFlip =
    !sideFits(preferredSide, anchor, floating, viewport, offset, padding) &&
    sideFits(OPPOSITE[preferredSide], anchor, floating, viewport, offset, padding);
  const side = shouldFlip ? OPPOSITE[preferredSide] : preferredSide;

  const isVertical = side === "top" || side === "bottom";
  const rawX = isVertical
    ? alignedStart(alignment, anchor.x, anchor.width, floating.width)
    : side === "left"
      ? anchor.x - offset - floating.width
      : anchor.x + anchor.width + offset;
  const rawY = isVertical
    ? side === "top"
      ? anchor.y - offset - floating.height
      : anchor.y + anchor.height + offset
    : alignedStart(alignment, anchor.y, anchor.height, floating.height);

  return {
    x: clampAxis(rawX, floating.width, viewport.width, padding),
    y: clampAxis(rawY, floating.height, viewport.height, padding),
    placement: hasExplicitAlignment ? (`${side}-${alignment}` as Placement) : side,
  };
}
