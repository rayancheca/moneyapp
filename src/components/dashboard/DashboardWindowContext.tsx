"use client";

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import {
  canGoBack as canGoBackOf,
  canGoForward as canGoForwardOf,
  currentWindow,
  initialWindowHistory,
  windowHistoryReducer,
  type DashboardWindow,
  type WindowSource,
} from "@/lib/window-history";

/**
 * The dashboard's single source of truth for the active date window (dashboard-
 * dynamic plan §1). Brushing the net-worth chart PUSHes an absolute window here;
 * every linked panel below reads `current` and filters its data to it, and the
 * history stack powers the "← Back / →" timeframe controls. The window algebra
 * lives in the pure `@/lib/window-history` reducer (100% unit-tested); this file
 * is only the React glue.
 */

export interface DashboardWindowValue {
  /** the active custom window, or null at the base (range pills drive the chart) */
  current: DashboardWindow | null;
  canGoBack: boolean;
  canGoForward: boolean;
  push: (window: { start: string; end: string }, source: WindowSource) => void;
  back: () => void;
  forward: () => void;
  reset: () => void;
}

const DashboardWindowCtx = createContext<DashboardWindowValue | null>(null);

export function DashboardWindowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(windowHistoryReducer, initialWindowHistory);
  const value = useMemo<DashboardWindowValue>(
    () => ({
      current: currentWindow(state),
      canGoBack: canGoBackOf(state),
      canGoForward: canGoForwardOf(state),
      push: (window, source) => dispatch({ type: "PUSH", window: { ...window, source } }),
      back: () => dispatch({ type: "BACK" }),
      forward: () => dispatch({ type: "FORWARD" }),
      reset: () => dispatch({ type: "RESET" }),
    }),
    [state],
  );
  return <DashboardWindowCtx.Provider value={value}>{children}</DashboardWindowCtx.Provider>;
}

/**
 * Reads the dashboard's active-window context. Returns null outside a provider
 * so a ScrubChart rendered elsewhere (portfolio / holding / account balance)
 * keeps its own internal window untouched — the net-worth panel opts in simply
 * by being wrapped in the provider.
 */
export function useDashboardWindow(): DashboardWindowValue | null {
  return useContext(DashboardWindowCtx);
}
