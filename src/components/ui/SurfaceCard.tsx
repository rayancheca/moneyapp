import { BLANK_LEAF, LEAF, PLATE } from "./letterpress";

/**
 * `plate` is the primary card; `leaf` is a nested panel inside one; `blank` is
 * a leaf with no depth at all, for surfaces that hold no figures.
 */
export type SurfaceTone = "plate" | "leaf" | "blank";

const TONE: Record<SurfaceTone, string> = {
  plate: PLATE,
  leaf: LEAF,
  blank: BLANK_LEAF,
};

interface SurfaceCardProps {
  children: React.ReactNode;
  className?: string;
  /** inline style pass-through (the S8 focus morph sets view-transition-name) */
  style?: React.CSSProperties;
  /**
   * Which sheet of paper this is. Defaults to the plate; pass "leaf" for a
   * panel that sits INSIDE another surface (companion rails, wells) so the two
   * read as stacked paper rather than as two competing elevations.
   */
  tone?: SurfaceTone;
}

export function SurfaceCard({ children, className, style, tone = "plate" }: SurfaceCardProps) {
  return (
    <section style={style} className={`${TONE[tone]} p-6 ${className ?? ""}`.trim()}>
      {children}
    </section>
  );
}
