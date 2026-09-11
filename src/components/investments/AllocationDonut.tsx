"use client";

import { sharePercent } from "@/lib/insight-facts";
import Link from "next/link";
import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatCents } from "@/lib/money";
import { CATEGORY_HUE_NAMES, categoryHueVar } from "@/lib/category-palette";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { AllocationSlice } from "@/services/portfolio";

/**
 * Slice colours come from the validated 12-hue categorical palette (the same
 * colour system the category chips use), walked with a stride of 5 — coprime
 * with 12, so all twelve hues are visited while ADJACENT slices always sit far
 * apart on the hue wheel (red → teal → pink → lime → …). This replaces the six
 * near-monochrome --chart-N greens that made holdings indistinguishable.
 */
const SLICE_STRIDE = 5;
const SLICE_HUES = CATEGORY_HUE_NAMES.map(
  (_, i) => CATEGORY_HUE_NAMES[(i * SLICE_STRIDE) % CATEGORY_HUE_NAMES.length]!,
);

/** Opacity of the slices/swatches that are NOT the highlighted holding. */
const DIM = 0.22;
const DIM_SWATCH = 0.3;

/**
 * Allocation donut with a legend of holding links (ux-overhaul-plan §6.3), plus
 * the chart-parity #3 HOVER-HIGHLIGHT: pointing at a slice — or at its legend
 * row — lights that holding and recedes the rest, so a thin wedge can be tied to
 * its name without reading colours off a key.
 *
 * Highlight-only, deliberately: it never filters the page, so the donut stays
 * self-contained and nothing else on /investments has to react.
 *
 * Keyboard: the legend rows are already links (real tab stops), so `focus`
 * drives the same highlight as hover — no second, parallel set of tab stops on
 * the SVG wedges, which would double every holding in the tab order.
 *
 * Contrast: only the WEDGES and the legend SWATCHES dim. Legend text keeps its
 * full contrast in every state, so highlighting can never push a label under AA.
 */
export function AllocationDonut({
  slices,
  totalCents,
}: {
  slices: AllocationSlice[];
  totalCents: number;
}) {
  // the highlighted holding's key, or null when nothing is pointed at
  const [active, setActive] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // opacity-only, and dropped entirely under reduced motion (recharts drives
  // this in JS/SVG attributes, out of reach of the global CSS guard)
  const fade = reducedMotion ? undefined : "opacity var(--duration-fast)";

  if (slices.length === 0) {
    return <p className="text-sm text-ink-muted">Allocation appears once holdings have cached prices.</p>;
  }
  const data = slices.map((s, i) => ({
    ...s,
    key: `${s.assetType}-${s.symbol}`,
    value: s.valueCents / 100,
    color: categoryHueVar(SLICE_HUES[i % SLICE_HUES.length]!),
  }));
  /** dimmed only while ANOTHER holding is highlighted — resting state is untouched */
  const dimmed = (key: string) => active !== null && active !== key;

  return (
    <figure className="m-0">
      <figcaption className="sr-only">Portfolio allocation by holding</figcaption>
      <div className="relative h-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!p) return null;
                return (
                  <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
                    <div className="font-medium">{p.symbol}</div>
                    <div className="figures mt-0.5">{formatCents(p.valueCents)}</div>
                    <div className="text-ink-faint">{p.allocationPct.toFixed(1)}%</div>
                  </div>
                );
              }}
            />
            <Pie
              data={data}
              dataKey="value"
              nameKey="symbol"
              innerRadius="64%"
              outerRadius="88%"
              paddingAngle={2}
              strokeWidth={0}
              isAnimationActive={false}
              // recharts hands back the datum index. VERIFIED with a real pointer
              // (wedge hover dims the others, leaving restores). Touch is NOT
              // verified: it depends on the browser synthesising compatibility
              // mouse events from a tap, so treat tap-to-highlight as a bonus,
              // not a contract — the legend row is the guaranteed path.
              onMouseEnter={(_, index: number) => setActive(data[index]?.key ?? null)}
              onMouseLeave={() => setActive(null)}
            >
              {data.map((s) => (
                <Cell
                  key={s.key}
                  fill={s.color}
                  opacity={dimmed(s.key) ? DIM : 1}
                  style={fade ? { transition: fade } : undefined}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">Total</span>
          <span className="figures text-sm font-medium">{formatCents(totalCents)}</span>
        </div>
      </div>
      <ul className="mt-4 space-y-0.5" aria-label="Allocation legend">
        {data.map((s) => (
          <li key={s.key}>
            <Link
              href={`/investments/${s.assetType}/${s.symbol}`}
              // focus drives the highlight too, so the pairing is reachable
              // without a pointer (these links are the existing tab stops)
              onMouseEnter={() => setActive(s.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(s.key)}
              onBlur={() => setActive(null)}
              className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors duration-(--duration-fast) hover:bg-surface-sunken${
                active === s.key ? " bg-surface-sunken" : ""
              }`}
            >
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-[3px]"
                // the swatch recedes with its wedge; the LABEL never dims, so
                // text contrast is identical in every highlight state
                style={{
                  backgroundColor: s.color,
                  opacity: dimmed(s.key) ? DIM_SWATCH : 1,
                  ...(fade ? { transition: fade } : {}),
                }}
              />
              <span className="font-medium">{s.symbol}</span>
              <span className="figures ml-auto text-ink-muted">{sharePercent(s.allocationPct)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </figure>
  );
}
