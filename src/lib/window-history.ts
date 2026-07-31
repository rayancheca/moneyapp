/**
 * Selection history for the dashboard's active date window (dashboard-dynamic
 * plan §1.1, §4). The net-worth chart is an OVERVIEW; brushing it selects an
 * absolute `[start, end]` window that cross-filters the detail panels below.
 * This pure reducer backs the browser-like back / forward through those
 * selections so the user can step through the timeframes they've inspected.
 *
 * The model is a stack of pushed VIEWS plus a cursor `index`. A view is either
 * a custom window or `null` — the base view, where the range pills drive the
 * chart. `index === -1` is the initial base (nothing inspected yet), so the
 * first BACK from a brush lands back on the default range. A pill click while
 * zoomed is a NAVIGATION to the base view (PUSH_BASE) — it joins the trail so
 * Back returns to the window that was being inspected instead of wiping it;
 * RESET alone clears the whole stack. Pure (no React, no DOM) so the history
 * algebra is unit-tested to 100%.
 */

export type WindowSource = "pill" | "brush" | "input" | "reset" | "zoom";

export interface DashboardWindow {
  /** inclusive ISO day (YYYY-MM-DD) */
  start: string;
  /** inclusive ISO day (YYYY-MM-DD) */
  end: string;
  /** how this window was selected; carried for the linked panel + header copy (item 2) */
  source: WindowSource;
}

export interface WindowHistoryState {
  /** each entry is a view: a custom window, or `null` for the base view */
  stack: readonly (DashboardWindow | null)[];
  /** cursor into `stack`; -1 = the initial base (no custom window) view */
  index: number;
}

export type WindowHistoryAction =
  | { type: "PUSH"; window: DashboardWindow }
  /** navigate to the base view (a pill click while zoomed) — keeps the trail */
  | { type: "PUSH_BASE" }
  | { type: "BACK" }
  | { type: "FORWARD" }
  | { type: "RESET" };

/** The initial (base) state: empty stack, cursor parked at the base. */
export const initialWindowHistory: WindowHistoryState = { stack: [], index: -1 };

// History tracks distinct VIEWS, and two windows with the same [start, end] show
// the same view regardless of how they were selected — so `source` (non-visual
// metadata) is excluded here, and re-selecting the current window by any means is
// a no-op rather than a visually-dead Back step.
function sameView(a: DashboardWindow, b: DashboardWindow): boolean {
  return a.start === b.start && a.end === b.end;
}

export function windowHistoryReducer(
  state: WindowHistoryState,
  action: WindowHistoryAction,
): WindowHistoryState {
  switch (action.type) {
    case "PUSH": {
      const current = currentWindow(state);
      // Ignore a re-push of the window already shown (a double-fired brush, or the
      // same dates re-entered) so BACK never hits a dead step.
      if (current && sameView(current, action.window)) return state;
      // Truncate any forward history (browser-like), then append + advance.
      const stack = [...state.stack.slice(0, state.index + 1), action.window];
      return { stack, index: stack.length - 1 };
    }
    case "PUSH_BASE": {
      // Already showing the base view (initial cursor, or a base entry) — a
      // repeated pill click must not mint a dead Back step.
      if (currentWindow(state) === null) return state;
      const stack = [...state.stack.slice(0, state.index + 1), null];
      return { stack, index: stack.length - 1 };
    }
    case "BACK":
      return state.index < 0 ? state : { ...state, index: state.index - 1 };
    case "FORWARD":
      return state.index >= state.stack.length - 1
        ? state
        : { ...state, index: state.index + 1 };
    case "RESET":
      return state.index === -1 && state.stack.length === 0 ? state : initialWindowHistory;
  }
}

/** The active window, or null on any base view (pills drive the chart). */
export function currentWindow(state: WindowHistoryState): DashboardWindow | null {
  return state.index >= 0 ? (state.stack[state.index] ?? null) : null;
}

/** True when BACK would change the view (step toward, or to, the base). */
export function canGoBack(state: WindowHistoryState): boolean {
  return state.index >= 0;
}

/** True when FORWARD would restore a window truncated off by a later PUSH. */
export function canGoForward(state: WindowHistoryState): boolean {
  return state.index < state.stack.length - 1;
}
