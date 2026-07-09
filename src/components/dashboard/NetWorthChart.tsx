"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents } from "@/lib/money";

export interface ChartPoint {
  day: string;
  totalCents: number;
  complete: boolean;
  coveredAccounts: number;
  totalAccounts: number;
}

const RANGES = [
  { key: "3M", days: 92 },
  { key: "1Y", days: 366 },
  { key: "2Y", days: 731 },
  { key: "All", days: Infinity },
] as const;

function formatDayShort(day: string): string {
  const [y, m] = day.split("-");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    Number(m) - 1
  ];
  return `${month} ${y!.slice(2)}`;
}

export function NetWorthChart({ points }: { points: ChartPoint[] }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("2Y");

  const data = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)?.days ?? Infinity;
    const sliced = Number.isFinite(days) ? points.slice(-days) : points;
    return sliced.map((p) => ({
      ...p,
      value: p.complete ? p.totalCents / 100 : null,
      partialValue: p.complete ? null : p.totalCents / 100,
    }));
  }, [points, range]);

  if (points.length < 2) return null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-end gap-1" role="group" aria-label="Chart range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            aria-pressed={range === r.key}
            className={`rounded-full px-2.5 py-1 text-xs transition-colors duration-(--duration-fast) ${
              range === r.key
                ? "bg-accent-soft font-medium text-accent"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {r.key}
          </button>
        ))}
      </div>
      <div className="h-64 md:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={formatDayShort}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--line)" }}
              minTickGap={48}
            />
            <YAxis
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip
              cursor={{ stroke: "var(--line-strong)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!p) return null;
                return (
                  <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
                    <div className="text-ink-faint">{p.day}</div>
                    <div className="figures mt-0.5 text-sm font-medium">
                      {formatCents(p.totalCents)}
                    </div>
                    {!p.complete && (
                      <div className="mt-0.5 text-warning">
                        partial · {p.coveredAccounts}/{p.totalAccounts} accounts
                      </div>
                    )}
                  </div>
                );
              }}
            />
            <Area
              type="stepAfter"
              dataKey="value"
              stroke="var(--chart-1)"
              strokeWidth={1.75}
              fill="url(#nw-fill)"
              isAnimationActive={false}
              connectNulls={false}
              dot={false}
            />
            <Area
              type="stepAfter"
              dataKey="partialValue"
              stroke="var(--chart-1)"
              strokeWidth={1.25}
              strokeDasharray="4 4"
              strokeOpacity={0.55}
              fill="none"
              isAnimationActive={false}
              connectNulls={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
