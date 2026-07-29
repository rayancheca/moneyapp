"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shell/Icon";
import {
  currentPeriodLabel,
  currentPeriodParams,
  stepPeriodParams,
  switchGranularityParams,
  type PeriodGranularity,
  type PeriodParams,
  type ResolvedPeriod,
} from "@/lib/period";

/**
 * The Spending tab's period control (ux-overhaul-plan §5.1): a day ⇄ week ⇄
 * month ⇄ quarter ⇄ year segmented switch, ‹ › paging, a contextual reset
 * ("Today" / "This week" / …), and a custom from/to range — all URL state, so
 * every view is shareable and the back button works. Pure `@/lib/period`
 * helpers build the hrefs client-side. The bar spans its container: switch
 * left, pager center, reset + custom right.
 */

const GRANULARITIES: { key: Exclude<PeriodGranularity, "custom">; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
];

function periodHref(basePath: string, params: PeriodParams): string {
  const sp = new URLSearchParams();
  if (params.period) sp.set("period", params.period);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  return `${basePath}?${sp.toString()}`;
}

interface PeriodSelectorProps {
  period: ResolvedPeriod;
  /** today's full ISO date — the contextual reset anchors on it */
  today: string;
  /** where the period links point (default the Spending tab) */
  basePath?: string;
}

export function PeriodSelector({ period, today, basePath = "/spending" }: PeriodSelectorProps) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  // why the last Apply did nothing — the button must never be a silent no-op
  const [rangeError, setRangeError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const href = (params: PeriodParams) => periodHref(basePath, params);

  // the reset targets TODAY's period at the ACTIVE granularity (custom → month);
  // hidden while already looking at it
  const resetGranularity = period.granularity === "custom" ? "month" : period.granularity;
  const isOnCurrent = period.granularity !== "custom" && period.isCurrent;

  // Dismiss the custom-range panel on Escape (from anywhere) or a click outside
  // it — the expected disclosure affordance regardless of where focus sits.
  useEffect(() => {
    if (!customOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setCustomOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setCustomOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [customOpen]);

  // Apply either navigates or says why it didn't. Silently returning left the
  // primary-styled button looking live while nothing happened.
  function applyCustom(event: React.FormEvent) {
    event.preventDefault();
    if (!from || !to) {
      setRangeError("Pick both a from and a to date.");
      return;
    }
    // ISO dates compare correctly as strings
    if (from > to) {
      setRangeError("The from date must be on or before the to date.");
      return;
    }
    setRangeError(null);
    setCustomOpen(false);
    router.push(href({ from, to }));
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {/* granularity switch */}
      {/* `flex-wrap` for the same reason ViewSwitcher carries it: a
          non-wrapping flex row cannot be narrower than the sum of its children,
          so these five pills held a 318px min-content against 288px of page at
          320 and pushed /spending 14px sideways. Wrapping drops the minimum to
          the widest single pill. No effect at any width where the row fits. */}
      <nav aria-label="Period granularity" className="flex flex-wrap gap-1 rounded-full bg-surface-sunken p-1">
        {GRANULARITIES.map((g) => {
          const active = period.granularity === g.key;
          return (
            <Link
              key={g.key}
              href={href(switchGranularityParams(period, g.key))}
              aria-current={active ? "true" : undefined}
              className={`rounded-full px-3.5 py-1.5 text-xs transition-colors duration-(--duration-fast) ${
                active ? "bg-surface-raised font-medium shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              {g.label}
            </Link>
          );
        })}
      </nav>

      {/* pager — centered in the remaining space */}
      <div className="order-last flex w-full items-center justify-center gap-1 sm:order-none sm:w-auto sm:flex-1">
        <Link
          href={href(stepPeriodParams(period, -1))}
          aria-label="Previous period"
          className="grid size-8 place-items-center rounded-full text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
        >
          <Icon name="chevron-left" className="size-4" />
        </Link>
        <span className="min-w-[12ch] text-center text-sm font-medium tabular-nums" aria-live="polite">
          {period.label}
        </span>
        <Link
          href={href(stepPeriodParams(period, 1))}
          aria-label="Next period"
          className="grid size-8 place-items-center rounded-full text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
        >
          <Icon name="chevron-right" className="size-4" />
        </Link>
      </div>

      <div className="flex items-center gap-2">
        {!isOnCurrent && (
          <Link
            href={href(currentPeriodParams(resetGranularity, today))}
            className="rounded-full px-2.5 py-1 text-xs text-accent transition-colors duration-(--duration-fast) hover:bg-accent-soft"
          >
            {currentPeriodLabel(resetGranularity)}
          </Link>
        )}

        {/* custom range */}
        <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setRangeError(null); // a reopened panel starts clean
            setCustomOpen((v) => !v);
          }}
          aria-expanded={customOpen}
          aria-controls="custom-range-panel"
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors duration-(--duration-fast) ${
            period.granularity === "custom"
              ? "bg-accent-soft font-medium text-accent"
              : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
          }`}
        >
          <Icon name="chevron-down" className="size-3" />
          Custom
        </button>
        {customOpen && (
          <div
            id="custom-range-panel"
            ref={panelRef}
            role="group"
            aria-label="Custom date range"
            onKeyDown={(e) => e.key === "Escape" && setCustomOpen(false)}
            className="absolute right-0 top-full z-20 mt-2 w-64 rounded-(--radius-overlay) border border-line bg-surface-overlay p-3 shadow-(--shadow-overlay)"
          >
            <form onSubmit={applyCustom} className="space-y-2">
              <label className="block text-xs text-ink-muted">
                From
                <input
                  type="date"
                  value={from}
                  max={to}
                  aria-invalid={rangeError ? true : undefined}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setRangeError(null);
                  }}
                  className="mt-0.5 w-full rounded-md border border-line bg-surface-raised px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-xs text-ink-muted">
                To
                <input
                  type="date"
                  value={to}
                  min={from}
                  aria-invalid={rangeError ? true : undefined}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setRangeError(null);
                  }}
                  className="mt-0.5 w-full rounded-md border border-line bg-surface-raised px-2 py-1 text-sm"
                />
              </label>
              {rangeError ? (
                <p id="custom-range-error" role="alert" className="text-xs text-negative">
                  {rangeError}
                </p>
              ) : null}
              <button
                type="submit"
                aria-describedby={rangeError ? "custom-range-error" : undefined}
                className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-raised transition-opacity hover:opacity-90"
              >
                Apply range
              </button>
            </form>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
