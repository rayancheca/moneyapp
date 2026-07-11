"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shell/Icon";
import {
  stepPeriodParams,
  switchGranularityParams,
  type PeriodGranularity,
  type PeriodParams,
  type ResolvedPeriod,
} from "@/lib/period";

/**
 * The Spending tab's period control (ux-overhaul-plan §5.1): a month ⇄ quarter ⇄
 * year segmented switch, ‹ › paging, a "This month" reset, and a custom
 * from/to range — all URL state, so every view is shareable and the back button
 * works. Pure `@/lib/period` helpers build the hrefs client-side.
 */

const GRANULARITIES: { key: Exclude<PeriodGranularity, "custom">; label: string }[] = [
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
  /** monthKey of `today` — the "This month" target */
  todayMonthKey: string;
  /** where the period links point (default the Spending tab) */
  basePath?: string;
}

export function PeriodSelector({ period, todayMonthKey, basePath = "/spending" }: PeriodSelectorProps) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const href = (params: PeriodParams) => periodHref(basePath, params);

  const isThisMonth = period.granularity === "month" && period.key === todayMonthKey;

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

  function applyCustom(event: React.FormEvent) {
    event.preventDefault();
    if (from && to && from <= to) {
      setCustomOpen(false);
      router.push(href({ from, to }));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* granularity switch */}
      <nav aria-label="Period granularity" className="flex gap-1 rounded-full bg-surface-sunken p-1">
        {GRANULARITIES.map((g) => {
          const active = period.granularity === g.key;
          return (
            <Link
              key={g.key}
              href={href(switchGranularityParams(period, g.key))}
              aria-current={active ? "true" : undefined}
              className={`rounded-full px-3 py-1 text-xs transition-colors duration-(--duration-fast) ${
                active ? "bg-surface-raised font-medium shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              {g.label}
            </Link>
          );
        })}
      </nav>

      {/* pager */}
      <div className="flex items-center gap-1">
        <Link
          href={href(stepPeriodParams(period, -1))}
          aria-label="Previous period"
          className="grid size-8 place-items-center rounded-full text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
        >
          <Icon name="chevron-left" className="size-4" />
        </Link>
        <span className="min-w-[8ch] text-center text-sm font-medium tabular-nums" aria-live="polite">
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

      {!isThisMonth && (
        <Link
          href={href({ period: todayMonthKey })}
          className="rounded-full px-2.5 py-1 text-xs text-accent transition-colors duration-(--duration-fast) hover:bg-accent-soft"
        >
          This month
        </Link>
      )}

      {/* custom range */}
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
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
                  onChange={(e) => setFrom(e.target.value)}
                  className="mt-0.5 w-full rounded-md border border-line bg-surface-raised px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-xs text-ink-muted">
                To
                <input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                  className="mt-0.5 w-full rounded-md border border-line bg-surface-raised px-2 py-1 text-sm"
                />
              </label>
              <button
                type="submit"
                className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-raised transition-opacity hover:opacity-90"
              >
                Apply range
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
