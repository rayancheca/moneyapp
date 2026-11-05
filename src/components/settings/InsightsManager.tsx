"use client";

import { useState, useTransition } from "react";
import {
  clearInsightSelectionsAction,
  runInsightSelectionAction,
  stopInsightSelectionAction,
  updateInsightSettingsAction,
} from "@/app/settings/actions";
import { RefusalShownField } from "@/components/ui/ErrorBanner";
import { settleAction } from "@/hooks/useAction";
import { formatIsoInstantLong } from "@/lib/format-instant";
import type { InsightSelectRunResult } from "@/services/insight-selection";
import { INSIGHT_SURFACES } from "@/lib/insight-surfaces";

export interface InsightsManagerProps {
  enabled: boolean;
  modelEnabled: boolean;
  /** surface id → on. Absent means on. */
  surfaces: Record<string, boolean>;
  storedOrders: number;
  hasApiKey: boolean;
  overCap: boolean;
  lastRun: (InsightSelectRunResult & { at: string }) | null;
  isRunning: boolean;
  estPerPoolUsd: number;
  /**
   * The refusal the page shows (`?error=`), or null: while one shows, its form's save, landing, takes it away
   * (`RefusalShownField`, `landBack`). It imports its actions, as every client file does, so each press is read where
   * it is made (useAction.test.ts).
   */
  refusal: string | null;
}

/**
 * PASS 72d — the two switches, and the one button that spends money.
 *
 * ⛔ The wording of this panel is the feature's honesty test. "Off" here is not
 * a reduced app: every figure keeps its provenance badge and every chart keeps
 * its numbers, and the only thing that goes is prose the app wrote about
 * itself. And the model's switch is separate from the insights' switch, because
 * they are different decisions — one is about reading, the other is about
 * paying.
 */
export function InsightsManager(props: InsightsManagerProps) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const renderedSurfaces = INSIGHT_SURFACES.map((s) => s.id).join(",");

  /* Each press settles its call (`settleAction`), so one that never reached the server says what it threw on the note
     line. 🔴 Review of 7b7443b2 (2026-11-05): they awaited it with no catch inside this transition, and React chains an
     async transition's rejection into its pending state, thrown on the next render to the page's error boundary
     (react-dom's `startTransition`, read 2026-11-05) — "Settings didn't load." for a press the server never saw. */
  const act = (fn: () => Promise<string | null>): void => {
    startTransition(async () => {
      setNote(await fn());
    });
  };

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-medium">Insights</h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          Sentences the app writes about your own ledger, each from a closed vocabulary and each
          standing on a proof. Turning them off removes the prose and nothing else — every figure
          keeps its badge and every chart keeps its numbers.
        </p>
      </div>

      <form action={updateInsightSettingsAction} className="space-y-3">
        <RefusalShownField error={props.refusal} />
        <input type="hidden" name="renderedSurfaces" value={renderedSurfaces} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="insightsEnabled" defaultChecked={props.enabled} className="size-4" />
          <span>Write insights</span>
        </label>

        <fieldset className="ml-6 space-y-1.5">
          <legend className="mb-1 text-xs text-ink-faint">Where</legend>
          {INSIGHT_SURFACES.map((surface) => (
            <label key={surface.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={`surface:${surface.id}`}
                defaultChecked={props.surfaces[surface.id] !== false}
                className="size-4"
              />
              <span>{surface.label}</span>
              <span className="text-xs text-ink-faint">{surface.where}</span>
            </label>
          ))}
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="insightModelEnabled"
            defaultChecked={props.modelEnabled}
            className="mt-0.5 size-4"
          />
          <span>
            Let Claude choose the order
            <span className="mt-0.5 block text-xs text-ink-muted">
              It never writes a word: it is shown the sentences this app already wrote and returns
              them in a different order. Turning it off forgets every order it has chosen.
            </span>
          </span>
        </label>

        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
        >
          Save insight settings
        </button>
      </form>

      <div className="mt-4 border-t border-hairline pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || props.isRunning || !props.modelEnabled || !props.hasApiKey || props.overCap}
            onClick={() =>
              act(async () => {
                const result = await settleAction(() => runInsightSelectionAction());
                if (!result.ok) return result.error;
                if (!result.data.ran) return "Nothing to order.";
                return `${result.data.selected} ordered, ${result.data.cached} already known · $${result.data.estCostUsd.toFixed(4)}`;
              })
            }
            className="rounded-md border border-hairline px-3 py-1.5 text-sm transition-opacity duration-(--duration-fast) hover:opacity-80 disabled:opacity-40"
          >
            {props.isRunning ? "Ordering…" : "Order insights now"}
          </button>
          {props.isRunning && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                act(async () => {
                  const result = await settleAction(() => stopInsightSelectionAction());
                  return result.ok ? "Stop requested." : result.error;
                })
              }
              className="rounded-md border border-hairline px-3 py-1.5 text-sm"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            disabled={pending || props.storedOrders === 0}
            onClick={() =>
              act(async () => {
                const result = await settleAction(() => clearInsightSelectionsAction());
                if (!result.ok) return result.error;
                return `${result.data.removed} forgotten — every page is back to the app's own order.`;
              })
            }
            className="rounded-md border border-hairline px-3 py-1.5 text-sm transition-opacity duration-(--duration-fast) hover:opacity-80 disabled:opacity-40"
          >
            Forget stored orders
          </button>
        </div>

        <p className="mt-2 text-xs text-ink-muted">
          {props.storedOrders === 0
            ? "No stored orders — every page is in the order the app chose."
            : `${props.storedOrders} stored ${props.storedOrders === 1 ? "order" : "orders"}. Each is keyed to the exact figures it was chosen over, so a page that changes asks again and one that has not costs nothing.`}
          {" "}
          About ${props.estPerPoolUsd.toFixed(4)} per page.
        </p>
        {!props.hasApiKey && (
          <p className="mt-1 text-xs text-warning">
            No ANTHROPIC_API_KEY — insights still work; nothing reorders them.
          </p>
        )}
        {props.lastRun && (
          <p className="mt-1 text-xs text-ink-faint">
            {/* ⛔ `at` is `new Date().toISOString()` — UTC. Slicing it printed the
                UTC DATE, which is the wrong day either side of midnight, and a
                machine value in a sentence. The same defect the /transactions
                header carried; `lib/format-instant` is the rule for both. */}
            Last run {formatIsoInstantLong(props.lastRun.at)}
            {props.lastRun.failed
              ? ` — failed: ${props.lastRun.error ?? "unknown error"}`
              : props.lastRun.stopped
                ? " — stopped part way"
                : props.lastRun.capReached
                  ? " — stopped at the monthly cap"
                  : ` — ${props.lastRun.selected} ordered`}
          </p>
        )}
        {note && (
          <p className="mt-1 text-xs text-ink" role="status">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
