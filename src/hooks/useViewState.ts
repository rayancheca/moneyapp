"use client";

import { useCallback, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDimension, viewHrefQuery, type ViewSpec, type ViewState } from "@/lib/view-state";
import { saveViewPreferenceAction } from "@/app/settings/actions";

/**
 * The React glue over the pure view-state model (NS#2 Pillar 2). The RSC resolves
 * the active view (URL > persisted > default) and passes it down as `state` — the
 * source of truth. `setView` navigates to the new view's URL (so it's shareable +
 * Back works, exactly like PeriodSelector) and fire-and-forget persists the choice
 * so it's sticky on the next cold visit. No local optimistic state: the URL IS the
 * state, and the force-dynamic RSC re-renders the chosen view on navigation — which
 * sidesteps a whole class of prop/state reconciliation bugs. The one thing it keeps is
 * the view the newest press asked for, never rendered: a press made while another is in
 * flight is built on it (see `updateView`).
 */
export interface UseViewStateOptions {
  /** stable surface id, the app_settings key (e.g. "spending") */
  surface: string;
  spec: ViewSpec;
  /** the RSC-resolved active view */
  state: ViewState;
  /** the route the switcher navigates within (e.g. "/spending") */
  basePath: string;
  /** URL params to preserve across a view switch (period, filters) */
  baseParams: Record<string, string>;
}

export interface UseViewStateResult {
  state: ViewState;
  setView: (key: string, value: string) => void;
  /**
   * Persist and navigate to the view `build` makes from the one a press builds on (see
   * `setView`), or do nothing when it returns null. For a key the surface persists beside
   * its spec — the dashboard's `accts` — which also rides the URL, over `baseParams`.
   */
  updateView: (build: (base: ViewState) => ViewState | null) => void;
  isPending: boolean;
}

/** The keys of a view outside its spec — carried in the URL beside the spec's own. */
function carriedParams(spec: ViewSpec, view: ViewState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(view)) {
    if (!spec.some((dim) => dim.key === key)) out[key] = value;
  }
  return out;
}

export function useViewState(opts: UseViewStateOptions): UseViewStateResult {
  const { surface, spec, state, basePath, baseParams } = opts;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // the view the newest press asked for (see `updateView`)
  const asked = useRef<ViewState | null>(null);

  const updateView = useCallback(
    (build: (base: ViewState) => ViewState | null) => {
      // 🔴 While a press is in flight the server has not resolved it, so `state` is still
      // the view from BEFORE it — and a press persists and navigates to the WHOLE view. A
      // second press built on `state` wrote the first one's dimension straight back and
      // navigated away from it: Return, then Table, landed on the Price table with
      // `view: "value"` saved. So until every press has landed, a press builds on the view
      // the newest one asked for. `isPending` spans the press's navigation, not just its
      // write — measured 2026-10-01: a switcher disabled on it stayed disabled until the
      // new view committed — so once it is false, `state` is the truth again (Back, a link).
      const base = isPending && asked.current !== null ? asked.current : state;
      const next = build(base);
      // unknown dim / invalid value / already-selected → no-op
      if (next === null || next === base) return;
      asked.current = next;
      const params = { ...baseParams, ...carriedParams(spec, next) };
      const href = `${basePath}${viewHrefQuery(spec, next, params)}`;
      startTransition(async () => {
        // Persist BEFORE navigating. Switching to the DEFAULT view drops its URL
        // param (clean links), so the RSC falls back to the PERSISTED preference —
        // it must already be written or the navigation re-reads the stale value.
        // Best-effort: on a transport error we still navigate (the URL drives
        // non-default views), and never surface a toast for a view toggle.
        try {
          await saveViewPreferenceAction(surface, next);
        } catch {
          /* persistence is best-effort */
        }
        router.push(href, { scroll: false });
      });
    },
    [isPending, surface, spec, state, basePath, baseParams, router],
  );

  const setView = useCallback(
    (key: string, value: string) => updateView((base) => setDimension(spec, base, key, value)),
    [spec, updateView],
  );

  return { state, setView, updateView, isPending };
}
