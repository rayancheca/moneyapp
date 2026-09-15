"use client";

import { type ReactNode } from "react";
import { useViewState } from "@/hooks/useViewState";
import { unreachedDashNote } from "@/lib/empty-period";
import { type ViewState } from "@/lib/view-state";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { SankeyChart } from "@/components/charts/SankeyChart";
import type { SankeyGraph } from "@/lib/sankey-layout";
import { CashFlowChart } from "./CashFlowChart";
import { CashFlowGraph } from "./CashFlowGraph";
import { CASH_VIEW_LABELS, CASH_VIEW_SPEC, SPENDING_SURFACE } from "./spending-view-spec";
import type { CashFlow, CashFlowBucket, SpendingProjection } from "@/services/spending";

/**
 * The cash-flow card with a view switcher (NS#2 Pillar 2): the SAME data as the
 * vivid projection chart or as a raw-number table (the honest "show me the data"
 * escape hatch + an a11y win). The choice lives in the URL (shareable, Back works)
 * and persists per-surface; the projection overlay rides the chart view.
 */
interface CashFlowViewProps {
  cashFlow: CashFlow;
  projection: SpendingProjection | null;
  /** money-flow graph for the same period — the Sankey lens */
  sankey: SankeyGraph;
  /** the RSC-resolved active view (URL > persisted > default) */
  viewState: ViewState;
  /** URL params to preserve across a view switch (the period) */
  baseParams: Record<string, string>;
  periodLabel: string;
  /** what the pace readout's unimported days are "of" (`paceWindowName`) — null for All time */
  paceWindowName: string | null;
}

/** a bucket augmented with the prior period's value for the SAME bucket */
type CashRow = CashFlowBucket & { ghostCents: number | null };

export function CashFlowView({
  cashFlow,
  projection,
  sankey,
  viewState,
  baseParams,
  periodLabel,
  paceWindowName,
}: CashFlowViewProps) {
  const { state, setView } = useViewState({
    surface: SPENDING_SURFACE,
    spec: CASH_VIEW_SPEC,
    state: viewState,
    basePath: "/spending",
    baseParams,
  });
  const dim = CASH_VIEW_SPEC[0]!; // "cash"
  const active = state[dim.key] ?? "chart";

  // ⛔ `prior.aligned`, never `prior.ghost`. The ghost is a nearest-fraction SHAPE
  // resample for the chart's overlay; printed in a cell under a column headed
  // `Spent, <prior month>` beside a day number it names the WRONG DAY — 610 of
  // 1,539 cells across 41 of 53 periods on the real ledger. `aligned` is the
  // prior period's own bucket, and null where it has none (rendered "—").
  const aligned = projection?.prior?.aligned ?? null;
  const hasGhost = aligned !== null && aligned.length === cashFlow.buckets.length;
  const priorLabel = projection?.prior?.label ?? null;

  const rows: CashRow[] = cashFlow.buckets.map((b, i) => ({
    ...b,
    ghostCents: hasGhost ? (aligned![i] ?? null) : null,
  }));
  // a refund is money in, so Net is income + refunds − spent. Showing only three
  // of the four terms states an identity that fails on any period with a credit.
  const hasRefunds = rows.some((r) => r.refundsCents !== 0);

  /*
   * 🔴 S11. Every bucket printed its figures, and a bucket nobody has read has
   * none — only the zeros the service fills it with. Measured on the owner's
   * ledger 2026-09-14: `?period=2026-09&cash=table` rows 13–30 and
   * `?period=2022-08&cash=table` rows 1–24 read "$0.00 $0.00 $0.00", and
   * `?period=2026` did the same of Oct, Nov and Dec.
   *
   * ⛔ The ROW stays and only its own four figures dash (owner decision E1a): the
   * prior-period column is a fact about the prior period, and dropping Sep 15–30
   * would drop its real figures with it.
   */
  const figure = (r: CashRow, node: ReactNode): ReactNode =>
    r.unreached === null ? node : <span className="text-ink-faint">—</span>;
  const dashNote = unreachedDashNote(
    rows.flatMap((r) => (r.unreached === null ? [] : [r.unreached])),
    (rows[0]?.key.length ?? 10) === 7 ? "month" : "day",
  );

  const columns: Column<CashRow>[] = [
    { key: "label", header: "Period", render: (r) => r.label },
    {
      key: "earned",
      // S22: every positive income-kind row — /summary alone says "Earned", and means less
      header: "Income",
      align: "right",
      render: (r) => figure(r, <span className="text-positive">{formatCents(r.incomeCents)}</span>),
    },
    {
      key: "spent",
      header: "Spent",
      align: "right",
      render: (r) => figure(r, <span className="text-negative">{formatCents(r.spendingCents)}</span>),
    },
    ...(hasRefunds
      ? [
          {
            key: "refunded",
            header: "Refunded",
            align: "right" as const,
            render: (r: CashRow) => figure(r, <span className="text-positive">{formatCents(r.refundsCents)}</span>),
          },
        ]
      : []),
    { key: "net", header: "Net", align: "right", render: (r) => figure(r, formatCentsSigned(r.netCents)) },
    ...(hasGhost
      ? [
          {
            key: "prior",
            header: priorLabel ? `Spent, ${priorLabel}` : "Prior period",
            align: "right" as const,
            render: (r: CashRow) => (
              <span className="text-ink-faint">{r.ghostCents === null ? "—" : formatCents(r.ghostCents)}</span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <ViewSwitcher
          dimension={dim}
          value={active}
          onSelect={(v) => setView(dim.key, v)}
          labels={CASH_VIEW_LABELS}
          ariaLabel="Cash flow view"
        />
      </div>
      {active === "table" ? (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.key}
            caption={`Cash flow by period for ${periodLabel} — income, spent${
              hasRefunds ? ", refunded" : ""
            }, and net per bucket${
              hasGhost && priorLabel ? `, with the same bucket of ${priorLabel} for comparison` : ""
            }.${dashNote ? ` ${dashNote}` : ""}`}
            emptyState="No activity in this period."
          />
          {/* ⛔ ONCE PER AUDIENCE. The caption is screen-reader-only and is
              announced as the table is entered, before any dash; this line is
              for the eye, so it is hidden from the reader that already heard it.
              The pace readout on this card was read aloud twice for the same
              shape (9dcda96). */}
          {dashNote && (
            <p aria-hidden="true" className="mt-2 text-xs text-ink-faint">
              {dashNote}
            </p>
          )}
        </>
      ) : active === "sankey" ? (
        <SankeyChart
          graph={sankey}
          ariaLabel={`Money flow for ${periodLabel}`}
          emptyLabel="No money flow to chart in this period."
        />
      ) : active === "graph" ? (
        <CashFlowGraph data={cashFlow} projection={projection} />
      ) : (
        <CashFlowChart data={cashFlow} projection={projection} paceWindowName={paceWindowName} />
      )}
    </div>
  );
}
