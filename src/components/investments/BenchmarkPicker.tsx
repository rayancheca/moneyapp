"use client";

import { useCallback, useState, useTransition } from "react";
import {
  BENCHMARK_PRESETS,
  NO_BENCHMARK,
  isBenchmarkOff,
  normalizeBenchmarkChoice,
  normalizeBenchmarkSymbol,
} from "@/lib/benchmark-symbol";
import { pressWriteLanding } from "@/lib/page-asks";
import { setBenchmarkAction } from "@/app/investments/actions";
import type { ActionResult } from "@/app/transactions/action-types";
import { settleAction } from "@/hooks/useAction";
import { usePageAsks } from "@/hooks/usePageAsks";

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
  /**
   * Navigate to the chart with the persisted symbol (keeping view dims + range in the URL).
   * 🔴 It was an href built from the view the server resolved, so a pick made while a view
   * press was in flight landed without that view: the panel's switcher builds it now, on the
   * page's newest asked URL.
   */
  onPicked: (symbol: string) => void;
  /** false when the active symbol has no cached closes — offers a fetch */
  hasData: boolean;
}

export interface BenchmarkPick {
  /** persist `symbol`, then go to the chart with it (`onPicked`); `onKept` runs as it goes */
  pick: (symbol: string, onKept?: () => void) => void;
  isPending: boolean;
  /** why the last pick was refused, or the picker's own reason; null when there is none */
  error: string | null;
  setError: (error: string | null) => void;
}

type Kept = ActionResult<{ symbol: string }>;

/**
 * A benchmark pick: its action persists the symbol (or refuses it, with the reason), then `onPicked` goes to the
 * chart with the symbol it kept.
 *
 * ⚖️ B2: Next queues the action behind a save of Back's view that is being written, so it waits on it no longer than
 * BACK_SAVE_WAIT_MS while that save hangs — the bound a view press has (`pressWriteLanding`). Cut short, it goes to
 * the symbol he picked, which its URL carries as a press's carries its view (through `onPicked`, a URL writer, which
 * waits on Back's saves its own BACK_SAVE_WAIT_MS), and again once the action answers: the symbol it kept, or why it
 * was refused. 🔴 Unbounded (review of ab13868, 2026-10-13), a pick made while Back's save hung was never drawn and
 * its picker stayed disabled — and, since it waits inside its transition, a link he followed next was never drawn
 * either (React holds every navigation until that transition settles). With nothing in flight, or once Back's saves
 * land in time, it waits on its action however long (a ticker's two years of closes are fetched first), as ever.
 */
export function useBenchmarkPick(onPicked: (symbol: string) => void): BenchmarkPick {
  const asks = usePageAsks();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(
    (symbol: string, onKept?: () => void): void => {
      setError(null);
      startTransition(async () => {
        const answer: { result?: Kept } = {};
        const kept = settleAction(() => setBenchmarkAction(symbol), "Couldn't set the benchmark").then((result) => {
          answer.result = result;
          return result;
        });
        const answered = (result: Kept): void => {
          if (!result.ok) {
            setError(result.error);
            return;
          }
          onKept?.();
          onPicked(result.data.symbol);
        };
        await (asks === null ? kept : pressWriteLanding(asks, kept, () => void kept.then(answered)));
        if (answer.result !== undefined) {
          answered(answer.result);
          return;
        }
        // cut short: the symbol he picked, as the action will read it — its answer follows once it lands
        const asked = normalizeBenchmarkChoice(symbol);
        if (asked === null) return;
        onKept?.();
        onPicked(asked);
      });
    },
    [asks, onPicked],
  );

  return { pick, isPending, error, setError };
}

export function BenchmarkPicker({ value, onPicked, hasData }: BenchmarkPickerProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState("");
  const { pick: pickSymbol, isPending, error, setError } = useBenchmarkPick(onPicked);
  const isPreset = BENCHMARK_PRESETS.some((p) => p.symbol === value);
  const isOff = isBenchmarkOff(value);

  function pick(symbol: string): void {
    pickSymbol(symbol, () => {
      setCustomOpen(false);
      setCustomText("");
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
