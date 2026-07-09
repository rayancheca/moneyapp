"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents } from "@/lib/money";

export interface ChartSeries {
  /** object key inside each row — the top-level category name */
  key: string;
  label: string;
  /** CSS color, e.g. var(--chart-1) */
  color: string;
}

/** month: 'YYYY-MM'; every series key maps to integer cents */
export type ChartRow = { month: string } & Record<string, number | string>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthShort(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1]} ${y!.slice(2)}`;
}

function formatTick(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) return `$${Math.round(dollars / 100) / 10}k`;
  return `$${Math.round(dollars)}`;
}

interface StackedMonthChartProps {
  rows: ChartRow[];
  series: ChartSeries[];
  ariaLabel: string;
}

/** Stacked monthly bars — values are integer cents, colors are theme tokens. */
export function StackedMonthChart({ rows, series, ariaLabel }: StackedMonthChartProps) {
  if (rows.length === 0) return null;
  return (
    <figure aria-label={ariaLabel} className="m-0">
      <div className="h-64 md:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonthShort}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--line)" }}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={formatTick}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              cursor={{ fill: "var(--surface-sunken)", opacity: 0.6 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const entries = payload.filter((p) => typeof p.value === "number" && p.value !== 0);
                const total = entries.reduce((sum, p) => sum + (p.value as number), 0);
                return (
                  <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
                    <div className="text-ink-faint">{formatMonthShort(String(label))}</div>
                    <div className="mt-1 space-y-0.5">
                      {[...entries].reverse().map((p) => (
                        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
                          <span className="flex items-center gap-1.5">
                            <span
                              aria-hidden
                              className="inline-block size-2 rounded-[2px]"
                              style={{ backgroundColor: p.color }}
                            />
                            {p.name}
                          </span>
                          <span className="figures">{formatCents(p.value as number)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 font-medium">
                      <span>Total</span>
                      <span className="figures">{formatCents(total)}</span>
                    </div>
                  </div>
                );
              }}
            />
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="month"
                fill={s.color}
                isAnimationActive={false}
                maxBarSize={44}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2 rounded-[2px]"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
