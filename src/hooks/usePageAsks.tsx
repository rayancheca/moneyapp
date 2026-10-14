"use client";

import { createContext, Suspense, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  const router = useRouter();

  // A navigation that is not a press drops the ask as it STARTS (see navigation-start.ts for
  // why its commit is too late). Back/Forward always does: it commits outside any transition
  // while a press may still be pending, and can land on a URL a press asked for.
  useEffect(() => {
    // every navigation's start, counted: a link's page is drawn again only while nothing has moved since
    let starts = 0;
    const onStart = (event: Event): void => {
      const { url, kind } = (event as CustomEvent<NavigationStart>).detail;
      starts += 1;
      if (kind === "traverse") {
        asks.moved();
        return;
      }
      asks.departing(url, kind);
      // ⚖️ B2: a link carries no view and goes at once, never held as a URL writer is (`navigateAfterBackSaves`),
      // so followed while a save of Back's view is being written its page can draw the saved view he walked away
      // from. 🔴 /investments?range=1Y, Return, Back (Value), the sidebar's /investments: his Return, and once Back's
      // save landed nothing drew the Value (review of ab13868, measured 2026-10-13). Drawn again once they land, as
      // a writer gone at BACK_SAVE_WAIT_MS goes again then — the page on screen, re-rendered where he is, and only
      // while nothing has moved since (a writer gone at its bound goes again itself, and that is a move).
      const landing = asks.backSavesLanding();
      if (landing === null) return;
      const at = starts;
      void landing.then(() => {
        if (starts === at) router.refresh();
      });
    };
    window.addEventListener(NAVIGATION_START, onStart);
    return () => window.removeEventListener(NAVIGATION_START, onStart);
  }, [asks, router]);

  return (
    <PageAsksContext value={asks}>
      {/* its own boundary: reading the URL must never suspend the page it wraps. BEFORE the
          page: layout effects run in tree order, so a Back that mounts a page of another route
          in the commit its URL lands in has landed (backLanding) when those switchers run */}
      <Suspense fallback={null}>
        <CommittedUrl asks={asks} />
      </Suspense>
      {children}
    </PageAsksContext>
  );
}

/**
 * Tells the asks every URL the router commits: a press landing (which forgets the older URLs
 * asked before it), a Back/Forward landing (whose switchers re-save the views it drew), or a
 * move nothing announced — a redirect.
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
