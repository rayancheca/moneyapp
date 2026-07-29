import { LENS_DIMENSION } from "@/components/charts/chart-lens";
import { type ViewSpec } from "@/lib/view-state";

/**
 * The /flow surface's switchable views.
 *
 * `measure` is a FIRST-CLASS dimension, not a checkbox, because gross and net
 * are two different true answers rather than a display preference. He
 * round-trips money, so gross overstates real movement badly — on the real data
 * $96,482.26 of $330,513.57 came straight back. Making the choice a view means
 * it lives in the URL, is shareable, and persists like every other view.
 */
export const FLOW_SURFACE = "flow";

export const FLOW_VIEW_SPEC: ViewSpec = [
  { key: "measure", options: ["gross", "net"] },
  // APPENDED, never inserted: TransferFlowPanel indexes [0] positionally, and
  // chart-lens.ts warns that reordering silently repoints persisted preferences.
  LENS_DIMENSION,
];

export const FLOW_MEASURE_LABELS: Record<string, string> = { gross: "Gross", net: "Net" };
