/**
 * A navigation's START, as an event any client component can hear.
 *
 * Next calls `onRouterTransitionStart` (src/instrumentation-client.ts) for every push, replace
 * and Back/Forward before it dispatches one — the only moment a navigation that is not a press
 * can be seen in time. Its COMMIT is too late: React 19 entangles every transition with an
 * async action still pending, so a link followed while a view press is being written cannot
 * commit until that write has landed — and by then the press has navigated over it.
 *
 * A window event, not a module-level registry: the instrumentation module is loaded before the
 * app hydrates, and whoever listens comes and goes with the tree.
 */
export const NAVIGATION_START = "moneyapp:navigation-start";

export type NavigationKind = "push" | "replace" | "traverse";

export interface NavigationStart {
  /** the href navigated to, as the caller spelled it (absolute for Back/Forward) */
  url: string;
  kind: NavigationKind;
}

export function announceNavigationStart(url: string, kind: NavigationKind): void {
  window.dispatchEvent(new CustomEvent<NavigationStart>(NAVIGATION_START, { detail: { url, kind } }));
}
