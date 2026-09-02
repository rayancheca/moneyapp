"use client";

import { useState } from "react";

import { LENS_DIMENSION, LENS_LABELS, isTableLens } from "@/components/charts/chart-lens";
import { TransferMatrix } from "@/components/charts/TransferMatrix";
import { TransferRhythm } from "@/components/charts/TransferRhythm";
import { TransferSpine } from "@/components/charts/TransferSpine";
import { TransferTower } from "@/components/charts/TransferTower";
import {
  FLOW_MEASURE_DIMENSION,
  FLOW_MEASURE_LABELS,
  FLOW_SHAPE_DIMENSION,
  FLOW_SHAPE_LABELS,
  FLOW_SURFACE,
  FLOW_TOWER_VIEW_DIMENSION,
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

  // BY NAME, never by index — see the warning in transfer-flow-view-spec.ts.
  const measure = view[FLOW_MEASURE_DIMENSION.key] === "net" ? "net" : "gross";
  const shape = view[FLOW_SHAPE_DIMENSION.key] === "tower" ? "tower" : "spine";
  const showTable = isTableLens(view);

  // The ledger has no transfer-pair filter, so an arc drills to the SENDING
  // account over the same window rather than inventing a parameter
  // /transactions cannot honour.
  const senderHref = (fromAccountId: string) =>
    ledgerHref({ account: fromAccountId, from: range.from, to: range.to });

  return (
    <section aria-label="Transfers between your accounts" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitcher
            dimension={FLOW_MEASURE_DIMENSION}
            value={measure}
            onSelect={(v) => setView(FLOW_MEASURE_DIMENSION.key, v)}
            labels={FLOW_MEASURE_LABELS}
            ariaLabel="Transfer measure"
          />
          {/* the shape switcher is meaningless in the table lens — the matrix is
              the same matrix either way — so it is hidden rather than shown
              inert, and the chosen shape is remembered for the way back */}
          {!showTable && (
            <ViewSwitcher
              dimension={FLOW_SHAPE_DIMENSION}
              value={shape}
              onSelect={(v) => setView(FLOW_SHAPE_DIMENSION.key, v)}
              labels={FLOW_SHAPE_LABELS}
              ariaLabel="Transfer shape"
            />
          )}
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

      {showTable && <TransferMatrix data={data} measure={measure} />}

      {!showTable && shape === "tower" && (
        // No rhythm rail here: the tower's own Y axis IS time, so the rail would
        // be a second, worse answer to a question already on screen.
        <TransferTower
          data={data}
          measure={measure}
          hoveredEdgeId={hoveredEdgeId}
          onHoverEdge={setHoveredEdgeId}
          hrefForEdge={(arc) => senderHref(arc.fromAccountId)}
          /* the camera is this surface's view state, resolved by the RSC and
             written back through the same setView the other pills use */
          viewpoint={view[FLOW_TOWER_VIEW_DIMENSION.key] ?? "quarter"}
          onSelectViewpoint={(v) => setView(FLOW_TOWER_VIEW_DIMENSION.key, v)}
        />
      )}

      {!showTable && shape === "spine" && (
        <>
          <TransferSpine
            data={data}
            measure={measure}
            hoveredEdgeId={hoveredEdgeId}
            onHoverEdge={setHoveredEdgeId}
            hrefForEdge={(arc) => senderHref(arc.fromAccountId)}
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
