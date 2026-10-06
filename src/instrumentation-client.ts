import { announceNavigationStart, type NavigationKind } from "@/hooks/navigation-start";

/**
 * The browser half of Next's instrumentation, loaded before the app hydrates. Next calls this
 * before every push, replace and Back/Forward it dispatches; the page's asked view
 * (src/hooks/usePageAsks.tsx) listens, so a navigation that is not a press drops it in time.
 */
export function onRouterTransitionStart(url: string, navigationType: NavigationKind): void {
  announceNavigationStart(url, navigationType);
}
