"use client";

import { spendingShare } from "@/lib/insight-facts";
import { useState } from "react";
import Link from "next/link";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import { SpendDelta } from "@/components/spending/SpendDelta";
import { formatCents } from "@/lib/money";

/** Qualitative confidence label + tone for a 0..1 score (mirrors PredictBudgets). */
function confidenceMeta(confidence: number): { label: string; tone: string } {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.75) return { label: `${pct}% confidence`, tone: "text-positive" };
  if (confidence >= 0.5) return { label: `${pct}% confidence`, tone: "text-ink-muted" };
  return { label: `${pct}% · low`, tone: "text-warning" };
}

/**
 * The Spending tab's categories table (ux-overhaul-plan §5.4): a CategoryChip,
 * a share-of-period bar, a MoM delta, and expandable parents whose subcategories
 * and whose row both link to the category page — the entity that closes the
 * chain (recurring series, budget, trend). Uncategorized/Excluded live in their
 * own honesty section, so they never appear here.
 */

export interface CategoryTableChild {
  categoryId: string;
  name: string;
  spentCents: number;
}

/** Next-month forecast for one category (the /budgets prediction engine). */
export interface CategoryForecastAnnotation {
  cents: number;
  /** 0..1 dollar-weighted confidence */
  confidence: number;
  /** visible-math basis string ("$X recurring + $Y trend …") — the tooltip */
  basis: string;
  /** whether the same-month-last-year blend actually moved the estimate */
  seasonal: boolean;
}

export interface CategoryTableRow {
  categoryId: string;
  name: string;
  hue: string | null;
  icon: string | null;
  spentCents: number;
  /** 0..100 share of the period's spending */
  sharePct: number;
  /** current period − previous period (positive = spending rose) */
  momDeltaCents: number;
  /** next-month predicted spend for this category, or null (no confident forecast) */
  forecast?: CategoryForecastAnnotation | null;
  children: CategoryTableChild[];
}

export function SpendingCategoriesTable({
  rows,
  showDelta = true,
  forecastMonthLabel = null,
  periodQuery,
}: {
  rows: CategoryTableRow[];
  /** the MoM column is only meaningful month-over-month; hidden for quarter/year */
  showDelta?: boolean;
  /** the target month for forecasts (e.g. "August 2026"); null hides the forecast line */
  forecastMonthLabel?: string | null;
  /**
   * ⛔ The window this card measured, as a query string. Without it a category
   * link lands on the CURRENT month — `resolvePeriod`'s fallback — so every row
   * of a July page opened a September page reading "$0.00 · 0 transactions".
   */
  periodQuery: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (rows.length === 0) return <p className="text-sm text-ink-muted">No spending in this period.</p>;

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => {
        const isOpen = expanded.has(row.categoryId);
        const hasChildren = row.children.length > 0;
        return (
          <li key={row.categoryId}>
            <div className="flex items-center gap-2 py-2.5">
              <button
                type="button"
                onClick={() => hasChildren && toggle(row.categoryId)}
                aria-expanded={hasChildren ? isOpen : undefined}
                aria-label={hasChildren ? `${isOpen ? "Collapse" : "Expand"} ${row.name} subcategories` : undefined}
                disabled={!hasChildren}
                className={`grid size-5 shrink-0 place-items-center rounded transition-colors duration-(--duration-fast) ${
                  hasChildren ? "text-ink-faint hover:bg-surface-sunken hover:text-ink" : "invisible"
                }`}
              >
                <Icon name="chevron-right" className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
              </button>

              <Link
                href={`/categories/${row.categoryId}?${periodQuery}`}
                className="flex min-w-0 flex-1 items-center gap-2.5 hover:underline"
              >
                <CategoryChip label={row.name} hue={row.hue} icon={row.icon} compact />
                <span className="truncate text-sm">{row.name}</span>
              </Link>

              <div aria-hidden className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-sunken sm:block">
                <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.min(100, row.sharePct)}%` }} />
              </div>
              {/* ⛔ a category that netted a refund took no share — it did not
                  take a zero one. `lib/insight-facts` carries the reason. */}
              <span
                className="w-10 shrink-0 text-right text-xs text-ink-faint tabular-nums"
                title={spendingShare(row.spentCents, row.sharePct).title ?? undefined}
              >
                {spendingShare(row.spentCents, row.sharePct).label}
              </span>
              {showDelta && (
                <span className="hidden w-20 shrink-0 text-right text-xs md:block">
                  <SpendDelta cents={row.momDeltaCents} />
                </span>
              )}
              <Money cents={row.spentCents} className="w-24 shrink-0 text-right text-sm font-medium" />
            </div>

            {/* forward-looking next-month forecast — a secondary line so it never
                competes with the actuals above; only on month view, only when
                confident. The basis rides in the title so no number is bare. */}
            {forecastMonthLabel && row.forecast && (
              <p
                className="-mt-1 mb-1.5 ml-7 flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-faint"
                title={row.forecast.basis}
              >
                <Icon name="sparkles" className="size-3 text-ink-faint" />
                <span>
                  {forecastMonthLabel} ≈{" "}
                  <span className="figures text-ink-muted">{formatCents(row.forecast.cents)}</span>
                </span>
                <span className={confidenceMeta(row.forecast.confidence).tone}>
                  · {confidenceMeta(row.forecast.confidence).label}
                </span>
                {row.forecast.seasonal && <span>· seasonally adjusted</span>}
                {/* the visible-math basis is a hover title AND read to screen
                    readers here — never a bare figure (category-forecast doctrine) */}
                <span className="sr-only">Basis: {row.forecast.basis}</span>
              </p>
            )}

            {isOpen && hasChildren && (
              <ul className="mb-1 ml-7 space-y-0.5 border-l border-line pl-3">
                {row.children.map((child) => (
                  <li key={child.categoryId}>
                    <Link
                      href={`/categories/${child.categoryId}?${periodQuery}`}
                      className="flex items-center justify-between gap-2 rounded py-1.5 pr-1 text-sm text-ink-muted hover:text-ink"
                    >
                      <span className="truncate">{child.name}</span>
                      <Money cents={child.spentCents} className="shrink-0 text-xs" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
