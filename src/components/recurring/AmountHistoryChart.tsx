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
import { DataTable, type Column } from "@/components/ui/DataTable";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { PerPayday } from "@/lib/per-payday";
import type { AmountHistoryPoint } from "@/services/recurring-detail";
import { longDate, perPaydayWord, shortDate } from "./labels";

interface AmountRow {
  key: string;
  date: string;
  amountCents: number;
  /** a lump of pay, read per payday as the calendar grades it — see `AmountHistoryPoint` */
  perPayday: PerPayday | null;
  /** what the row is compared with the expectation as: per payday for a lump, else its amount */
  comparableCents: number;
}

/** The table lens's columns: the tooltip's own facts, as a column each. */
function AMOUNT_COLUMNS(expectedCents: number | null): Column<AmountRow>[] {
  return [
    { key: "date", header: "Date", render: (r) => longDate(r.date) },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (r) => (
        <>
          <span className="figures">{formatCentsSigned(r.amountCents)}</span>
          {r.perPayday ? <span className="block text-[11px] text-ink-faint">{perPaydayWord(r.perPayday)}</span> : null}
        </>
      ),
    },
    // only offered when there IS an expectation to compare against — a
    // "vs expected" column full of dashes would imply a missing number
    ...(expectedCents === null
      ? []
      : [
          {
            key: "variance",
            header: "vs expected",
            align: "right" as const,
            render: (r: AmountRow) =>
              r.comparableCents === expectedCents ? (
                <span className="text-ink-faint">on plan</span>
              ) : (
                <span className="figures text-ink-faint">
                  {formatCentsSigned(Math.abs(r.comparableCents) - Math.abs(expectedCents))}
                </span>
              ),
          },
        ]),
  ];
}

interface AmountHistoryChartProps {
  points: readonly AmountHistoryPoint[];
  /** the expected per-occurrence amount — drawn as a dashed reference line */
  expectedCents: number | null;
  /** the chart⇄table lens (chart-parity pass 23): the same occurrences as rows */
  asTable?: boolean;
}

/**
 * Charge-amount history (ux-overhaul-plan §4.2): one bar per posted occurrence
 * so a subscription's price creep or a bill's swings are visible. Bars plot the
 * magnitude (charges and deposits both grow upward); the dashed line marks the
 * expected amount so drift reads at a glance. The signed value lives in the
 * tooltip, where the +/- and flow color carry the direction.
 *
 * The table lens (pass 23) lists the same occurrences newest-first with the
 * signed amount and the variance the bars only imply — the tooltip's numbers,
 * all visible at once.
 *
 * ⚖️ A lump of pay is drawn and compared PER PAYDAY, as the calendar grades it
 * (`lib/per-payday`): his Sep 23 deposit of $4,567.68 is a bar one week tall,
 * labelled "4 paydays at $1,141.92 each", on plan. 🔴 Drawn whole, it was a bar
 * four weeks tall reading "vs expected +$3,425.76" beside a calendar drawing the
 * same row `paid`.
 */
export function AmountHistoryChart({ points, expectedCents, asTable = false }: AmountHistoryChartProps) {
  const data = useMemo(
    () =>
      points.map((p) => {
        const comparableCents = p.perPayday?.cents ?? p.amountCents;
        return {
          date: p.date,
          magnitude: Math.abs(comparableCents) / 100,
          amountCents: p.amountCents,
          perPayday: p.perPayday,
          comparableCents,
        };
      }),
    [points],
  );

  // newest first — the "show me the numbers" reading order (the caption says so)
  const rows = useMemo(() => data.map((d, i) => ({ ...d, key: `${d.date}#${i}` })).reverse(), [data]);
  const columns = useMemo(() => AMOUNT_COLUMNS(expectedCents), [expectedCents]);

  // one bar can't show drift; below two, the linked list already tells the story
  if (data.length < 2) return null;

  const expectedMagnitude = expectedCents === null ? null : Math.abs(expectedCents) / 100;

  if (asTable) {
    return (
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        caption={`Charge amount for each of the ${rows.length} posted occurrences, newest first${
          expectedCents === null ? "" : `, against the expected ${formatCents(expectedCents)}`
        }.`}
        emptyState="No posted occurrences yet."
      />
    );
  }

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
                  {p.perPayday ? <div className="mt-0.5 text-ink-faint">{perPaydayWord(p.perPayday)}</div> : null}
                  {expectedCents !== null && p.comparableCents !== expectedCents ? (
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
