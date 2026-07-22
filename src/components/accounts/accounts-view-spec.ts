import { LENS_DIMENSION } from "@/components/charts/chart-lens";
import { type ViewSpec } from "@/lib/view-state";

/**
 * The account balance chart's switchable views (chart-parity pass 23). The only
 * dimension so far is the universal chart⇄table lens; the balance chart has no
 * Value/Return framing of its own. One preference for all accounts (per-surface,
 * consistent with the model) — a reader who wants the numbers wants them on
 * every account.
 *
 * No "use client" so the server page can import it to resolve the active view.
 */
export const ACCOUNT_SURFACE = "account";

export const ACCOUNT_VIEW_SPEC: ViewSpec = [LENS_DIMENSION];
