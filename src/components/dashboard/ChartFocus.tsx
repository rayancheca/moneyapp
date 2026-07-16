"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Icon } from "@/components/shell/Icon";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { ChartRange } from "@/lib/chart-range";
import type { NetWorthPoint } from "@/services/derivation";
import { NetWorthChartPanel } from "./NetWorthChartPanel";

/**
 * Chart focus mode (S8, Track 2): the net-worth chart expands into a
 * full-width modal for close inspection. One component owns BOTH renders so
 * the `view-transition-name` can hop from the inline card to the dialog —
 * document.startViewTransition then morphs the shared element (progressive:
 * plain open/close where unsupported, and under prefers-reduced-motion the
 * transition is skipped entirely). The dialog is a native <dialog> — free
 * focus trap, Escape, and focus return, same doctrine as Sheet.tsx. Both
 * instances share the dashboard window context, and the range pill is lifted
 * here too — the modal opens on the pill the user was inspecting, and a pill
 * change made in focus mode is still there when the modal closes.
 */
export function ChartFocus({ points, today }: { points: readonly NetWorthPoint[]; today: string }) {
  const [open, setOpen] = useState(false);
  // one range for both instances ("the same chart, bigger") — matches the
  // panel's defaultRange so the closed state renders exactly as before
  const [range, setRange] = useState<ChartRange>("1Y");
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
      <SurfaceCard className="relative mt-4" style={open ? undefined : chartName}>
        <button
          type="button"
          onClick={() => transition(() => setOpen(true))}
          aria-label="Focus the net worth chart"
          className="absolute top-3 right-3 z-10 rounded-md p-1.5 text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
        >
          <Icon name="arrow-up-right" className="size-4" />
        </button>
        <NetWorthChartPanel points={points} today={today} activeRange={range} onRangeChange={setRange} />
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
        aria-label="Net worth chart — focus view"
        // backdrop styling lives in globals.css (.chart-focus-dialog::backdrop):
        // a blurred fade-in behind the morph, with an @starting-style entrance
        className="chart-focus-dialog m-auto w-[min(96vw,1100px)] rounded-(--radius-card) border border-line bg-surface-raised p-0 shadow-xl"
      >
        {open ? (
          <div className="p-5" style={open ? chartName : undefined}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                Net worth — focus
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
            <NetWorthChartPanel
              points={points}
              today={today}
              heightClass="h-[55vh]"
              activeRange={range}
              onRangeChange={setRange}
            />
          </div>
        ) : null}
      </dialog>
    </>
  );
}
