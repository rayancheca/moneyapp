"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { navigateAfterBackSaves, type Landing } from "@/lib/page-asks";
import { usePageAsks } from "./usePageAsks";

/**
 * The navigation of every URL writer that writes nothing — a range pill (ChartFocus's
 * `useRangeParam`), a same-page link (`usePageLinks`: a period arrow ‹ ›, a /recurring tab) and a
 * param beside the view (`useViewState`'s `setParam`: the benchmark). It asks for its URL
 * (lib/page-asks.ts), so a press made before that page is drawn builds on it, then goes there — once
 * Back's saves of the view on screen have landed, or BACK_SAVE_WAIT_MS has passed
 * (`navigateAfterBackSaves`). One rule, every writer: 🔴 only the pill waited, so ‹ pressed while
 * Back's save was being written drew June in the view he had walked away from.
 */
export function useUrlWriter(): (to: Landing) => void {
  const router = useRouter();
  const asks = usePageAsks();
  return useCallback(
    (to: Landing) => {
      const go = (): void => router[to.kind](to.href, { scroll: to.scroll });
      if (asks === null) {
        go();
        return;
      }
      asks.ask(to.href, {});
      navigateAfterBackSaves(asks, to.href, go);
    },
    [router, asks],
  );
}
