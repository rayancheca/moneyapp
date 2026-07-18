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

/** ScrubChart props that lift its brush/zoom window to the shared history stack. */
export interface DashboardWindowProps {
  activeWindow?: { start: string; end: string } | null;
  onWindowChange?: (window: { start: string; end: string } | null, source: WindowSource) => void;
  history?: { canGoBack: boolean; canGoForward: boolean; onBack: () => void; onForward: () => void };
}

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
  /** navigate to the base view (pill click) — joins the trail, Back returns */
  toBase: () => void;
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
      toBase: () => dispatch({ type: "PUSH_BASE" }),
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

/**
 * The ScrubChart brush/history props wired to the shared window — used by EVERY
 * dashboard hero panel (net worth AND the view-mode rollups) so brushing any
 * mode drives the same window the linked activity panel cross-filters on, and a
 * window survives a mode switch consistently. Returns {} outside a provider so a
 * standalone chart stays uncontrolled and byte-identical.
 */
export function useDashboardWindowProps(): DashboardWindowProps {
  const windowCtx = useDashboardWindow();
  const winStart = windowCtx?.current?.start ?? null;
  const winEnd = windowCtx?.current?.end ?? null;
  // stable identity while unchanged — an inline literal defeats ScrubChart's
  // `slice` memo and recomputes the whole series on every parent re-render
  const activeWindow = useMemo(
    () => (winStart && winEnd ? { start: winStart, end: winEnd } : null),
    [winStart, winEnd],
  );
  return useMemo<DashboardWindowProps>(() => {
    if (!windowCtx) return {};
    return {
      activeWindow,
      onWindowChange: (w, source) => {
        if (w) windowCtx.push(w, source);
        // a pill click NAVIGATES to base — it joins the history trail (Back
        // returns to the inspected window), never wipes it
        else windowCtx.toBase();
      },
      history: {
        canGoBack: windowCtx.canGoBack,
        canGoForward: windowCtx.canGoForward,
        onBack: windowCtx.back,
        onForward: windowCtx.forward,
      },
    };
  }, [windowCtx, activeWindow]);
}
