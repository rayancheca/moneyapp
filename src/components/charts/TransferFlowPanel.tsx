"use client";

import { useState } from "react";

import { LENS_DIMENSION, LENS_LABELS, isTableLens } from "@/components/charts/chart-lens";
import { TransferMatrix } from "@/components/charts/TransferMatrix";
import { TransferRhythm } from "@/components/charts/TransferRhythm";
import { TransferSpine } from "@/components/charts/TransferSpine";
import {
  FLOW_MEASURE_LABELS,
  FLOW_SURFACE,
  FLOW_VIEW_SPEC,
} from "@/components/charts/transfer-flow-view-spec";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { ledgerHref } from "@/lib/ledger-href";
import { type ViewState } from "@/lib/view-state";
import type { TransferFlowData } from "@/services/transfer-flow";

/**
 * The interactive shell around the transfer-flow view.
 *
 * Owns the two switchers and the LIFTED hover state, so hovering an arc in the
 * spine dims everything but the matching stack in the rhythm rail below it, and
 * vice versa. Neither chart owns that state, because the highlight is a fact
 * about the page, not about either chart.
 */

export interface TransferFlowPanelProps {
  data: TransferFlowData;
  state: ViewState;
  range: { from: string; to: string };
}

export function TransferFlowPanel({ data, state, range }: TransferFlowPanelProps) {
  const { state: view, setView } = useViewState({
    surface: FLOW_SURFACE,
    spec: FLOW_VIEW_SPEC,
    state,
    basePath: "/flow",
    // /flow has no range or filter params of its own to preserve across a
    // switch — the whole history is always in view.
    baseParams: {},
  });
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const measureDim = FLOW_VIEW_SPEC[0]!; // "measure"
  const measure = view[measureDim.key] === "net" ? "net" : "gross";
  const showTable = isTableLens(view);

  return (
    <section aria-label="Transfers between your accounts" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitcher
            dimension={measureDim}
            value={measure}
            onSelect={(v) => setView(measureDim.key, v)}
            labels={FLOW_MEASURE_LABELS}
            ariaLabel="Transfer measure"
          />
          <ViewSwitcher
            dimension={LENS_DIMENSION}
            value={showTable ? "table" : "chart"}
            onSelect={(v) => setView(LENS_DIMENSION.key, v)}
            labels={LENS_LABELS}
            ariaLabel="Transfer lens"
          />
        </div>
        <p className="text-xs text-ink-muted">
          {measure === "net"
            ? "Round-trips cancelled out — what actually moved."
            : "Every transfer, including money that came straight back."}
        </p>
      </div>

      {showTable ? (
        <TransferMatrix data={data} measure={measure} />
      ) : (
        <>
          <TransferSpine
            data={data}
            measure={measure}
            hoveredEdgeId={hoveredEdgeId}
            onHoverEdge={setHoveredEdgeId}
            hrefForEdge={(arc) =>
              // The ledger has no transfer-pair filter, so drill to the SENDING
              // account over the same window rather than invent a parameter
              // /transactions cannot honour.
              ledgerHref({ account: arc.fromAccountId, from: range.from, to: range.to })
            }
          />
          <TransferRhythm
            data={data}
            measure={measure}
            hoveredEdgeId={hoveredEdgeId}
            onHoverEdge={setHoveredEdgeId}
          />
        </>
      )}
    </section>
  );
}
