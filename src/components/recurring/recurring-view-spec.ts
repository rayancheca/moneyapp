import { LENS_DIMENSION } from "@/components/charts/chart-lens";
import { type ViewSpec } from "@/lib/view-state";

/**
 * The recurring series detail's switchable views (chart-parity pass 23). Only
 * the universal chart⇄table lens so far — the amount-history bars have no other
 * framing. One preference for all series (per-surface, consistent with the
 * model): a reader who wants the charge amounts as numbers wants that on every
 * subscription, not just the one they toggled.
 *
 * No "use client" so the server page can import it to resolve the active view.
 */
export const RECURRING_SERIES_SURFACE = "recurring-series";

export const RECURRING_SERIES_VIEW_SPEC: ViewSpec = [LENS_DIMENSION];
