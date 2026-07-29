import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { CONTROL_MOTION, LIFT_ON_HOVER, PRESS, RULE_STRONG } from "./letterpress";

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  /** with an href the whole card becomes a drill-down link */
  href?: string;
  ariaLabel?: string;
  /** extra classes on the outer element (e.g. a grid-span for mobile layout) */
  className?: string;
  /**
   * The one figure a set of stats is actually about, marked the way a ledger
   * marks a total: a 2px --ink-display rule across the top edge. Opt-in and
   * deliberately sparing — a page where every stat is keyed has no key stat.
   * The emphasis is structural (a rule plus the display numeral), never colour
   * alone, so it survives greyscale and high-contrast modes.
   */
  emphasis?: "key";
}

/**
 * A stat tile rests at PRESS.rule, not PRESS.card: a dashboard shows five of
 * these at once, and five floating cards is a pile rather than a hierarchy.
 * The plate behind them owns the raised step; a tile only lifts far enough to
 * read as its own piece of paper.
 */
const CARD = `rounded-(--radius-card) border border-line bg-surface-raised p-4 ${PRESS.rule}`;

function StatBody({ label, value, delta }: Pick<StatCardProps, "label" | "value" | "delta">) {
  return (
    <>
      <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
      {/* set in display ink and tightened — a printed numeral, not a UI label
          that happens to contain digits */}
      <span className="figures mt-1 block text-xl font-semibold tracking-[-0.02em] text-ink-display">
        {value}
      </span>
      {delta !== undefined && <span className="mt-1 block text-xs text-ink-muted">{delta}</span>}
    </>
  );
}

export function StatCard({
  label,
  value,
  delta,
  href,
  ariaLabel,
  className,
  emphasis,
}: StatCardProps) {
  const keyed = emphasis === "key" ? RULE_STRONG : "";

  if (!href) {
    return (
      <section aria-label={ariaLabel} className={`${CARD} ${keyed} ${className ?? ""}`.trim()}>
        <StatBody label={label} value={value} delta={delta} />
      </section>
    );
  }
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      // picking a tile up is a one-rank promotion (rule → card) plus the leaf
      // tone; pressing it puts it back down a pixel INTO the page
      className={`group relative block ${CARD} ${keyed} ${CONTROL_MOTION} hover:border-line-strong hover:bg-surface-leaf ${LIFT_ON_HOVER} ${className ?? ""}`.trim()}
    >
      <span
        aria-hidden
        className="absolute right-3 top-3 opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Icon name="arrow-up-right" className="size-3 text-ink-faint" />
      </span>
      <StatBody label={label} value={value} delta={delta} />
    </Link>
  );
}
