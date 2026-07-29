import { RULE_HAIR, RULE_STRONG } from "./letterpress";

type RuleWeight = "strong" | "hair" | "masthead";

/**
 * The editorial rule — the piece of furniture that makes a page read as a
 * printed sheet rather than a scrolling app.
 *
 *   "strong"    2px of --ink-display. Opens a section, closes a total.
 *   "hair"      1px of --line at 3/4. A quiet separation.
 *   "masthead"  the pair: strong, a 3px gap, then hair. This exact stack is
 *               the mockup's masthead, and it is the single cheapest signal
 *               that a page belongs to this direction.
 *
 * Rendered as styled boxes inside an aria-hidden wrapper rather than as <hr>
 * elements: these are decoration, and two consecutive `separator` roles at the
 * top of every page is noise a screen-reader user has to walk past. Real
 * thematic breaks in content should still use <hr>.
 */
interface RuleProps {
  weight?: RuleWeight;
  className?: string;
}

export function Rule({ weight = "hair", className }: RuleProps) {
  if (weight === "masthead") {
    return (
      <div aria-hidden className={className}>
        <div className={RULE_STRONG} />
        <div className={`mt-[3px] ${RULE_HAIR}`} />
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={`${weight === "strong" ? RULE_STRONG : RULE_HAIR} ${className ?? ""}`.trim()}
    />
  );
}
