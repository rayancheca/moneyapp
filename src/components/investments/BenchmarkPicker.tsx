"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BENCHMARK_PRESETS, NO_BENCHMARK, isBenchmarkOff, normalizeBenchmarkSymbol } from "@/lib/benchmark-symbol";
import { setBenchmarkAction } from "@/app/investments/actions";

/**
 * The Return views' benchmark picker (Robinhood-parity item 4): the preset
 * indexes plus a custom-ticker input. Picking persists the choice (the action
 * backfills price history for a symbol the user doesn't hold and REJECTS
 * unpriceable tickers with the reason), then navigates so the RSC re-renders
 * the overlays — URL-shareable like every other view choice.
 */

const CUSTOM = "__custom";

interface BenchmarkPickerProps {
  /** the active benchmark symbol (resolved URL > persisted > SPY) */
  value: string;
  /** the target href for a chosen symbol (keeps view dims + range in the URL) */
  hrefFor: (symbol: string) => string;
  /** false when the active symbol has no cached closes — offers a fetch */
  hasData: boolean;
}

export function BenchmarkPicker({ value, hrefFor, hasData }: BenchmarkPickerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isPreset = BENCHMARK_PRESETS.some((p) => p.symbol === value);
  const isOff = isBenchmarkOff(value);

  function pick(symbol: string): void {
    setError(null);
    startTransition(async () => {
      const result = await setBenchmarkAction(symbol);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCustomOpen(false);
      setCustomText("");
      router.push(hrefFor(result.data.symbol), { scroll: false });
    });
  }

  function submitCustom(): void {
    const symbol = normalizeBenchmarkSymbol(customText);
    if (symbol === null) {
      setError("Symbols are 1–12 letters, digits, dots, or dashes");
      return;
    }
    pick(symbol);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {customOpen && (
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustom();
              if (e.key === "Escape") setCustomOpen(false);
            }}
            placeholder="Ticker…"
            aria-label="Custom benchmark symbol"
            disabled={isPending}
            autoFocus
            className="w-24 rounded-full border border-line bg-surface-raised px-2.5 py-1 text-xs figures uppercase placeholder:normal-case focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
          />
        )}
        <select
          value={customOpen ? CUSTOM : value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustomOpen(true);
              setError(null);
            } else {
              setCustomOpen(false);
              if (e.target.value !== value) pick(e.target.value);
            }
          }}
          disabled={isPending}
          aria-label="Benchmark"
          className="rounded-full bg-surface-sunken px-2.5 py-1 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
        >
          {/* First, and phrased as a state of the chart rather than an absence:
              this is "show me my own return", not "no option selected". Before it
              existed the resolver fell through to SPY and there was no way to see
              your line without a market line drawn over it. */}
          <option value={NO_BENCHMARK}>Just my return</option>
          {BENCHMARK_PRESETS.map((p) => (
            <option key={p.symbol} value={p.symbol}>
              vs {p.label}
            </option>
          ))}
          {!isPreset && !isOff && <option value={value}>vs {value}</option>}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-negative">
          {error}
        </p>
      )}
      {!hasData && !error && !isOff && (
        <p className="text-[11px] text-ink-faint">
          No price history for {value} yet —{" "}
          <button
            type="button"
            onClick={() => pick(value)}
            disabled={isPending}
            className="font-medium text-accent underline decoration-line underline-offset-2 transition-colors duration-(--duration-fast) hover:decoration-accent disabled:opacity-60"
          >
            {isPending ? "fetching…" : "fetch 2 years of closes"}
          </button>
        </p>
      )}
    </div>
  );
}
