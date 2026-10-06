"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/shell/Icon";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { usePageAsks } from "@/hooks/usePageAsks";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { ChartRange } from "@/lib/chart-range";

/**
 * Chart focus mode (S8, Track 2 → generalized in the pass-22 chart-parity pass):
 * any range-driven chart expands into a full-width modal for close inspection.
 * One component owns BOTH renders so the `view-transition-name` can hop from the
 * inline card to the dialog — document.startViewTransition then morphs the shared
 * element (progressive: plain open/close where unsupported, and under
 * prefers-reduced-motion the transition is skipped entirely). The dialog is a
 * native <dialog> — free focus trap, Escape, and focus return, same doctrine as
 * Sheet.tsx. Both instances share one lifted range, so the modal opens on the
 * pill the user was inspecting, and a pill change made in focus mode is still
 * there when the modal closes.
 *
 * Generic by construction: the caller passes `renderPanel` (the SAME panel — incl.
 * any view-mode switcher — in the inline card and the dialog, so view parity is
 * structural, not re-implemented) and a `label` (the view's name, announced by
 * the opener/dialog/heading). `defaultRange` seeds the lifted range so a panel
 * whose inline default is not "1Y" (e.g. Balance opens on "3M") starts correctly.
 * `cardClassName` lets a caller drop the dashboard's `mt-4` when the card sits in
 * a `space-y-*` stack instead of below the hero StatCards.
 */
export interface ChartFocusRenderOpts {
  /** taller in the focus dialog; undefined = the panel's inline default */
  heightClass?: string;
  activeRange: ChartRange;
  onRangeChange: (range: ChartRange) => void;
}

export function ChartFocus({
  renderPanel,
  label = "Net worth",
  defaultRange = "1Y",
  cardClassName = "relative mt-4",
  resetRangeKey,
  rangeParam,
}: {
  /** renders the SAME panel (incl. any view-mode switcher) in the inline card
   *  and the focus dialog — view parity is structural, not re-implemented */
  renderPanel: (opts: ChartFocusRenderOpts) => ReactNode;
  /** the current view's name — the opener/dialog/heading announce it so a
   *  screen-reader user in Owed/Accounts mode isn't told it's "Net worth" */
  label?: string;
  /** seeds the lifted range so the closed card renders on the panel's own
   *  default pill (Balance = "3M", Portfolio/Holding = their RSC range) */
  defaultRange?: ChartRange;
  /** the inline SurfaceCard's className — defaults to the dashboard's `mt-4`
   *  spacing; a stacked page passes `"relative"` (no top margin) */
  cardClassName?: string;
  /**
   * When set, the chosen range is mirrored into this URL search param.
   *
   * Without it the pill is pure client state that never leaves this component,
   * which is why every server-rendered panel on the page — holdings, movers,
   * allocation, the heatmap — stayed frozen at "today" while the chart moved.
   * The page reads the param back and re-queries, so the whole surface answers
   * the same question.
   *
   * The local state below stays the source of truth for the CHART, which slices
   * already-shipped points in a `useMemo`. So the line redraws on the same tick
   * as the click and the server round-trip only refreshes the panels that need
   * one — pressing a pill never feels like a page load.
   */
  rangeParam?: string;
  /** an opaque identity for the underlying SERIES. When it changes, the lifted
   *  range resets to `defaultRange`. Holding passes its Price/Return view here:
   *  those two series are not day-aligned, so carrying a range like "1M" from
   *  the (today-anchored) price series into a return series that ended weeks ago
   *  would leave ScrubChart falling back to the full series while the pill still
   *  reads "1M" (a lying caption). Omitted where the series axis is stable. */
  resetRangeKey?: string;
}) {
  const [open, setOpen] = useState(false);
  // one range for both instances ("the same chart, bigger") — seeded from the
  // panel's default so the closed state renders exactly as before
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const syncRangeParam = useRangeParam(rangeParam);

  /**
   * Adopt a range arriving from the URL — Back/Forward, or a link into a range.
   * Guarded on inequality so the optimistic update above never round-trips into
   * a second render, and so callers without `rangeParam` are untouched.
   */
  useEffect(() => {
    if (rangeParam === undefined) return;
    setRange((current) => (current === defaultRange ? current : defaultRange));
  }, [rangeParam, defaultRange]);

  function selectRange(next: ChartRange): void {
    // local first: the chart re-slices synchronously, before any navigation
    setRange(next);
    syncRangeParam(next);
  }
  // reset the shared range when the caller's series identity changes (see
  // resetRangeKey). A ref-guarded effect so it NEVER fires on mount or for the
  // (undefined) callers whose series axis is stable — those keep byte-identical.
  const prevResetKey = useRef(resetRangeKey);
  useEffect(() => {
    if (resetRangeKey !== undefined && prevResetKey.current !== resetRangeKey) {
      prevResetKey.current = resetRangeKey;
      setRange(defaultRange);
    }
  }, [resetRangeKey, defaultRange]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Backdrop close must see the FULL gesture on the backdrop (same doctrine
  // as Sheet.tsx): a drag that starts on dialog content and releases over the
  // backdrop fires its click on the <dialog> (nearest common ancestor) — that
  // must not close a modal whose main surface is drag-to-zoom.
  const pointerDownOnBackdropRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  function transition(update: () => void): void {
    const supported = "startViewTransition" in document;
    if (!supported || reducedMotion) {
      update();
      return;
    }
    // startViewTransition snapshots, runs the callback, then snapshots again
    // as soon as the callback settles — React's async commit would land AFTER
    // that second snapshot, so the state change must be flushed synchronously
    // inside the callback or the morph silently degrades to a pop-in.
    (document as Document & { startViewTransition: (cb: () => void) => void }).startViewTransition(() => {
      flushSync(update);
    });
  }

  // useLayoutEffect (not useEffect): inside flushSync the layout effect runs
  // before the browser takes the view transition's "new" snapshot, so the
  // dialog is already visible in it. A passive effect fires after paint —
  // after the snapshot — and the morph would capture a still-closed dialog.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const chartName = { viewTransitionName: "chart-focus" } as React.CSSProperties;

  return (
    <>
      {/* the card stays MOUNTED while the dialog is open — the native dialog
          returns focus to its opener, which must be the same surviving node.
          The view-transition-name hops to whichever instance is visible. */}
      <SurfaceCard className={cardClassName} style={open ? undefined : chartName}>
        <button
          type="button"
          onClick={() => transition(() => setOpen(true))}
          aria-label={`Focus the ${label} chart`}
          className="absolute top-3 right-3 z-10 rounded-md p-1.5 text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
        >
          <Icon name="arrow-up-right" className="size-4" />
        </button>
        {renderPanel({ activeRange: range, onRangeChange: selectRange })}
      </SurfaceCard>

      <dialog
        ref={dialogRef}
        // Escape closes NATIVELY — intercepting cancel to morph is a trap:
        // preventDefault consumes the close-watcher's activation grant (a
        // second Escape then fires no cancel at all), and a view-transition
        // callback scheduled from inside close-request processing was observed
        // never running in real Chromium — stranding the modal open. Closing
        // is correctness, morphing is decoration: the button/backdrop paths
        // keep the morph; Escape just closes. onClose syncs React state after
        // ANY native close (it is a no-op when we closed via the effect).
        onClose={() => setOpen(false)}
        onPointerDown={(e) => {
          pointerDownOnBackdropRef.current = e.target === dialogRef.current;
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current && pointerDownOnBackdropRef.current) {
            transition(() => setOpen(false));
          }
        }}
        aria-label={`${label} chart — focus view`}
        // backdrop styling lives in globals.css (.chart-focus-dialog::backdrop):
        // a blurred fade-in behind the morph, with an @starting-style entrance
        className="chart-focus-dialog m-auto w-[min(96vw,1100px)] rounded-(--radius-card) border border-line bg-surface-raised p-0 shadow-xl"
      >
        {open ? (
          <div className="p-5" style={open ? chartName : undefined}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                {label} — focus
              </h2>
              <button
                type="button"
                onClick={() => transition(() => setOpen(false))}
                aria-label="Close focus view"
                className="rounded-md p-1.5 text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
              >
                <Icon name="close" className="size-4" />
              </button>
            </div>
            {renderPanel({ heightClass: "h-[55vh]", activeRange: range, onRangeChange: selectRange })}
          </div>
        ) : null}
      </dialog>
    </>
  );
}

/**
 * The URL half of a range pill: mirrors the chosen range into `rangeParam` (see ChartFocus's
 * prop of that name), or does nothing without one.
 *
 * 🔴 It built the URL from the one the router last committed. A pill pressed while a view
 * press was in flight navigated without the view, and the view press, landing after, went to
 * a URL without the range. Both now build on the page's newest asked URL (lib/page-asks.ts),
 * and the pill's URL is asked for like a press's, so a press made after it keeps the range.
 */
export function useRangeParam(rangeParam: string | undefined): (range: ChartRange) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const asks = usePageAsks();
  const [, startUrlSync] = useTransition();
  return useCallback(
    (next: ChartRange) => {
      if (rangeParam === undefined) return;
      const asked = asks?.paramsOn(pathname) ?? null;
      const params = new URLSearchParams(asked ?? searchParams?.toString() ?? "");
      params.set(rangeParam, next);
      const href = `${pathname}?${params.toString()}`;
      asks?.ask(href, {});
      // `replace`, not `push`: a range pill is a lens on one page, not a place in
      // history — pushing would make Back walk every pill the user tried.
      // `scroll: false` keeps a mid-page chart under the cursor.
      startUrlSync(() => router.replace(href, { scroll: false }));
    },
    [rangeParam, router, pathname, searchParams, asks],
  );
}
