"use client";

import Link from "next/link";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatCents } from "@/lib/money";
import { CATEGORY_HUE_NAMES, categoryHueVar } from "@/lib/category-palette";
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

/** Allocation donut with a legend of holding links (ux-overhaul-plan §6.3). */
export function AllocationDonut({
  slices,
  totalCents,
}: {
  slices: AllocationSlice[];
  totalCents: number;
}) {
  if (slices.length === 0) {
    return <p className="text-sm text-ink-muted">Allocation appears once holdings have cached prices.</p>;
  }
  const data = slices.map((s, i) => ({
    ...s,
    value: s.valueCents / 100,
    color: categoryHueVar(SLICE_HUES[i % SLICE_HUES.length]!),
  }));

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
            <Pie data={data} dataKey="value" nameKey="symbol" innerRadius="64%" outerRadius="88%" paddingAngle={2} strokeWidth={0} isAnimationActive={false}>
              {data.map((s) => (
                <Cell key={s.symbol} fill={s.color} />
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
          <li key={`${s.assetType}-${s.symbol}`}>
            <Link
              href={`/investments/${s.assetType}/${s.symbol}`}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
            >
              <span aria-hidden className="inline-block size-2.5 rounded-[3px]" style={{ backgroundColor: s.color }} />
              <span className="font-medium">{s.symbol}</span>
              <span className="figures ml-auto text-ink-muted">{s.allocationPct.toFixed(1)}%</span>
            </Link>
          </li>
        ))}
      </ul>
    </figure>
  );
}
