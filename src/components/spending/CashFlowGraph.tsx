"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { CashFlow, SpendingProjection } from "@/services/spending";

/**
 * The cash-flow GRAPH view (user ask): the period's running totals as clean
 * cumulative lines — earned, spent, and net — where the bar chart shows each
 * bucket's composition. The gap between earned and spent IS the net line, and
 * the prior period's cumulative spend rides along as the dashed ghost, so
 * "are we ahead of last period" is readable at a glance. Same integer-cents
 * data as the chart and table views — the three always reconcile.
 */

function formatTick(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? "-" : "";
  if (dollars >= 1000) return `${sign}$${Math.round(dollars / 100) / 10}k`;
  return `${sign}$${Math.round(dollars)}`;
}

interface GraphRow {
  key: string;
  label: string;
  earnedCum: number;
  spentCum: number;
  netCum: number;
  ghostCum: number | null;
}

interface CashFlowGraphProps {
  data: CashFlow;
  projection?: SpendingProjection | null;
}

export function CashFlowGraph({ data, projection }: CashFlowGraphProps) {
  const { buckets } = data;
  const ghost = projection?.prior?.ghost ?? null;
  const hasGhost = ghost !== null && ghost.length === buckets.length;
  const priorLabel = projection?.prior?.label ?? null;

  let earnedCum = 0;
  let spentCum = 0;
  let ghostCum = 0;
  const rows: GraphRow[] = buckets.map((b, i) => {
    earnedCum += b.incomeCents;
    spentCum += b.spendingCents;
    if (hasGhost) ghostCum += ghost![i] ?? 0;
    return {
      key: b.key,
      label: b.label,
      earnedCum,
      spentCum,
      netCum: earnedCum - spentCum,
      ghostCum: hasGhost ? ghostCum : null,
    };
  });

  if (buckets.length === 0) return null;
  const labelByKey = new Map(rows.map((r) => [r.key, r.label]));

  return (
    <figure className="m-0" aria-label="Running totals for the period — cumulative earned, spent, and net">
      <div className="h-72 md:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="key"
              tickFormatter={(k: string) => labelByKey.get(k) ?? k}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--line)" }}
              interval="preserveStartEnd"
              minTickGap={12}
            />
            <YAxis
              tickFormatter={formatTick}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            <Tooltip
              cursor={{ stroke: "var(--line-strong)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = rows.find((r) => r.key === String(label));
                if (!row) return null;
                return (
                  <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
                    <div className="text-ink-faint">Through {row.label}</div>
                    <div className="mt-1 flex items-center justify-between gap-4">
                      <span className="text-positive">Earned</span>
                      <span className="figures">{formatCents(row.earnedCum)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-negative">Spent</span>
                      <span className="figures">{formatCents(row.spentCum)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 font-medium">
                      <span>Net</span>
                      <span className="figures">{formatCentsSigned(row.netCum)}</span>
                    </div>
                    {row.ghostCum !== null && (
                      <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 text-ink-faint">
                        <span>Spent by here, {priorLabel ?? "prior period"}</span>
                        <span className="figures">{formatCents(row.ghostCum)}</span>
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {hasGhost && (
              <Line
                type="monotone"
                dataKey="ghostCum"
                name={`Spent in ${priorLabel ?? "the prior period"} (cumulative)`}
                stroke="var(--ink-faint)"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                strokeDasharray="2 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              type="monotone"
              dataKey="earnedCum"
              name="Earned (cumulative)"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="spentCum"
              name="Spent (cumulative)"
              stroke="var(--negative)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="netCum"
              name="Net (cumulative)"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: "var(--chart-2)" }} />
          Earned, running total
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: "var(--negative)" }} />
          Spent, running total
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3 bg-accent" />
          Net, running total
        </span>
        {hasGhost && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0 w-3 border-t border-dashed border-ink-faint" />
            Spent in {priorLabel}, running total
          </span>
        )}
      </figcaption>
    </figure>
  );
}
