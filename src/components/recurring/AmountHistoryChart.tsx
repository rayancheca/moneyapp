"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { AmountHistoryPoint } from "@/services/recurring-detail";
import { shortDate } from "./labels";

interface AmountHistoryChartProps {
  points: readonly AmountHistoryPoint[];
  /** the expected per-occurrence amount — drawn as a dashed reference line */
  expectedCents: number | null;
}

/**
 * Charge-amount history (ux-overhaul-plan §4.2): one bar per posted occurrence
 * so a subscription's price creep or a bill's swings are visible. Bars plot the
 * magnitude (charges and deposits both grow upward); the dashed line marks the
 * expected amount so drift reads at a glance. The signed value lives in the
 * tooltip, where the +/- and flow color carry the direction.
 */
export function AmountHistoryChart({ points, expectedCents }: AmountHistoryChartProps) {
  const data = useMemo(
    () => points.map((p) => ({ date: p.date, magnitude: Math.abs(p.amountCents) / 100, amountCents: p.amountCents })),
    [points],
  );

  // one bar can't show drift; below two, the linked list already tells the story
  if (data.length < 2) return null;

  const expectedMagnitude = expectedCents === null ? null : Math.abs(expectedCents) / 100;

  return (
    <div className="h-44 md:h-52">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--line)" }}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`)}
            tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          {expectedMagnitude !== null ? (
            <ReferenceLine
              y={expectedMagnitude}
              stroke="var(--ink-faint)"
              strokeDasharray="4 4"
              ifOverflow="extendDomain"
            />
          ) : null}
          <Tooltip
            cursor={{ fill: "var(--surface-sunken)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0]?.payload as (typeof data)[number] | undefined;
              if (!p) return null;
              return (
                <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
                  <div className="text-ink-faint">{p.date}</div>
                  <div className="figures mt-0.5 text-sm font-medium">{formatCentsSigned(p.amountCents)}</div>
                  {expectedCents !== null && p.amountCents !== expectedCents ? (
                    <div className="mt-0.5 text-ink-faint">expected {formatCents(expectedCents)}</div>
                  ) : null}
                </div>
              );
            }}
          />
          <Bar dataKey="magnitude" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
