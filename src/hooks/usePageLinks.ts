"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { pageLinkHref, type LinkParams } from "@/lib/page-asks";
import { usePageAsks } from "./usePageAsks";

/** A same-page link's props for `next/link`. */
export interface PageLinkProps {
  /** where it goes from the URL on screen: what a middle-click, a copied link or a prefetch reads */
  href: string;
  /** a plain click (next/link calls it for no other): built on the newest asked URL instead */
  onNavigate: (event: { preventDefault(): void }) => void;
}

export interface PageLinks {
  /** the props of a link to this page with `set` written over the params these links own */
  link: (set: LinkParams) => PageLinkProps;
  /** go where that link goes, as a click on it does (a form's Apply) */
  follow: (set: LinkParams) => void;
}

const NONE: readonly (readonly [string, string])[] = [];

/**
 * Links to the page they sit on that change only params beside its views — the period picker,
 * the /recurring tabs (lib/page-asks.ts `pageLinkHref`). Each keeps every other param of the
 * page's current URL, a view only the URL held among them, the way a press does — and, like a
 * press, never a one-shot message (`ONE_SHOT_PARAMS`: a refused action's `?error=`).
 *
 * Followed, a link is a URL writer like a range pill: it builds on the NEWEST asked URL while a
 * press may be in flight, and asks for its own, so a press made before its page is drawn builds
 * on it (never back on the period it left), a press in flight lands on it, and Back to it
 * re-saves a view his press carried into it (B2) and never one only a link put there.
 */
export function usePageLinks(basePath: string, owns: readonly string[]): PageLinks {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const asks = usePageAsks();
  return useMemo(() => {
    // the URL on screen, as the router last committed it, when it is this page's
    const shown = pathname === basePath && searchParams !== null ? [...searchParams] : NONE;
    const follow = (set: LinkParams): void => {
      const asked = asks?.paramsOn(basePath) ?? null;
      const href = pageLinkHref(basePath, asked === null ? shown : Object.entries(asked), owns, set);
      asks?.ask(href, {});
      router.push(href);
    };
    return {
      follow,
      link: (set) => ({
        href: pageLinkHref(basePath, shown, owns, set),
        onNavigate: (event) => {
          event.preventDefault();
          follow(set);
        },
      }),
    };
  }, [router, pathname, searchParams, asks, basePath, owns]);
}
