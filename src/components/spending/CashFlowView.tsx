"use client";

import { useViewState } from "@/hooks/useViewState";
import { type ViewState } from "@/lib/view-state";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
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
  /** the RSC-resolved active view (URL > persisted > default) */
  viewState: ViewState;
  /** URL params to preserve across a view switch (the period) */
  baseParams: Record<string, string>;
  periodLabel: string;
}

/** a bucket augmented with its aligned prior-period ghost value */
type CashRow = CashFlowBucket & { ghostCents: number | null };

export function CashFlowView({ cashFlow, projection, viewState, baseParams, periodLabel }: CashFlowViewProps) {
  const { state, setView } = useViewState({
    surface: SPENDING_SURFACE,
    spec: CASH_VIEW_SPEC,
    state: viewState,
    basePath: "/spending",
    baseParams,
  });
  const dim = CASH_VIEW_SPEC[0]!; // "cash"
  const active = state[dim.key] ?? "chart";

  const ghost = projection?.prior?.ghost ?? null;
  const hasGhost = ghost !== null && ghost.length === cashFlow.buckets.length;
  const priorLabel = projection?.prior?.label ?? null;

  const rows: CashRow[] = cashFlow.buckets.map((b, i) => ({
    ...b,
    ghostCents: hasGhost ? (ghost![i] ?? 0) : null,
  }));

  const columns: Column<CashRow>[] = [
    { key: "label", header: "Period", render: (r) => r.label },
    {
      key: "earned",
      header: "Earned",
      align: "right",
      render: (r) => <span className="text-positive">{formatCents(r.incomeCents)}</span>,
    },
    {
      key: "spent",
      header: "Spent",
      align: "right",
      render: (r) => <span className="text-negative">{formatCents(r.spendingCents)}</span>,
    },
    { key: "net", header: "Net", align: "right", render: (r) => formatCentsSigned(r.netCents) },
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
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          caption={`Cash flow by period for ${periodLabel} — earned, spent, and net per bucket${
            hasGhost && priorLabel ? `, with ${priorLabel} for comparison` : ""
          }.`}
          emptyState="No activity in this period."
        />
      ) : active === "graph" ? (
        <CashFlowGraph data={cashFlow} projection={projection} />
      ) : (
        <CashFlowChart data={cashFlow} projection={projection} />
      )}
    </div>
  );
}
