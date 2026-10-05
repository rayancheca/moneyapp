"use client";

import { createContext, Suspense, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { createPageAsks, type PageAsks } from "@/lib/page-asks";
import { NAVIGATION_START, type NavigationStart } from "./navigation-start";

/**
 * The page's asked view (lib/page-asks.ts), held once for the whole app by the root layout and
 * read by every switcher and URL writer under it. Null outside the provider: a switcher rendered
 * alone (a unit test's static render) builds every press on the server's view, as it always did.
 */
const PageAsksContext = createContext<PageAsks | null>(null);

export function usePageAsks(): PageAsks | null {
  return useContext(PageAsksContext);
}

export function PageAsksProvider({ children }: { children: ReactNode }) {
  // one cell per mounted app, never a module-level one: a module outlives the page it was for
  const [asks] = useState(createPageAsks);

  // A navigation that is not a press drops the ask as it STARTS (see navigation-start.ts for
  // why its commit is too late). Back/Forward always does: it commits outside any transition
  // while a press may still be pending, and can land on a URL a press asked for.
  useEffect(() => {
    const onStart = (event: Event): void => {
      const { url, kind } = (event as CustomEvent<NavigationStart>).detail;
      if (kind === "traverse") asks.moved();
      else asks.departing(url, kind);
    };
    window.addEventListener(NAVIGATION_START, onStart);
    return () => window.removeEventListener(NAVIGATION_START, onStart);
  }, [asks]);

  return (
    <PageAsksContext value={asks}>
      {/* its own boundary: reading the URL must never suspend the page it wraps */}
      <Suspense fallback={null}>
        <CommittedUrl asks={asks} />
      </Suspense>
      {children}
    </PageAsksContext>
  );
}

/**
 * Tells the asks every URL the router commits: a press landing (which forgets the older URLs
 * asked before it), or a move nothing announced — a redirect.
 */
function CommittedUrl({ asks }: { asks: PageAsks }): null {
  const pathname = usePathname();
  const query = useSearchParams()?.toString() ?? "";
  // a LAYOUT effect: it runs inside the commit, before any press can be made on the new page
  useLayoutEffect(() => {
    asks.committed(query === "" ? pathname : `${pathname}?${query}`);
  }, [asks, pathname, query]);
  return null;
}
