"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatCents } from "@/lib/money";

export interface AllocationSlice {
  symbol: string;
  valueCents: number;
  allocationPct: number;
}

const CHART_VARS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

/** Allocation donut in the Ledger chart palette, legend included. */
export function AllocationDonut({
  slices,
  totalCents,
}: {
  slices: AllocationSlice[];
  totalCents: number;
}) {
  if (slices.length === 0) return null;
  const data = slices.map((s) => ({ ...s, value: s.valueCents / 100 }));

  return (
    <figure>
      <figcaption className="sr-only">Portfolio allocation by holding</figcaption>
      <div className="relative h-48">
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
            >
              {data.map((s, i) => (
                <Cell key={s.symbol} fill={CHART_VARS[i % CHART_VARS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">Total</span>
          <span className="figures text-sm font-medium">{formatCents(totalCents)}</span>
        </div>
      </div>
      <ul className="mt-4 space-y-1.5" aria-label="Allocation legend">
        {data.map((s, i) => (
          <li key={s.symbol} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-[3px]"
              style={{ backgroundColor: CHART_VARS[i % CHART_VARS.length] }}
            />
            <span className="font-medium">{s.symbol}</span>
            <span className="figures ml-auto text-ink-muted">{s.allocationPct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
