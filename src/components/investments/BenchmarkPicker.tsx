"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BENCHMARK_PRESETS, NO_BENCHMARK, isBenchmarkOff, normalizeBenchmarkSymbol } from "@/lib/benchmark-symbol";
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
 * chart with the symbol it kept — never before: the action fetches a ticker's two years of closes first, and refuses
 * one it cannot price.
 *
 * ⚖️ B2: Next queues the action behind a save of Back's view that is being written, so it waits on it no longer than
 * BACK_SAVE_WAIT_MS while that save hangs — the bound a view press has (`pressWriteLanding`) — and is drawn once the
 * action answers (`again`). 🔴 Unbounded (review of ab13868, 2026-10-13), since it waits inside its transition, a link
 * he followed next was never drawn (React holds every navigation until that transition settles). Until it answers the
 * picker reads "fetching…": the router's state waits on its action, as it does on a press's write. 🔴 Cut short, it
 * went to the symbol he picked before its action answered (0acc9b5): refused, the URL, select and chart stayed on ZZZZ
 * beside "No price history found for ZZZZ", and his typed text was gone (review of 10852ef, 2026-10-14). A refused pick
 * changes nothing on the page but its alert.
 *
 * ⚖️ Owner 2026-10-05: answered after he left by a link or by Back, it builds no URL on the page he left
 * (`movedSince`). 🔴 It asked for a URL anew whenever it answered — always the newest, past every guard — and went
 * there: QQQ, the sidebar's /budgets, and once Back's save landed he was back on /investments?range=1Y&bench=QQQ
 * (review of 10852ef; the pick before 0acc9b5 did it too). After a link the page he is on is drawn again, where he is —
 * drawn before the symbol was kept, it read the one before (PageAsksProvider redraws a link's page for Back's saves
 * the same way); after Back, nothing: Back shows the page he went back to.
 */
export function useBenchmarkPick(onPicked: (symbol: string) => void): BenchmarkPick {
  const router = useRouter();
  const asks = usePageAsks();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(
    (symbol: string, onKept?: () => void): void => {
      setError(null);
      const mark = asks?.moveMark() ?? 0;
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
          const moved = asks?.movedSince(mark) ?? null;
          if (moved === null) onPicked(result.data.symbol);
          else if (moved === "link") router.refresh();
        };
        await (asks === null ? kept : pressWriteLanding(asks, kept, () => void kept.then(answered)));
        // cut short: nothing is drawn before the action has kept the symbol — `again` goes once it answers
        if (answer.result !== undefined) answered(answer.result);
      });
    },
    [asks, onPicked, router],
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
