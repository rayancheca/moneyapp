"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDimension, viewHrefQuery, type ViewSpec, type ViewState } from "@/lib/view-state";
import type { Landing, PressBase } from "@/lib/page-asks";
import { saveViewPreferenceAction } from "@/app/settings/actions";
import { usePageAsks } from "./usePageAsks";

/**
 * The React glue over the pure view-state model (NS#2 Pillar 2). The RSC resolves
 * the active view (URL > persisted > default) and passes it down as `state` — the
 * source of truth. `setView` navigates to the new view's URL (so it's shareable +
 * Back works, exactly like PeriodSelector) and fire-and-forget persists the choice
 * so it's sticky on the next cold visit. No local optimistic state: the URL IS the
 * state, and the force-dynamic RSC re-renders the chosen view on navigation — which
 * sidesteps a whole class of prop/state reconciliation bugs.
 *
 * The one thing a press reads besides its props is the page's ASKED view
 * (lib/page-asks.ts): while a press is in flight the server has not drawn it, so the
 * next press on the page — on this switcher, another one, or another URL writer —
 * builds on what it asked for, not on the view from before it. With nothing asked, it
 * builds on the URL on screen, so another switcher's view only that URL holds (a
 * shared link's) rides along.
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
  /**
   * Keys the surface persists beside its spec and carries in its URL, over `baseParams`
   * (the dashboard's `accts`). `updateView` may set them; they are never spec dimensions.
   */
  carry?: readonly string[];
}

export interface UseViewStateResult {
  state: ViewState;
  setView: (key: string, value: string) => void;
  /**
   * Persist and navigate to the view `build` makes from the one a press builds on (see
   * `setView`), or do nothing when it returns null. The view it is handed carries a `carry`
   * key only while a press that set it is asked for.
   */
  updateView: (build: (base: ViewState) => ViewState | null) => void;
  /**
   * Navigate to the page with one param beside the view set (or removed, with null), built
   * on the newest asked URL. It writes nothing: for a choice persisted by its own action
   * first (the benchmark).
   */
  setParam: (key: string, value: string | null) => void;
  isPending: boolean;
}

const NO_CARRY: readonly string[] = [];

/** the carried keys `view` sets, as URL params */
function carriedParams(carry: readonly string[], view: ViewState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of carry) {
    const value = view[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sameValues(keys: Iterable<string>, a: ViewState, b: ViewState): boolean {
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export function useViewState(opts: UseViewStateOptions): UseViewStateResult {
  const { surface, spec, state, basePath, baseParams, carry = NO_CARRY } = opts;
  const router = useRouter();
  const asks = usePageAsks();
  const [isPending, startTransition] = useTransition();

  const pressBase = useCallback(
    (): PressBase =>
      asks?.base({ basePath, spec, state, baseParams, carry }) ?? { view: state, params: baseParams, asked: false },
    [asks, basePath, spec, state, baseParams, carry],
  );

  const updateView = useCallback(
    (build: (base: ViewState) => ViewState | null) => {
      const base = pressBase();
      const next = build(base.view);
      if (next === null) return;
      const keys = new Set([...Object.keys(next), ...Object.keys(base.view)]);
      // unknown dim / invalid value / already-selected → no-op. Already asked for but not yet
      // drawn is NOT selected: the press is sent again (e2e's pressView retries until its pill
      // says it took, as anyone would) — the same write and the same URL, never a toggle.
      if (sameValues(keys, next, base.view) && sameValues(spec.map((dim) => dim.key), next, state)) return;
      const href = `${basePath}${viewHrefQuery(spec, next, { ...base.params, ...carriedParams(carry, next) })}`;
      asks?.ask(href, next);
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
        // To the NEWEST asked URL, which every press made since this one built on — not to
        // this press's own, or a range pill pressed meanwhile would be navigated away from.
        // A link he followed meanwhile is made again, so its page draws this write; after
        // Back, nowhere — the write stands, and he is not dragged back to the page he left.
        const to: Landing | null = asks === null ? { href, kind: "push", scroll: false } : asks.landing();
        if (to !== null) router[to.kind](to.href, { scroll: to.scroll });
      });
    },
    [asks, pressBase, surface, spec, state, basePath, carry, router],
  );

  const setView = useCallback(
    (key: string, value: string) => updateView((base) => setDimension(spec, base, key, value)),
    [spec, updateView],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const base = pressBase();
      const { [key]: _replaced, ...rest } = base.params;
      const params = value === null ? rest : { ...rest, [key]: value };
      const href = `${basePath}${viewHrefQuery(spec, base.view, { ...params, ...carriedParams(carry, base.view) })}`;
      asks?.ask(href, {});
      router.push(href, { scroll: false });
    },
    [asks, pressBase, spec, basePath, carry, router],
  );

  return { state, setView, updateView, setParam, isPending };
}
