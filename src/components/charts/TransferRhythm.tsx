"use client";

import { useMemo } from "react";

import { formatCents } from "@/lib/money";
import type { TransferFlowData } from "@/services/transfer-flow";

/**
 * "The Rhythm" — a stacked monthly rail beneath the spine.
 *
 * Topology and time are both present without either being crammed into the
 * other's geometry: the spine answers "where does money settle", this answers
 * "when did it move". They share hover state, so lighting an arc above lights
 * its contribution in every month below.
 *
 * Deliberately plain SVG rects with no transitions on layout properties — the
 * bars are opacity-only under hover, which keeps the visual baselines stable.
 */

const RAIL_HEIGHT = 96;
const BAR_GAP = 2;
const MIN_BAR = 1;

export interface TransferRhythmProps {
  data: TransferFlowData;
  measure: "gross" | "net";
  hoveredEdgeId: string | null;
  onHoverEdge: (id: string | null) => void;
}

export function TransferRhythm({ data, measure, hoveredEdgeId, onHoverEdge }: TransferRhythmProps) {
  const edges = measure === "net" ? data.netEdges : data.edges;
  const colorOf = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a.color])),
    [data.accounts],
  );

  const monthTotals = useMemo(
    () =>
      data.months.map((_, i) => edges.reduce((s, e) => s + (e.monthCents[i] ?? 0), 0)),
    [data.months, edges],
  );
  const peak = Math.max(1, ...monthTotals);

  if (data.months.length === 0 || edges.length === 0) return null;

  const barWidth = 100 / data.months.length;

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 100 ${RAIL_HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-24 w-full"
        role="img"
        aria-label={`Transfers by month, ${data.months[0]} to ${data.months[data.months.length - 1]}. Busiest month ${formatCents(peak)}. The same figures are in the table lens.`}
      >
        {data.months.map((month, i) => {
          const total = monthTotals[i] ?? 0;
          // The STACK is scaled with sqrt, then split proportionally among its
          // edges. Scaling each segment individually would be wrong: Σ√xᵢ > √Σxᵢ,
          // so the stack would overflow the rail.
          //
          // sqrt rather than linear because this data is extremely spiky — one
          // month peaks near $98k while a typical month is a couple of thousand
          // — and a linear rail drew every month except the peak as a 1px
          // sliver, which said nothing at all.
          const stack = total > 0 ? Math.sqrt(total / peak) * (RAIL_HEIGHT - 4) : 0;
          let y = RAIL_HEIGHT;
          return (
            <g key={month}>
              {edges.map((e) => {
                const cents = e.monthCents[i] ?? 0;
                if (cents <= 0) return null;
                const h = Math.max(MIN_BAR, (cents / total) * stack);
                y -= h;
                const lit = hoveredEdgeId === null || hoveredEdgeId === e.id;
                return (
                  <rect
                    key={e.id}
                    x={i * barWidth + BAR_GAP / 2}
                    y={y}
                    width={barWidth - BAR_GAP}
                    height={h}
                    fill={colorOf.get(e.fromAccountId) ?? "var(--ink-muted)"}
                    opacity={lit ? 0.85 : 0.12}
                    onPointerEnter={() => onHoverEdge(e.id)}
                    onPointerLeave={() => onHoverEdge(null)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex justify-between text-[10px] text-ink-muted">
        <span>{data.months[0]}</span>
        <span>
          peak {formatCents(peak)} · {data.months.length} months
        </span>
        <span>{data.months[data.months.length - 1]}</span>
      </figcaption>
    </figure>
  );
}
