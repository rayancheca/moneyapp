"use client";

import { useEffect, useState } from "react";

/**
 * Tracks the `(prefers-reduced-motion: reduce)` media query. Needed because
 * recharts drives its entrance animation in JavaScript, which the global CSS
 * reduced-motion guard (globals.css) cannot reach — so the chart must gate its
 * JS reveal on this hook explicitly.
 *
 * SSR-safe: defaults to `false` (motion allowed) on the server and first paint,
 * then syncs to the real preference after mount. Because the chart's reveal is a
 * mount-only, non-layout animation, a one-frame correction is invisible and
 * never causes a hydration mismatch (the DOM is identical either way).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
