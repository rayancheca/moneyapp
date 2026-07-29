import { computeDeviationLayout, deviationDescription, type DeviationInput } from "@/lib/deviation-layout";
import { formatCents } from "@/lib/money";

/**
 * The centre-rule deviation bar (Direction C) — WHAT MOVED.
 *
 * Every other view of spending on this page answers "how much": the totals, the
 * donut, the massif, the table. None of them puts month-over-month CHANGE on
 * its own axis, so a category that quietly doubled reads the same as one that
 * held steady. This is the only place that question is asked directly.
 *
 * It lives on /spending rather than the dashboard deliberately. On the
 * dashboard it would sit beside A's category list, which already prints the
 * move against last month next to every amount — a third redundant encoding of
 * the same fact. Here it is the only thing making that comparison visual.
 *
 * Server-rendered: no "use client", so the numbers are HTML before any JS.
 */

const ROW_HEIGHT = 22;
const WIDTH = 620;

export interface CategoryDeviationProps {
  rows: readonly DeviationInput[];
  /** e.g. "July" vs "June" — named, never "previous period" */
  currentLabel: string;
  previousLabel: string;
  limit?: number;
}

export function CategoryDeviation({
  rows,
  currentLabel,
  previousLabel,
  limit,
}: CategoryDeviationProps) {
  const layout = computeDeviationLayout(rows, { width: WIDTH, limit, rowHeight: ROW_HEIGHT });

  if (layout.bars.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No category changed between {previousLabel} and {currentLabel}.
      </p>
    );
  }

  const description = deviationDescription(layout, formatCents);
  const up = layout.bars.filter((b) => b.isIncrease).length;

  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-ink-muted">
          {currentLabel} against {previousLabel} — biggest moves first
        </span>
        <span className="text-xs text-ink-muted">
          {up} up · {layout.bars.length - up} down
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${layout.height}`}
        width={WIDTH}
        height={layout.height}
        className="block h-auto w-full max-w-full"
        role="img"
        aria-label={description}
      >
        {/* the rule IS zero, and zero is the centre of a change chart */}
        <line
          x1={layout.centreX}
          y1={0}
          x2={layout.centreX}
          y2={layout.height}
          stroke="var(--ink-display)"
          strokeWidth={1.5}
        />

        {layout.bars.map((b) => {
          const pct =
            b.deltaRatio === null
              ? "new"
              : `${b.deltaRatio > 0 ? "+" : ""}${Math.round(b.deltaRatio * 100)}%`;
          return (
            <g key={b.key}>
              <text
                x={layout.labelWidth - 10}
                y={b.y + ROW_HEIGHT / 2 + 4}
                textAnchor="end"
                className="fill-ink text-[11px]"
              >
                {b.label}
              </text>
              <rect
                x={b.x}
                y={b.y + 3}
                width={b.width}
                height={ROW_HEIGHT - 6}
                rx={2}
                // spending MORE is the direction that costs you, so it takes the
                // negative colour — semantic, not decorative
                fill={b.isIncrease ? "var(--negative)" : "var(--positive)"}
                opacity={0.85}
              />
              <text
                x={WIDTH - 8}
                y={b.y + ROW_HEIGHT / 2 + 4}
                textAnchor="end"
                className="fill-ink-muted figures text-[11px]"
              >
                {b.deltaCents > 0 ? "+" : "−"}
                {formatCents(Math.abs(b.deltaCents))} · {pct}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
