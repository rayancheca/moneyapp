"use client";

import { useCallback, useTransition } from "react";
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
 * sidesteps a whole class of prop/state reconciliation bugs.
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
  isPending: boolean;
}

export function useViewState(opts: UseViewStateOptions): UseViewStateResult {
  const { surface, spec, state, basePath, baseParams } = opts;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const setView = useCallback(
    (key: string, value: string) => {
      const next = setDimension(spec, state, key, value);
      if (next === state) return; // unknown dim / invalid value / already-selected → no-op
      const href = `${basePath}${viewHrefQuery(spec, next, baseParams)}`;
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
    [surface, spec, state, basePath, baseParams, router],
  );

  return { state, setView, isPending };
}
