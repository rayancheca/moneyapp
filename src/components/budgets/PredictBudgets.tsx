"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPredictedBudgetsAction, predictBudgetsAction } from "@/app/budgets/actions";
import { Icon } from "@/components/shell/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import type { PredictedBudget } from "@/services/category-forecast";

/**
 * "Predict budgets" (user ask: "actual predictions · real budgets"). Loads a
 * genuine FORECAST of next month's spend per category — the category's own
 * recurring bills plus a trend/seasonality-adjusted discretionary estimate, NOT
 * a flat average of the past — into a review sheet. Nothing is created until the
 * user confirms the checked set; every row shows its split (recurring vs
 * estimated), its confidence, and names its basis, so no predicted number is ever
 * a bare figure.
 */
export function PredictBudgets() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [predictions, setPredictions] = useState<PredictedBudget[] | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  function load(): void {
    startTransition(async () => {
      const result = await predictBudgetsAction();
      if (!result.ok) {
        toast({ title: result.error, tone: "negative" });
        return;
      }
      setPredictions(result.data);
      // pre-check ONLY the predictions we have any confidence in; a 0%-confidence
      // guess stays opt-in (never seed a budget from it by default). If none clear
      // the bar, nothing is pre-checked — the honest state (the rows stay visible
      // and individually checkable; the Create button is disabled until you pick).
      setChecked(new Set(result.data.filter((p) => p.forecast.confidence > 0).map((p) => p.categoryId)));
      setOpen(true);
    });
  }

  function toggle(categoryId: string): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  function createChecked(): void {
    const picked = (predictions ?? []).filter((p) => checked.has(p.categoryId));
    if (picked.length === 0) return;
    startTransition(async () => {
      const result = await createPredictedBudgetsAction(
        picked.map((p) => ({ categoryId: p.categoryId, amountCents: p.amountCents })),
      );
      if (!result.ok) {
        toast({ title: result.error, tone: "negative" });
        return;
      }
      const { created, errors } = result.data;
      toast({
        title: `Created ${created} monthly budget${created === 1 ? "" : "s"}${
          errors.length > 0 ? ` — ${errors.length} failed` : ""
        }`,
        tone: errors.length > 0 ? "negative" : "positive",
      });
      setOpen(false);
      router.refresh();
    });
  }

  const periodLabel = predictions?.[0]?.periodLabel ?? "next month";

  return (
    <>
      <button
        type="button"
        onClick={load}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink disabled:opacity-60"
      >
        <Icon name="sparkles" className="size-3.5" />
        {isPending && !open ? "Forecasting…" : "Predict budgets"}
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Predicted budgets"
        footer={
          predictions !== null && predictions.length > 0 ? (
            <button
              type="button"
              onClick={createChecked}
              disabled={isPending || checked.size === 0}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-surface-raised transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {isPending
                ? "Creating…"
                : `Create ${checked.size} monthly budget${checked.size === 1 ? "" : "s"}`}
            </button>
          ) : undefined
        }
      >
        {predictions === null || predictions.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing to predict — every category with a forecast already has a budget, or there
            isn&rsquo;t enough history yet to project {periodLabel}.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-ink-muted">
              Each amount is a forecast of your {periodLabel}{" "}spending — your recurring bills plus
              a trend-adjusted estimate of the rest — rounded up to the nearest $10. Uncheck what you
              don&rsquo;t want.
            </p>
            <ul className="divide-y divide-line">
              {predictions.map((p) => (
                <PredictionRow
                  key={p.categoryId}
                  prediction={p}
                  checked={checked.has(p.categoryId)}
                  onToggle={() => toggle(p.categoryId)}
                />
              ))}
            </ul>
          </div>
        )}
      </Sheet>
    </>
  );
}

/** Qualitative confidence label + tone for a 0..1 score. */
function confidenceMeta(confidence: number): { label: string; tone: string } {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.75) return { label: `${pct}% confidence`, tone: "text-positive" };
  if (confidence >= 0.5) return { label: `${pct}% confidence`, tone: "text-ink-muted" };
  return { label: `${pct}% confidence · low`, tone: "text-warning" };
}

function PredictionRow({
  prediction: p,
  checked,
  onToggle,
}: {
  prediction: PredictedBudget;
  checked: boolean;
  onToggle: () => void;
}) {
  const { forecast } = p;
  const conf = confidenceMeta(forecast.confidence);
  // the split line: recurring bills (evidenced) vs the estimated remainder
  const split =
    forecast.recurringCents > 0
      ? `${formatCents(forecast.recurringCents)} recurring + ${formatCents(forecast.discretionaryCents)} estimated`
      : `${formatCents(forecast.discretionaryCents)} estimated`;

  return (
    <li className="py-2.5">
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="flex min-w-0 items-start gap-2.5">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="mt-0.5 size-4 shrink-0 accent-(--accent)"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{p.label}</span>
            {/* visible math: the predicted total, its split, and its confidence.
                `title` carries the full basis so no number is ever a bare figure. */}
            <span className="block text-[11px] text-ink-faint" title={forecast.basis}>
              predicts {formatCents(forecast.expectedTotalCents)} for {p.periodLabel}
              {p.seasonalApplied ? " · seasonally adjusted" : ""}
            </span>
            <span className="block text-[11px]">
              <span className="text-ink-faint">{split}</span>{" "}
              <span className={conf.tone}>· {conf.label}</span>
            </span>
          </span>
        </span>
        <span className="figures shrink-0 text-sm">{formatCents(p.amountCents)}</span>
      </label>
    </li>
  );
}
